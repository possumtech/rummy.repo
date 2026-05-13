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
		assert.equal(result, "<symbols>\n1:\t[alpha]\n10:\t[beta]\n</symbols>");
	});

	it("nests children inside parent via `»` chain", () => {
		const symbols = [
			{ name: "Outer", kind: "class", line: 1, endLine: 20 },
			{ name: "inner", kind: "method", line: 5, endLine: 10 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\t{Outer}\n5:\t{Outer} » [inner]\n</symbols>",
		);
	});

	it("formats array params as comma-separated list inside callable wrapper", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: ["a", "b"], line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\n1:\t[fn(a, b)]\n</symbols>");
	});

	it("uses ctags string params directly (already includes parens)", () => {
		const symbols = [
			{ name: "fn", kind: "function", params: "(x, y)", line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\n1:\t[fn(x, y)]\n</symbols>");
	});

	it("reads ctags `type` field as kind for categorization", () => {
		const symbols = [
			{ name: "fn", type: "function", params: "(x)", line: 1 },
			{ name: "Cls", type: "class", line: 5 },
			{ name: "v", type: "variable", line: 9 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\t[fn(x)]\n5:\t{Cls}\n9:\tv\n</symbols>",
		);
	});

	it("wraps containers with {} (class, interface, enum, struct, trait, namespace, module, typedef)", () => {
		const symbols = [
			{ name: "C", kind: "class", line: 1 },
			{ name: "I", kind: "interface", line: 2 },
			{ name: "E", kind: "enum", line: 3 },
			{ name: "S", kind: "struct", line: 4 },
			{ name: "T", kind: "trait", line: 5 },
			{ name: "N", kind: "namespace", line: 6 },
			{ name: "M", kind: "module", line: 7 },
			{ name: "Td", kind: "typedef", line: 8 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\t{C}\n2:\t{I}\n3:\t{E}\n4:\t{S}\n5:\t{T}\n6:\t{N}\n7:\t{M}\n8:\t{Td}\n</symbols>",
		);
	});

	it("wraps callables with [] (function, method, constructor, generator, macro)", () => {
		const symbols = [
			{ name: "f", kind: "function", line: 1 },
			{ name: "m", kind: "method", line: 2 },
			{ name: "ctor", kind: "constructor", line: 3 },
			{ name: "g", kind: "generator", line: 4 },
			{ name: "mc", kind: "macro", line: 5 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\t[f]\n2:\t[m]\n3:\t[ctor]\n4:\t[g]\n5:\t[mc]\n</symbols>",
		);
	});

	it("renders data kinds bare (field, variable, property, constant, member, enumerator)", () => {
		const symbols = [
			{ name: "fld", kind: "field", line: 1 },
			{ name: "vbl", kind: "variable", line: 2 },
			{ name: "prp", kind: "property", line: 3 },
			{ name: "kst", kind: "constant", line: 4 },
			{ name: "mbr", kind: "member", line: 5 },
			{ name: "etr", kind: "enumerator", line: 6 },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\tfld\n2:\tvbl\n3:\tprp\n4:\tkst\n5:\tmbr\n6:\tetr\n</symbols>",
		);
	});

	it("falls back to bare for unknown kinds", () => {
		const symbols = [
			{ name: "weird", kind: "exotic_kind_we_dont_know", line: 1 },
		];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\n1:\tweird\n</symbols>");
	});

	it("handles symbols without kind or line — empty line column, bare name", () => {
		const symbols = [{ name: "mystery" }];
		const result = formatSymbols(symbols);
		assert.equal(result, "<symbols>\n:\tmystery\n</symbols>");
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
		assert.equal(
			result,
			"<symbols>\n1:\t{A}\n5:\t{A} » [m]\n15:\t{B}\n</symbols>",
		);
	});

	it("builds deep ancestor chains across multiple levels", () => {
		const symbols = [
			{ name: "Outer", kind: "class", line: 1, endLine: 30 },
			{ name: "Inner", kind: "class", line: 5, endLine: 25 },
			{ name: "deep", kind: "method", line: 10, endLine: 15, params: ["x"] },
		];
		const result = formatSymbols(symbols);
		assert.equal(
			result,
			"<symbols>\n1:\t{Outer}\n5:\t{Outer} » {Inner}\n10:\t{Outer} » {Inner} » [deep(x)]\n</symbols>",
		);
	});
});
