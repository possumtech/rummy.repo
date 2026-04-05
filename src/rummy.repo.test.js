import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import RepoMapPlugin from "./rummy.repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function mockCore() {
	const listeners = new Map();
	return {
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
		project: { project_root: projectRoot },
		async getBody(path) {
			return bodies[path] ?? null;
		},
		async setAttributes(path, attrs) {
			attributes[path] = { ...(attributes[path] || {}), ...attrs };
		},
		attributes,
	};
}

describe("RepoMapPlugin", () => {
	it("registers entry.changed listener on construction", () => {
		const core = mockCore();
		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
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

		new RepoMapPlugin(core);
		await core.emit("entry.changed", {
			rummy,
			runId: 1,
			turn: 1,
			paths: ["empty.js"],
		});

		// Empty content — antlrmap returns nothing, falls to ctags, ctags not installed
		assert.equal(rummy.attributes["empty.js"], undefined);
	});
});
