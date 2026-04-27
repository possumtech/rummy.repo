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
		assert.equal(
			result,
			"<symbols>\nfunction alpha:1\nfunction beta:10\n</symbols>",
		);
	});

	it("nests children inside parent by endLine", () => {
		const symbols = [
			{ name: "Outer", kind: "class", line: 1, endLine: 20 },
			{ name: "inner", kind: "method", line: 5, endLine: 10 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\nclass Outer:1\n  method inner:5\n</symbols>",
		);
	});

	it("formats params as comma-separated list", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: ["a", "b"], line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\nfunction fn(a, b):1\n</symbols>");
	});

	it("formats string params directly", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: "(x, y)", line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\nfunction fn((x, y)):1\n</symbols>");
	});

	it("handles symbols without kind or line", () => {
		const symbols = [{ name: "mystery" }];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\nmystery\n</symbols>");
	});

	it("returns wrapped empty for empty array", () => {
		assert.equal(formatSymbols([]), "<symbols>\n\n</symbols>");
	});

	it("pops stack when line exceeds parent endLine", () => {
		const symbols = [
			{ name: "A", kind: "class", line: 1, endLine: 10 },
			{ name: "m", kind: "method", line: 5, endLine: 8 },
			{ name: "B", kind: "class", line: 15, endLine: 25 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\nclass A:1\n  method m:5\nclass B:15\n</symbols>",
		);
	});
});
