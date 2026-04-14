import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import FileScanner from "./FileScanner.js";

function mockKnownStore() {
	const entries = new Map();
	return {
		async upsert(runId, _turn, path, content, status, opts = {}) {
			entries.set(`${runId}:${path}`, {
				path,
				body: content,
				status,
				fidelity: opts.fidelity,
				hash: opts.hash,
				attributes: opts.attributes,
				updated_at: opts.updatedAt,
			});
		},
		async getFileEntries(runId) {
			const result = [];
			for (const [key, val] of entries) {
				if (key.startsWith(`${runId}:`)) result.push(val);
			}
			return result;
		},
		async getBody(runId, path) {
			const entry = entries.get(`${runId}:${path}`);
			return entry?.body ?? null;
		},
		async remove(runId, path) {
			entries.delete(`${runId}:${path}`);
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
	const changedPayloads = [];
	return {
		hedberg: {
			match: (pattern, str) => pattern === str,
		},
		entry: {
			changed: {
				async emit(payload) {
					changedPayloads.push(payload);
				},
			},
		},
		changedPayloads,
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

	it("scans new files into the store", async () => {
		writeFileSync(join(tmpDir, "hello.js"), "const x = 1;");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const scanner = new FileScanner(store, mockDb(), hooks);

		await scanner.scan(tmpDir, 1, ["hello.js"], 1, {});

		const entry = store.entries.get("1:hello.js");
		assert.ok(entry);
		assert.equal(entry.body, "const x = 1;");
		assert.equal(entry.status, 200);
		assert.equal(entry.fidelity, "demoted");
	});

	it("skips unchanged files on second scan", async () => {
		writeFileSync(join(tmpDir, "a.js"), "let a = 1;");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const scanner = new FileScanner(store, mockDb(), hooks);

		await scanner.scan(tmpDir, 1, ["a.js"], 1, {});
		const firstHash = store.entries.get("1:a.js").hash;

		await scanner.scan(tmpDir, 1, ["a.js"], 2, {});
		const secondHash = store.entries.get("1:a.js").hash;

		assert.equal(firstHash, secondHash);
	});

	it("emits entry.changed for modified files", async () => {
		writeFileSync(join(tmpDir, "b.js"), "v1");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const scanner = new FileScanner(store, mockDb(), hooks);
		const rummy = {};

		await scanner.scan(tmpDir, 1, ["b.js"], 1, rummy);
		assert.equal(hooks.changedPayloads.length, 1);
		assert.deepEqual(hooks.changedPayloads[0].paths, ["b.js"]);
		assert.equal(hooks.changedPayloads[0].rummy, rummy);
	});

	it("does nothing when no active runs", async () => {
		writeFileSync(join(tmpDir, "c.js"), "const c = 1;");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const scanner = new FileScanner(store, mockDb([]), hooks);

		await scanner.scan(tmpDir, 1, ["c.js"], 1, {});
		assert.equal(store.entries.size, 0);
	});

	it("respects ignore constraints", async () => {
		writeFileSync(join(tmpDir, "secret.env"), "KEY=val");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const db = mockDb(
			[{ id: 1 }],
			[{ pattern: "secret.env", visibility: "ignore" }],
		);
		const scanner = new FileScanner(store, db, hooks);

		await scanner.scan(tmpDir, 1, ["secret.env"], 1, {});
		assert.equal(store.entries.has("1:secret.env"), false);
	});

	it("sets active constraint files to full state", async () => {
		writeFileSync(join(tmpDir, "main.js"), "export default {};");
		const store = mockKnownStore();
		const hooks = mockHooks();
		const db = mockDb(
			[{ id: 1 }],
			[{ pattern: "main.js", visibility: "active" }],
		);
		const scanner = new FileScanner(store, db, hooks);

		await scanner.scan(tmpDir, 1, ["main.js"], 1, {});
		assert.equal(store.entries.get("1:main.js").fidelity, "promoted");
	});

	it("removes files deleted from disk", async () => {
		const store = mockKnownStore();
		const hooks = mockHooks();
		// Pre-populate store with a file
		await store.upsert(1, 0, "gone.js", "old", 200, {
			fidelity: "demoted",
			hash: "abc",
		});

		const scanner = new FileScanner(store, mockDb(), hooks);
		// Scan with empty file list — gone.js not on disk
		await scanner.scan(tmpDir, 1, [], 1, {});

		assert.equal(store.entries.has("1:gone.js"), false);
	});
});
