import assert from "node:assert/strict";
import { describe, it } from "node:test";
import CtagsExtractor from "./CtagsExtractor.js";

function mockSpawn(stdout, status = 0) {
	return () => ({ stdout, stderr: "", status, error: null });
}

function mockSpawnError(code) {
	return () => ({ stdout: "", stderr: "", status: null, error: { code } });
}

describe("CtagsExtractor", () => {
	it("parses ctags JSON output into grouped map", () => {
		const lines = [
			JSON.stringify({
				path: "a.js",
				name: "foo",
				kind: "function",
				line: 1,
				signature: "(x)",
			}),
			JSON.stringify({ path: "a.js", name: "bar", kind: "variable", line: 5 }),
			JSON.stringify({ path: "b.js", name: "baz", kind: "class", line: 1 }),
		].join("\n");

		const extractor = new CtagsExtractor("/root", mockSpawn(lines));
		const result = extractor.extract(["a.js", "b.js"]);

		assert.equal(result.size, 2);
		assert.equal(result.get("a.js").length, 2);
		assert.equal(result.get("a.js")[0].name, "foo");
		assert.equal(result.get("a.js")[0].params, "(x)");
		assert.equal(result.get("b.js").length, 1);
		assert.equal(result.get("b.js")[0].name, "baz");
	});

	it("returns empty arrays when ctags is not installed", () => {
		const extractor = new CtagsExtractor("/root", mockSpawnError("ENOENT"));
		const result = extractor.extract(["a.js"]);

		assert.equal(result.size, 1);
		assert.deepEqual(result.get("a.js"), []);
	});

	it("returns empty arrays when ctags fails", () => {
		const extractor = new CtagsExtractor("/root", mockSpawn("", 1));
		const result = extractor.extract(["a.js"]);

		assert.equal(result.size, 1);
		assert.deepEqual(result.get("a.js"), []);
	});

	it("extracts Lua function signatures from pattern", () => {
		const lines = [
			JSON.stringify({
				path: "test.lua",
				name: "greet",
				kind: "function",
				line: 1,
				pattern: "/^function greet(name)$/",
			}),
		].join("\n");

		const extractor = new CtagsExtractor("/root", mockSpawn(lines));
		const result = extractor.extract(["test.lua"]);

		assert.equal(result.get("test.lua")[0].params, "(name)");
	});

	it("handles Lua assignment-style functions", () => {
		const lines = [
			JSON.stringify({
				path: "test.lua",
				name: "init",
				kind: "function",
				line: 3,
				pattern: "/^M.init = function(opts)$/",
			}),
		].join("\n");

		const extractor = new CtagsExtractor("/root", mockSpawn(lines));
		const result = extractor.extract(["test.lua"]);

		assert.equal(result.get("test.lua")[0].params, "(opts)");
	});
});
