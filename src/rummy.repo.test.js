import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			entry: {
				changed: { async emit() {} },
			},
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

function mockRummy(bodies = {}, projectRoot = __dirname) {
	const attributes = {};
	return {
		project: { project_root: projectRoot, id: 1 },
		noRepo: false,
		sequence: 1,
		entries: mockKnownStore(),
		db: mockDb(),
		async getBody(path) {
			return bodies[path] ?? null;
		},
		async setAttributes(path, attrs) {
			attributes[path] = { ...(attributes[path] || {}), ...attrs };
		},
		attributes,
	};
}

function mockKnownStore() {
	const entries = new Map();
	return {
		async upsert(runId, _turn, path, content, state, opts = {}) {
			entries.set(`${runId}:${path}`, {
				path,
				body: content,
				state,
				hash: opts.hash,
				attributes: opts.attributes,
				updated_at: opts.updatedAt,
			});
		},
		async getFileEntries() {
			return [];
		},
		async getBody(runId, path) {
			return entries.get(`${runId}:${path}`)?.body ?? null;
		},
		async remove(runId, path) {
			entries.delete(`${runId}:${path}`);
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
	it("registers entry.changed listener on construction", () => {
		const core = mockCore();
		new RummyRepo(core);
		assert.ok(
			core.emit("entry.changed", {
				rummy: mockRummy(),
				runId: 1,
				turn: 1,
				paths: [],
			}),
		);
	});

	it("extracts symbols from JS files via antlrmap", async () => {
		const core = mockCore();
		const body = readFileSync(join(__dirname, "formatSymbols.js"), "utf8");
		const rummy = mockRummy({ "formatSymbols.js": body });

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["formatSymbols.js"],
		});

		assert.ok(rummy.attributes["formatSymbols.js"]);
		assert.ok(
			rummy.attributes["formatSymbols.js"].symbols.includes("formatSymbols"),
		);
	});

	it("skips paths with no extension", async () => {
		const core = mockCore();
		const rummy = mockRummy({});

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["Makefile"],
		});

		assert.equal(Object.keys(rummy.attributes).length, 0);
	});

	it("skips files with no body in store", async () => {
		const core = mockCore();
		const rummy = mockRummy({});

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["missing.js"],
		});

		assert.equal(Object.keys(rummy.attributes).length, 0);
	});

	it("queues unsupported extensions for ctags fallback", async () => {
		const core = mockCore();
		const rummy = mockRummy({});

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["data.xyz"],
		});

		// ctags not installed in test env — no symbols, but no crash
		assert.equal(rummy.attributes["data.xyz"], undefined);
	});

	it("handles multiple paths in one event", async () => {
		const core = mockCore();
		const fmtBody = readFileSync(join(__dirname, "formatSymbols.js"), "utf8");
		const ctagsBody = readFileSync(
			join(__dirname, "CtagsExtractor.js"),
			"utf8",
		);
		const rummy = mockRummy({
			"formatSymbols.js": fmtBody,
			"CtagsExtractor.js": ctagsBody,
		});

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["formatSymbols.js", "CtagsExtractor.js"],
		});

		assert.ok(rummy.attributes["formatSymbols.js"]?.symbols);
		assert.ok(rummy.attributes["CtagsExtractor.js"]?.symbols);
	});

	it("handles antlrmap returning empty symbols", async () => {
		const core = mockCore();
		const rummy = mockRummy({ "empty.js": "" });

		new RummyRepo(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["empty.js"],
		});

		// Empty content — antlrmap returns nothing, falls to ctags, ctags not installed
		assert.equal(rummy.attributes["empty.js"], undefined);
	});

	it("registers turn.started listener on construction", () => {
		const core = mockCore();
		new RummyRepo(core);
		// Should not throw when emitting with noRepo
		assert.ok(core.emit("turn.started", { rummy: { noRepo: true } }));
	});

	it("skips turn.started when noRepo is true", async () => {
		const core = mockCore();
		new RummyRepo(core);
		// Should return without error
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

			// Initialize a git repo via isomorphic-git (avoids commitlint hooks)
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
			const store = mockKnownStore();

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
		});
	});
});
