import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import FileScanner from "./FileScanner.js";

function mockStore() {
	const entries = new Map();
	const writes = [];
	let nextSeq = 0;
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
		async logPath(_runId, _loopId, turn, action) {
			nextSeq += 1;
			return `log://1/${turn}/${nextSeq}/${action}`;
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

function mockDb(
	activeRuns = [{ id: 1 }],
	constraints = [],
	currentLoop = { id: 42 },
) {
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
		get_current_loop: {
			get: async () => currentLoop,
		},
	};
}

function mockHooks() {
	return {
		hedberg: {
			match: (pattern, str) => pattern === str,
			renderClient: () => "udiff-stub",
			renderModel: (before, after) => {
				if (before === after) return "";
				if (before === "") {
					return `<<SEARCH\nSEARCH<<REPLACE\n${after}\nREPLACE`;
				}
				return `<<SEARCH\n${before}\nSEARCH<<REPLACE\n${after}\nREPLACE`;
			},
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
		assert.equal(entry.visibility, "indexed");
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

	it("ingests `add` constraint files with default indexed visibility", async () => {
		writeFileSync(join(tmpDir, "main.js"), "export default {};");
		const store = mockStore();
		const db = mockDb([{ id: 1 }], [{ pattern: "main.js", visibility: "add" }]);
		const scanner = new FileScanner(store, db, mockHooks());

		await scanner.scan(tmpDir, 1, ["main.js"], 1);
		// Files default to indexed — each file becomes its own catalog
		// tile in <index>. Tile body renders symbols (or empty if no
		// symbols extracted); full body retrieved via <get>.
		assert.equal(store.entries.get("1:main.js").visibility, "indexed");
	});

	it("writes mimetype attribute on file entries (extension-resolved per §7)", async () => {
		writeFileSync(join(tmpDir, "code.js"), "const x = 1;");
		writeFileSync(join(tmpDir, "doc.md"), "# hi");
		writeFileSync(join(tmpDir, "data.json"), "{}");
		writeFileSync(join(tmpDir, "Makefile"), "all:\n\techo hi\n");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(
			tmpDir,
			1,
			["code.js", "doc.md", "data.json", "Makefile"],
			1,
		);

		assert.equal(
			store.entries.get("1:code.js").attributes.mimetype,
			"text/javascript",
		);
		assert.equal(
			store.entries.get("1:doc.md").attributes.mimetype,
			"text/markdown",
		);
		assert.equal(
			store.entries.get("1:data.json").attributes.mimetype,
			"application/json",
		);
		// No-extension paths fall through to the engine default per §7
		// precedence (explicit attr → extension → text/markdown).
		assert.equal(
			store.entries.get("1:Makefile").attributes.mimetype,
			"text/markdown",
		);
	});

	it("writes repo://manifest with directory rollup + flat file list", async () => {
		writeFileSync(join(tmpDir, "app.js"), "const x = 1;");
		writeFileSync(join(tmpDir, "README.md"), "# hi");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, "src/index.js"), "export {};");

		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["app.js", "README.md", "src/index.js"], 1);

		const manifest = store.entries.get("1:repo://manifest");
		assert.ok(manifest, "expected repo://manifest entry");
		assert.equal(manifest.state, "resolved");
		assert.equal(manifest.visibility, "indexed");

		// Body shape: canonical JSON-per-row. Rollup rows first (paths
		// ending in `/`), per-file rows after. No separator.
		const lines = manifest.body.split("\n");
		assert.ok(!manifest.body.includes("---"), "no separator line");

		// Rollup: one JSON row per directory, alphabetical, path + tokens
		// (token sum). Root files roll up under "./"; src/ holds index.js.
		assert.deepEqual({ path: JSON.parse(lines[0]).path }, { path: "./" });
		assert.equal(typeof JSON.parse(lines[0]).tokens, "number");
		assert.deepEqual({ path: JSON.parse(lines[1]).path }, { path: "src/" });
		assert.equal(typeof JSON.parse(lines[1]).tokens, "number");

		// Flat list: one JSON row per file, alphabetical by path. Each
		// row carries `mimetype` (§7 enrichment) for content-shape
		// planning by the model.
		assert.equal(JSON.parse(lines[2]).path, "app.js");
		assert.equal(JSON.parse(lines[2]).mimetype, "text/javascript");
		assert.equal(JSON.parse(lines[3]).path, "README.md");
		assert.equal(JSON.parse(lines[3]).mimetype, "text/markdown");
		assert.equal(JSON.parse(lines[4]).path, "src/index.js");
		assert.equal(JSON.parse(lines[4]).mimetype, "text/javascript");

		// No category headers, no constraints, no navigate, no absolute path.
		assert.ok(!manifest.body.includes("##"));
		assert.ok(!manifest.body.includes("Navigate"));
		assert.ok(!manifest.body.includes("Constraints"));
		assert.ok(!manifest.body.includes(tmpDir));
	});

	it("refreshes repo://manifest on subsequent scans", async () => {
		writeFileSync(join(tmpDir, "a.js"), "const a = 1;");
		const store = mockStore();
		const scanner = new FileScanner(store, mockDb(), mockHooks());

		await scanner.scan(tmpDir, 1, ["a.js"], 1);
		const firstBody = store.entries.get("1:repo://manifest").body;
		assert.ok(firstBody.includes("a.js"));
		assert.ok(!firstBody.includes("b.js"));

		writeFileSync(join(tmpDir, "b.js"), "const b = 2;");
		await scanner.scan(tmpDir, 1, ["a.js", "b.js"], 2);
		const secondBody = store.entries.get("1:repo://manifest").body;

		assert.ok(
			secondBody.includes("b.js"),
			"manifest must list files added after run start",
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

	// Phase 3 of the index/archive refactor: every engine-mediated
	// file mutation surfaces as a synthetic log entry in the model's
	// native edit grammar (set with SEARCH/REPLACE, or rm). attrs.patch
	// carries the udiff for client renderers; attrs.external=true flags
	// engine authorship.
	describe("external mutation log injection (Phase 3)", () => {
		it("new file on disk: writes a log://*/<turn>/*/set entry with empty-SEARCH body", async () => {
			// "NEW file" semantically means "appeared between scans" —
			// not "everything is new at bootstrap." Seed the store with
			// at least one prior file entry so the run has a baseline,
			// then create a NEW file on disk between scans.
			const store = mockStore();
			await store.set({
				runId: 1,
				turn: 0,
				path: "baseline.md",
				body: "baseline",
				state: "resolved",
				visibility: "archived",
				hash: "base",
				writer: "plugin",
			});

			writeFileSync(join(tmpDir, "fresh.md"), "hello\n");
			const scanner = new FileScanner(store, mockDb(), mockHooks());

			await scanner.scan(tmpDir, 1, ["fresh.md"], 5);

			const logWrite = store.writes.find(
				(w) =>
					w.op === "set" &&
					typeof w.path === "string" &&
					/^log:\/\/\d+\/5\/\d+\/set$/.test(w.path),
			);
			assert.ok(logWrite, "log://.../set entry written");
			assert.match(logWrite.body, /^<<SEARCH\nSEARCH<<REPLACE/);
			assert.match(logWrite.body, /hello/);
			assert.equal(logWrite.attributes.path, "fresh.md");
			assert.equal(logWrite.attributes.external, true);
			assert.equal(logWrite.attributes.patch, "udiff-stub");
		});

		it("bootstrap scan (zero prior file entries): no log injection — every file is baseline, not delta", async () => {
			// Without this guard, the initial scan synthesizes a NEW-file
			// log entry for every file in the project — N×fullbody tokens
			// dumped into <log> on turn 1, blowing the budget on any
			// non-trivial repo. The project's baseline state is captured
			// in the file entries themselves; <log> stays clean.
			writeFileSync(join(tmpDir, "a.md"), "alpha\n");
			writeFileSync(join(tmpDir, "b.md"), "beta\n");
			const store = mockStore();
			const scanner = new FileScanner(store, mockDb(), mockHooks());

			await scanner.scan(tmpDir, 1, ["a.md", "b.md"], 1);

			const logWrites = store.writes.filter(
				(w) =>
					w.op === "set" &&
					typeof w.path === "string" &&
					w.path.startsWith("log://"),
			);
			assert.equal(
				logWrites.length,
				0,
				"no log entries injected during bootstrap scan",
			);
			// Both files still land as bare file entries.
			assert.ok(store.entries.has("1:a.md"));
			assert.ok(store.entries.has("1:b.md"));
		});

		it("modified file on disk: writes a log://*/<turn>/*/set with SEARCH/REPLACE pair", async () => {
			const store = mockStore();
			await store.set({
				runId: 1,
				turn: 0,
				path: "edit_me.md",
				body: "old\n",
				state: "resolved",
				visibility: "archived",
				hash: "stale",
				writer: "plugin",
			});

			writeFileSync(join(tmpDir, "edit_me.md"), "new\n");
			const scanner = new FileScanner(store, mockDb(), mockHooks());
			await scanner.scan(tmpDir, 1, ["edit_me.md"], 5);

			const logWrite = store.writes.find(
				(w) =>
					w.op === "set" &&
					typeof w.path === "string" &&
					/^log:\/\/\d+\/5\/\d+\/set$/.test(w.path),
			);
			assert.ok(logWrite, "log://.../set entry written");
			assert.match(logWrite.body, /<<SEARCH\nold\n/);
			assert.match(logWrite.body, /SEARCH<<REPLACE\nnew\n/);
			assert.equal(logWrite.attributes.path, "edit_me.md");
			assert.equal(logWrite.attributes.external, true);
			assert.equal(logWrite.attributes.patch, "udiff-stub");
		});

		it("removed file: writes a log://*/<turn>/*/rm entry before the actual rm", async () => {
			const store = mockStore();
			await store.set({
				runId: 1,
				turn: 0,
				path: "going.md",
				body: "bye",
				state: "resolved",
				visibility: "archived",
				hash: "abc",
				writer: "plugin",
			});

			const scanner = new FileScanner(store, mockDb(), mockHooks());
			await scanner.scan(tmpDir, 1, [], 5);

			const rmLog = store.writes.find(
				(w) =>
					w.op === "set" &&
					typeof w.path === "string" &&
					/^log:\/\/\d+\/5\/\d+\/rm$/.test(w.path),
			);
			assert.ok(rmLog, "log://.../rm entry written");
			assert.equal(rmLog.body, "");
			assert.equal(rmLog.attributes.path, "going.md");
			assert.equal(rmLog.attributes.external, true);

			const rmCall = store.writes.find((w) => w.op === "rm");
			assert.ok(rmCall, "actual entry removal still fires");
			assert.equal(rmCall.path, "going.md");

			// Order: log entry written before the rm call.
			const logIdx = store.writes.indexOf(rmLog);
			const rmIdx = store.writes.indexOf(rmCall);
			assert.ok(
				logIdx < rmIdx,
				"engine-injected <rm> log lands before the entry removal",
			);
		});

		it("skips log injection when no active loop (run hasn't dispatched)", async () => {
			writeFileSync(join(tmpDir, "early.md"), "hi");
			const store = mockStore();
			const db = mockDb([{ id: 1 }], [], null);
			const scanner = new FileScanner(store, db, mockHooks());

			await scanner.scan(tmpDir, 1, ["early.md"], 0);

			const logWrites = store.writes.filter(
				(w) =>
					w.op === "set" &&
					typeof w.path === "string" &&
					w.path.startsWith("log://"),
			);
			assert.equal(
				logWrites.length,
				0,
				"no log injection without an active loop",
			);
			// File entry still lands.
			assert.ok(store.entries.has("1:early.md"));
		});
	});
});
