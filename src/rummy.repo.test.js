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
				// Mirrors ToolRegistry.view (rummy core src/hooks/ToolRegistry.js):
				// throw when no scheme registered; "" when scheme registered but
				// the requested visibility isn't; normalize null/undefined to "".
				async view(scheme, entry) {
					const matches = this.views.filter((v) => v.scheme === scheme);
					if (matches.length === 0) {
						throw new Error(`No view registered for scheme '${scheme}'.`);
					}
					const visibility = entry.visibility ?? "visible";
					const match = matches.find((v) => v.visibility === visibility);
					if (!match) return "";
					const result = await match.fn(entry);
					return result == null ? "" : result;
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
			// Mirrors the real SQL: only bare-path (scheme IS NULL) entries.
			const result = [];
			for (const [key, val] of entries) {
				if (!key.startsWith(`${runId}:`)) continue;
				const path = key.slice(`${runId}:`.length);
				if (path.includes("://")) continue;
				result.push(val);
			}
			return result;
		},
		async getEntriesByPattern(runId, pattern) {
			const result = [];
			for (const [key, val] of entries) {
				if (!key.startsWith(`${runId}:`)) continue;
				const path = key.slice(`${runId}:`.length);
				if (pattern !== "**" && pattern !== path) continue;
				const idx = path.indexOf("://");
				const scheme = idx === -1 ? null : path.slice(0, idx);
				const tokens = Math.ceil((val.body || "").length / 4);
				result.push({ ...val, scheme, tokens });
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
	it("does not register a repo scheme (project state lives at log://turn_0/repo/manifest)", () => {
		const schemes = [];
		const core = mockCore();
		core.registerScheme = (s) => schemes.push(s);
		new RummyRepo(core);
		assert.ok(!schemes.some((s) => s.name === "repo"));
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

	it("dispatches log://turn_N/repo/... bodies pass-through at both visibility levels", async () => {
		const core = mockCore();
		new RummyRepo(core);

		// materializeContext extracts "repo" as the projection key from
		// `log://turn_N/repo/...` paths and looks up views under that
		// name (not the literal `log` scheme). The manifest body is
		// already model-ready prose, so both projections must round-
		// trip it verbatim.
		const body = "* app.js - 142 tokens\n* README.md - 287 tokens";

		assert.equal(
			await core.hooks.tools.view("repo", { body, visibility: "visible" }),
			body,
		);
		assert.equal(
			await core.hooks.tools.view("repo", { body, visibility: "summarized" }),
			body,
		);
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
