import assert from "node:assert/strict";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import SymbolsPlugin from "./rummy.repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SymbolsPlugin", () => {
	it("exports a class with static register method", () => {
		assert.equal(typeof SymbolsPlugin.register, "function");
	});

	it("exports formatSymbols as a static method", () => {
		assert.equal(typeof SymbolsPlugin.formatSymbols, "function");
	});

	it("register adds a filter to hooks.file.symbols", () => {
		let registered = false;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback, priority) {
						registered = true;
						assert.equal(typeof callback, "function");
						assert.equal(priority, 50);
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);
		assert.equal(registered, true);
	});

	it("extracts symbols from JS files via antlrmap", async () => {
		let filterFn;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback) {
						filterFn = callback;
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);

		const result = await filterFn(new Map(), {
			paths: ["formatSymbols.js"],
			projectPath: __dirname,
		});

		assert.ok(result instanceof Map);
		assert.ok(result.has("formatSymbols.js"));
		const symbols = result.get("formatSymbols.js");
		assert.ok(symbols.length > 0);
		assert.ok(symbols.some((s) => s.name === "formatSymbols"));
	});

	it("skips paths already in the map", async () => {
		let filterFn;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback) {
						filterFn = callback;
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);

		const existing = new Map([["formatSymbols.js", [{ name: "existing" }]]]);
		const result = await filterFn(existing, {
			paths: ["formatSymbols.js"],
			projectPath: __dirname,
		});

		assert.equal(result.get("formatSymbols.js")[0].name, "existing");
	});

	it("queues unsupported extensions for ctags", async () => {
		let filterFn;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback) {
						filterFn = callback;
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);

		const result = await filterFn(new Map(), {
			paths: ["data.xyz"],
			projectPath: __dirname,
		});

		assert.ok(result instanceof Map);
	});

	it("coerces non-Map input to Map", async () => {
		let filterFn;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback) {
						filterFn = callback;
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);

		const result = await filterFn("not a map", {
			paths: [],
			projectPath: __dirname,
		});

		assert.ok(result instanceof Map);
	});

	it("handles missing files gracefully", async () => {
		let filterFn;
		const hooks = {
			file: {
				symbols: {
					addFilter(callback) {
						filterFn = callback;
					},
				},
			},
		};
		SymbolsPlugin.register(hooks);

		const result = await filterFn(new Map(), {
			paths: ["nonexistent.js"],
			projectPath: __dirname,
		});

		assert.ok(result instanceof Map);
	});
});
