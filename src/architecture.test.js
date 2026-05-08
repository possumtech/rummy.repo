import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// SPEC.md §3.1: ProjectContext is the membership layer. Membership
// is a pure function of git output and the constraint table. The
// layer MUST NOT touch the filesystem, shell out, classify entries,
// or pull in external discovery libraries.
//
// These are positive structural invariants, not surface-keyword
// denylists. A determined contributor can route around any keyword
// grep; the import allowlist and signature shape cannot be evaded
// without producing a visible, reviewable change.
describe("architecture: membership layer (SPEC §3.1)", () => {
	const projectContextSrc = readFileSync(
		join(__dirname, "ProjectContext.js"),
		"utf8",
	);

	it("ProjectContext imports only from the membership allowlist", () => {
		const ALLOWED = new Set(["node:path", "./GitProvider.js"]);
		const imports = [
			...projectContextSrc.matchAll(
				/^import\s+[^"';]*?\s+from\s+["']([^"']+)["']/gm,
			),
		].map((m) => m[1]);

		assert.ok(imports.length > 0, "expected at least one import");
		for (const spec of imports) {
			assert.ok(
				ALLOWED.has(spec),
				`ProjectContext must not import '${spec}'. Membership is a pure function of git output and the constraint table; reading the filesystem, shelling out, or pulling in discovery libraries violates SPEC §3.1. Allowed: ${[...ALLOWED].join(", ")}.`,
			);
		}
	});

	it("ProjectContext.open signature accepts only (path, dbFiles?)", () => {
		const match = projectContextSrc.match(
			/static\s+async\s+open\s*\((.*?)\)\s*\{/s,
		);
		assert.ok(match, "ProjectContext.open signature not found");
		const params = match[1].trim().replace(/\s+/g, " ");

		assert.match(
			params,
			/^path(\s*,\s*dbFiles\s*=\s*new\s+Set\(\))?$/,
			`ProjectContext.open must accept only (path, dbFiles?) — found: (${params}). New parameters that influence membership require a deliberate API change per SPEC §3.1.`,
		);
	});
});
