import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import RummyRepo from "./rummy.repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function mockCore(dbOverride = null) {
	const listeners = new Map();
	return {
		db: dbOverride,
		hooks: {
			hedberg: { match: (pattern, str) => pattern === str },
			tools: {
				views: [],
				onView(scheme, fn, visibility) {
					this.views.push({ scheme, fn, visibility });
				},
			},
		},
		registerScheme() {
			// No-op for plugin-level tests; real PluginContext records to
			// internal schemes array. Mock just exposes the entry point so
			// the constructor doesn't throw.
		},
		on(event, fn) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(fn);
		},
		emit(event, payload) {
			const fns = listeners.get(event) || [];
			return Promise.all(fns.map((fn) => fn(payload)));
		},
	};
}

function mockStore() {
	const entries = new Map();
	return {
		async set(args) {
			const key = `${args.runId}:${args.path}`;
			const prev = entries.get(key) || {};
			const attrs = {
				...(prev.attributes || {}),
				...(args.attributes || {}),
			};
			entries.set(key, {
				path: args.path,
				body: args.body ?? prev.body,
				state: args.state ?? prev.state,
				visibility: args.visibility ?? prev.visibility,
				attributes: attrs,
				hash: attrs.hash ?? prev.hash,
				updated_at: attrs.updatedAt ?? prev.updated_at,
			});
		},
		async rm({ runId, path }) {
			entries.delete(`${runId}:${path}`);
		},
		async getFileEntries(runId) {
			const result = [];
			for (const [key, val] of entries) {
				if (key.startsWith(`${runId}:`)) result.push(val);
			}
			return result;
		},
		async getBody(runId, path) {
			return entries.get(`${runId}:${path}`)?.body ?? null;
		},
		entries,
	};
}

function mockDb() {
	return {
		get_active_runs: { all: async () => [{ id: 1 }] },
		get_file_constraints: { all: async () => [] },
		get_entry_state: { get: async () => null },
	};
}

describe("RummyRepo", () => {
	it("registers the repo scheme", () => {
		const schemes = [];
		const core = mockCore();
		core.registerScheme = (s) => schemes.push(s);
		new RummyRepo(core);
		assert.ok(schemes.some((s) => s.name === "repo" && s.category === "data"));
	});

	it("registers a summarized view for the file scheme", () => {
		const core = mockCore();
		new RummyRepo(core);
		const view = core.hooks.tools.views.find(
			(v) => v.scheme === "file" && v.visibility === "summarized",
		);
		assert.ok(view);
		assert.equal(view.fn({ attributes: { symbols: "sym" } }), "sym");
		assert.equal(view.fn({ attributes: '{"symbols":"parsed"}' }), "parsed");
		assert.equal(view.fn({ attributes: {} }), "");
	});

	it("registers visible and summarized views for the repo scheme", () => {
		const core = mockCore();
		new RummyRepo(core);
		const visible = core.hooks.tools.views.find(
			(v) => v.scheme === "repo" && v.visibility === "visible",
		);
		const summarized = core.hooks.tools.views.find(
			(v) => v.scheme === "repo" && v.visibility === "summarized",
		);
		assert.ok(visible);
		assert.ok(summarized);
		assert.equal(visible.fn({ body: "full content" }), "full content");
	});

	it("truncates repo summarized view to 12 lines", () => {
		const core = mockCore();
		new RummyRepo(core);
		const summarized = core.hooks.tools.views.find(
			(v) => v.scheme === "repo" && v.visibility === "summarized",
		);
		const longBody = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
			"\n",
		);
		const result = summarized.fn({ body: longBody });
		const lines = result.split("\n");
		assert.equal(lines.length, 13); // 12 + truncation notice
		assert.ok(result.includes("[truncated"));
	});

	it("does not truncate short repo body", () => {
		const core = mockCore();
		new RummyRepo(core);
		const summarized = core.hooks.tools.views.find(
			(v) => v.scheme === "repo" && v.visibility === "summarized",
		);
		const shortBody = "line 1\nline 2";
		assert.equal(summarized.fn({ body: shortBody }), shortBody);
	});

	it("registers turn.started listener on construction", () => {
		const core = mockCore();
		new RummyRepo(core);
		assert.ok(core.emit("turn.started", { rummy: { noRepo: true } }));
	});

	it("skips turn.started when noRepo is true", async () => {
		const core = mockCore();
		new RummyRepo(core);
		await core.emit("turn.started", { rummy: { noRepo: true } });
	});

	it("skips turn.started when project has no root", async () => {
		const core = mockCore();
		new RummyRepo(core);
		await core.emit("turn.started", {
			rummy: { noRepo: false, project: {} },
		});
	});

	describe("turn.started file scanning", () => {
		let tmpDir;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rummy-repo-turn-"));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("scans project files on turn.started", async () => {
			writeFileSync(join(tmpDir, "app.js"), "const app = true;");

			const git = await import("isomorphic-git");
			const fs = await import("node:fs");
			await git.init({ fs, dir: tmpDir });
			await git.add({ fs, dir: tmpDir, filepath: "app.js" });
			await git.commit({
				fs,
				dir: tmpDir,
				message: "init",
				author: { name: "test", email: "test@test.com" },
			});

			const db = mockDb();
			const core = mockCore(db);
			const store = mockStore();

			const rummy = {
				noRepo: false,
				project: { project_root: tmpDir, id: 1 },
				sequence: 1,
				entries: store,
				db,
			};

			new RummyRepo(core);
			await core.emit("turn.started", { rummy });

			assert.ok(store.entries.size > 0);
			const appEntry = store.entries.get("1:app.js");
			assert.ok(appEntry);
			assert.equal(appEntry.state, "resolved");
		});

		it("attaches symbols inline on scanned JS files", async () => {
			const body = `export default function formatSymbols() { return 0; }`;
			writeFileSync(join(tmpDir, "formatSymbols.js"), body);

			const git = await import("isomorphic-git");
			const fs = await import("node:fs");
			await git.init({ fs, dir: tmpDir });
			await git.add({ fs, dir: tmpDir, filepath: "formatSymbols.js" });
			await git.commit({
				fs,
				dir: tmpDir,
				message: "init",
				author: { name: "test", email: "test@test.com" },
			});

			const db = mockDb();
			const core = mockCore(db);
			const store = mockStore();
			const rummy = {
				noRepo: false,
				project: { project_root: tmpDir, id: 1 },
				sequence: 1,
				entries: store,
				db,
			};

			new RummyRepo(core);
			await core.emit("turn.started", { rummy });

			const entry = store.entries.get("1:formatSymbols.js");
			assert.ok(entry);
			assert.ok(entry.attributes.symbols?.includes("formatSymbols"));
		});
	});
});
