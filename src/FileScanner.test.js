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
				fidelity: args.fidelity ?? prev.fidelity,
				attributes: attrs,
				hash: attrs.hash ?? prev.hash,
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
		assert.equal(entry.fidelity, "demoted");
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

	it("sets active constraint files to promoted fidelity", async () => {
		writeFileSync(join(tmpDir, "main.js"), "export default {};");
		const store = mockStore();
		const db = mockDb(
			[{ id: 1 }],
			[{ pattern: "main.js", visibility: "active" }],
		);
		const scanner = new FileScanner(store, db, mockHooks());

		await scanner.scan(tmpDir, 1, ["main.js"], 1);
		assert.equal(store.entries.get("1:main.js").fidelity, "promoted");
	});

	it("removes files deleted from disk via rm", async () => {
		const store = mockStore();
		await store.set({
			runId: 1,
			turn: 0,
			path: "gone.js",
			body: "old",
			state: "resolved",
			fidelity: "demoted",
			attributes: { hash: "abc" },
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
