const CONTAINERS = new Set([
	"class",
	"interface",
	"enum",
	"struct",
	"trait",
	"namespace",
	"module",
	"typedef",
]);

const CALLABLES = new Set([
	"function",
	"method",
	"constructor",
	"generator",
	"macro",
]);

function renderParams(params) {
	if (!params) return "";
	if (Array.isArray(params)) return `(${params.join(", ")})`;
	return params;
}

function wrap(kind, name, params) {
	if (CONTAINERS.has(kind)) return `{${name}}`;
	if (CALLABLES.has(kind)) return `[${name}${renderParams(params)}]`;
	return name;
}

export default function formatSymbols(symbols) {
	if (symbols.length === 0) return "";

	const sorted = symbols.toSorted((a, b) => (a.line || 0) - (b.line || 0));
	const stack = [];
	const lines = [];

	for (const s of sorted) {
		while (stack.length > 0 && s.line > stack.at(-1).endLine) stack.pop();
		const kind = s.kind ?? s.type;
		const ancestors = stack.map((p) =>
			wrap(p.kind ?? p.type, p.name, p.params),
		);
		const self = wrap(kind, s.name, s.params);
		const path = [...ancestors, self].join(" » ");
		const prefix = s.line ? `${s.line}:` : ":";
		lines.push(`${prefix}\t${path}`);
		if (s.endLine && s.endLine > s.line) stack.push(s);
	}

	return `<symbols>\n${lines.join("\n")}\n</symbols>`;
}
