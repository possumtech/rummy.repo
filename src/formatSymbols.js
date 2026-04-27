export default function formatSymbols(symbols) {
	const sorted = symbols.toSorted((a, b) => (a.line || 0) - (b.line || 0));
	const stack = [];
	const lines = [];

	for (const s of sorted) {
		while (stack.length > 0 && s.line > stack.at(-1).endLine) stack.pop();
		const depth = stack.length;
		const indent = "  ".repeat(depth);
		const kind = s.kind ? `${s.kind} ` : "";
		const line = s.line ? `:${s.line}` : "";
		const p = s.params
			? `(${Array.isArray(s.params) ? s.params.join(", ") : s.params})`
			: "";
		lines.push(`${indent}${kind}${s.name}${p}${line}`);
		if (s.endLine && s.endLine > s.line) stack.push(s);
	}

	return `<symbols>\n${lines.join("\n")}\n</symbols>`;
}
