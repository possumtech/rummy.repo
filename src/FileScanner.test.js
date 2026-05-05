import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import FileScanner from "./FileScanner.js";

function mockStore() {
	const entries = new Map();
	const writes = [];
	return {
		writes,
		async set(args) {
			writes.push({ op: "set", ...args });
			const key = `${args.runId}:${args.path}`;
			const prev = entries.get(key) || {};
			const attrs = {
				...(prev.attributes || {}),
				...(args.attributes || {}),
			};
			const next = {
				path: args.path,
				body: args.body ?? prev.body,
				state: args.state ?? prev.state,
				visibility: args.visibility ?? prev.visibility,
				attributes: attrs,
				hash: args.hash ?? prev.hash,
				updated_at: attrs.updatedAt ?? prev.updated_at,
				writer: args.writer ?? prev.writer,
			};
			entries.set(key, next);
		},
		async rm({ runId, path }) {
			writes.push({ op: "rm", runId, path });
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

function mockDb(activeRuns = [{ id: 1 }], constraints = []) {
	return {
		get_active_runs: {
			all: async () => activeRuns,
		},
		get_file_constraints: {
			all: async () => constraints,
		},
		get_entry_state: {
			get: async () => null,
		},
	};
}

function mockHooks() {
	return {
		hedberg: {
			match: (pattern, str) => pattern === str,
		},
	};
}

describe("FileScanner", () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "scanner-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("scans new files into the store with plugin writer", async () => {
		writeFileSync(join(tmpDir, "hello.js"), "const x = 1;");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["hello.js"], 1);

		const entry = store.entries.get("1:hello.js");
		assert.ok(entry);
		assert.equal(entry.body, "const x = 1;");
		assert.equal(entry.state, "resolved");
		assert.equal(entry.visibility, "archived");
		assert.equal(entry.writer, "plugin");
	});

	it("skips unchanged files on second scan", async () => {
		writeFileSync(join(tmpDir, "a.js"), "let a = 1;");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["a.js"], 1);
		const firstHash = store.entries.get("1:a.js").hash;

		await scanner.scan(tmpDir, 1, ["a.js"], 2);
		const secondHash = store.entries.get("1:a.js").hash;

		assert.equal(firstHash, secondHash);
	});

	it("attaches antlrmap symbols inline in the file write", async () => {
		writeFileSync(
			join(tmpDir, "b.js"),
			"export default function greet() { return 1; }",
		);
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["b.js"], 1);

		const entry = store.entries.get("1:b.js");
		assert.ok(entry.attributes.symbols, "expected symbols attribute");
		assert.ok(entry.attributes.symbols.includes("greet"));
	});

	it("does nothing when no active runs", async () => {
		writeFileSync(join(tmpDir, "c.js"), "const c = 1;");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb([]), mockHooks());

		await scanner.scan(tmpDir, 1, ["c.js"], 1);
		assert.equal(store.entries.size, 0);
	});

	it("respects ignore constraints", async () => {
		writeFileSync(join(tmpDir, "secret.env"), "KEY=val");
		const store = mockStore();
		const db = mockDb(
			[{ id: 1 }],
			[{ pattern: "secret.env", visibility: "ignore" }],
		);
		const scanner = new FileScanner(store, db, mockHooks());

		await scanner.scan(tmpDir, 1, ["secret.env"], 1);
		assert.equal(store.entries.has("1:secret.env"), false);
	});

	it("ingests `add` constraint files with default archived visibility", async () => {
		writeFileSync(join(tmpDir, "main.js"), "export default {};");
		const store = mockStore();
		const db = mockDb([{ id: 1 }], [{ pattern: "main.js", visibility: "add" }]);
		const scanner = new FileScanner(store, db, mockHooks());

		await scanner.scan(tmpDir, 1, ["main.js"], 1);
		assert.equal(store.entries.get("1:main.js").visibility, "archived");
	});

	it("writes log://turn_0/repo/manifest with directory rollup + flat file list", async () => {
		writeFileSync(join(tmpDir, "app.js"), "const x = 1;");
		writeFileSync(join(tmpDir, "README.md"), "# hi");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, "src/index.js"), "export {};");

		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["app.js", "README.md", "src/index.js"], 1);

		const manifest = store.entries.get("1:log://turn_0/repo/manifest");
		assert.ok(manifest, "expected log://turn_0/repo/manifest entry");
		assert.equal(manifest.state, "resolved");
		assert.equal(manifest.visibility, "visible");

		// Body shape: rollup section, delimiter, flat list section.
		const idx = manifest.body.indexOf("\n\n---\n\n");
		assert.ok(idx > 0, "body has the rollup/flat-list delimiter");
		const rollup = manifest.body.slice(0, idx);
		const flat = manifest.body.slice(idx + "\n\n---\n\n".length);

		// Rollup: one line per directory, alphabetical, with file count + token sum.
		// Root files roll up under "./"; src/ holds index.js.
		const rollupLines = rollup.split("\n");
		assert.match(rollupLines[0], /^\* \.\/ - 2 files, \d+ tokens$/);
		assert.match(rollupLines[1], /^\* src\/ - 1 file, \d+ tokens$/);

		// Flat list: every file with its token cost, alphabetical by path.
		const flatLines = flat.split("\n");
		assert.match(flatLines[0], /^\* app\.js - \d+ tokens$/);
		assert.match(flatLines[1], /^\* README\.md - \d+ tokens$/);
		assert.match(flatLines[2], /^\* src\/index\.js - \d+ tokens$/);

		// No category headers, no constraints, no navigate, no absolute path.
		assert.ok(!manifest.body.includes("##"));
		assert.ok(!manifest.body.includes("Navigate"));
		assert.ok(!manifest.body.includes("Constraints"));
		assert.ok(!manifest.body.includes(tmpDir));
	});

	it("does not rewrite log://turn_0/repo/manifest on subsequent scans", async () => {
		writeFileSync(join(tmpDir, "a.js"), "const a = 1;");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["a.js"], 1);
		const firstBody = store.entries.get("1:log://turn_0/repo/manifest").body;

		writeFileSync(join(tmpDir, "b.js"), "const b = 2;");
		await scanner.scan(tmpDir, 1, ["a.js", "b.js"], 2);
		const secondBody = store.entries.get("1:log://turn_0/repo/manifest").body;

		assert.equal(
			firstBody,
			secondBody,
			"manifest is a turn-0 snapshot; later scans must not mutate it",
		);
		assert.ok(
			!firstBody.includes("b.js"),
			"manifest must not list files added after run start",
		);
	});

	it("removes files deleted from disk via rm", async () => {
		const store = mockStore();
		await store.set({
			runId: 1,
			turn: 0,
			path: "gone.js",
			body: "old",
			state: "resolved",
			visibility: "summarized",
			hash: "abc",
			writer: "plugin",
		});

		const scanner = new FileScanner(store, mockDb(), mockHooks());
		await scanner.scan(tmpDir, 1, [], 1);

		assert.equal(store.entries.has("1:gone.js"), false);
		const rmCall = store.writes.find((w) => w.op === "rm");
		assert.ok(rmCall);
		assert.equal(rmCall.path, "gone.js");
		assert.equal(rmCall.runId, 1);
	});
});
