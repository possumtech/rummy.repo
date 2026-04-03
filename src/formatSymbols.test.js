import assert from "node:assert/strict";
import { describe, it } from "node:test";
import formatSymbols from "./formatSymbols.js";

describe("formatSymbols", () => {
	it("formats flat symbols sorted by line", () => {
		const symbols = [
			{ name: "beta", kind: "function", line: 10 },
			{ name: "alpha", kind: "function", line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "function alpha L1\nfunction beta L10");
	});

	it("nests children inside parent by endLine", () => {
		const symbols = [
			{ name: "Outer", kind: "class", line: 1, endLine: 20 },
			{ name: "inner", kind: "method", line: 5, endLine: 10 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "class Outer L1\n  method inner L5");
	});

	it("formats params as comma-separated list", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: ["a", "b"], line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "function fn(a, b) L1");
	});

	it("formats string params directly", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: "(x, y)", line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "function fn((x, y)) L1");
	});

	it("handles symbols without kind or line", () => {
		const symbols = [{ name: "mystery" }];
		const result = formatSymbols(symbols);
		assert.equal(result, "mystery");
	});

	it("returns empty string for empty array", () => {
		assert.equal(formatSymbols([]), "");
	});

	it("pops stack when line exceeds parent endLine", () => {
		const symbols = [
			{ name: "A", kind: "class", line: 1, endLine: 10 },
			{ name: "m", kind: "method", line: 5, endLine: 8 },
			{ name: "B", kind: "class", line: 15, endLine: 25 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "class A L1\n  method m L5\nclass B L15");
	});
});
