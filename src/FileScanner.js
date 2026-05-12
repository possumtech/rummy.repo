import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { extname, join } from "node:path";
import Antlrmap from "@possumtech/antlrmap";
import CtagsExtractor from "./CtagsExtractor.js";
import formatSymbols from "./formatSymbols.js";

const antlrmapSupported = new Set(Object.keys(Antlrmap.extensions));

function hashContent(content) {
	return crypto.createHash("sha256").update(content).digest("hex");
}

export default class FileScanner {
	#store;
	#db;
	#hooks;
	#antlrmap;

	constructor(store, db, hooks) {
		this.#store = store;
		this.#db = db;
		this.#hooks = hooks;
		this.#antlrmap = new Antlrmap();
	}

	/**
	 * Scan the project and sync file entries across all active runs.
	 * Uses filesystem mtime to skip unchanged files (no read, no hash).
	 * Extracts symbols inline so each write carries its attributes.symbols.
	 */
	async scan(projectPath, projectId, mappableFiles, currentTurn = 0) {
		const activeRuns = await this.#db.get_active_runs.all({
			project_id: projectId,
		});
		if (activeRuns.length === 0) return;

		const constraintRows = await this.#db.get_file_constraints.all({
			project_id: projectId,
		});
		const constraints = new Map(
			constraintRows.map((c) => [c.pattern, c.visibility]),
		);

		for (const [pattern, visibility] of constraints) {
			if (visibility === "ignore") continue;
			if (!mappableFiles.includes(pattern)) {
				mappableFiles.push(pattern);
			}
		}

		const diskStats = new Map();
		const { match } = this.#hooks.hedberg;
		const isIgnored = (relPath) =>
			[...constraints.entries()].some(
				([pattern, vis]) => vis === "ignore" && match(pattern, relPath),
			);
		const statResults = await Promise.all(
			mappableFiles
				.filter((relPath) => !isIgnored(relPath))
				.map(async (relPath) => {
					const fullPath = join(projectPath, relPath);
					try {
						const stat = await fs.stat(fullPath);
						if (!stat.isFile()) return null;
						return { relPath, mtime: stat.mtimeMs, fullPath };
					} catch {
						return null;
					}
				}),
		);
		for (const entry of statResults) {
			if (entry)
				diskStats.set(entry.relPath, {
					mtime: entry.mtime,
					fullPath: entry.fullPath,
				});
		}

		for (const run of activeRuns) {
			await this.#syncRun(
				run.id,
				projectPath,
				diskStats,
				currentTurn,
				constraints,
			);
		}
	}

	async #syncRun(runId, projectPath, diskStats, currentTurn, constraints) {
		const existing = await this.#store.getFileEntries(runId);
		const fileKeys = new Map();
		for (const entry of existing) fileKeys.set(entry.path, entry);

		// Initial scan = bootstrap, not a delta. When the run has zero
		// prior file entries, every file on disk is "new" to the entry
		// store but none of them are deltas from the model's perspective
		// — the project state is the baseline. Synthesizing a NEW-file
		// log entry per file would dump the entire project into <log>
		// on turn 1 and blow the budget. Skip injection in this case;
		// subsequent scans (existing.length > 0) inject for real deltas.
		const isBootstrap = existing.length === 0;

		// Loop scope for synthesizing log entries that surface external
		// filesystem mutations back to the model. Per-loop turn counters
		// (log://<L>/<T>/<S>/...) need a loop_id; if there isn't an
		// active loop yet (run hasn't dispatched its first turn), the
		// scan still happens but log injection is skipped — the file
		// entries themselves carry the freshest state.
		const loop = await this.#db.get_current_loop.get({ run_id: runId });
		const loopId = loop?.id ?? null;

		const ctagsQueue = [];

		for (const [relPath, { mtime, fullPath }] of diskStats) {
			const entry = fileKeys.get(relPath);
			fileKeys.delete(relPath);

			const storedMtime = entry?.updated_at
				? new Date(entry.updated_at).getTime()
				: 0;
			if (entry && Math.abs(mtime - storedMtime) < 1000) continue;

			let content;
			try {
				content = readFileSync(fullPath, "utf8");
			} catch {
				continue;
			}
			const hash = hashContent(content);
			if (entry?.hash === hash) continue;

			// Engine-injected log entry surfacing the external change in
			// the model's own edit grammar (SEARCH/REPLACE, marker.js
			// shape) for the log body. attrs.patch carries the udiff
			// for client renderers (rummy.nvim). attrs.external=true
			// distinguishes engine injection from model authorship.
			// Fires for both first-appearance (empty SEARCH, full
			// REPLACE) and modification (one S/R pair per diff hunk).
			if (
				!isBootstrap &&
				loopId !== null &&
				this.#hooks?.hedberg?.generateSearchReplaceBody
			) {
				const before = entry?.body ?? "";
				const body = this.#hooks.hedberg.generateSearchReplaceBody(
					before,
					content,
				);
				if (body) {
					const logPath = await this.#store.logPath(
						runId,
						loopId,
						currentTurn,
						"set",
					);
					const patch = this.#hooks.hedberg.generatePatch
						? this.#hooks.hedberg.generatePatch(relPath, before, content)
						: null;
					await this.#store.set({
						runId,
						loopId,
						turn: currentTurn,
						path: logPath,
						body,
						state: "resolved",
						attributes: {
							path: relPath,
							external: true,
							...(patch ? { patch } : {}),
						},
						writer: "plugin",
					});
				}
			}

			const constraint = matchConstraint(
				constraints,
				relPath,
				this.#hooks.hedberg.match,
			);
			// Files are the primary inventory; default visibility is
			// `indexed` so each file renders as a symbol-bearing tile
			// in `<index>` at run init. `repo://manifest` is the
			// compaction lifeline when the indexed tile set
			// overshoots ceiling (see SPEC §turn_zero_budget_gate).
			// Preserve any existing entry visibility on re-scan so
			// the model's own promote/demote isn't clobbered.
			const visibility = entry?.visibility || "indexed";

			const attributes = {
				constraint,
				updatedAt: new Date(mtime).toISOString(),
			};
			const symbols = await this.#extractAntlrSymbols(relPath, content);
			if (symbols != null) {
				attributes.symbols = symbols;
			} else if (extname(relPath)) {
				ctagsQueue.push(relPath);
			}

			await this.#store.set({
				runId,
				loopId,
				turn: currentTurn,
				path: relPath,
				body: content,
				state: "resolved",
				visibility,
				hash,
				attributes,
				writer: "plugin",
			});
		}

		if (ctagsQueue.length > 0) {
			const extractor = new CtagsExtractor(projectPath);
			const ctagsResults = extractor.extract(ctagsQueue);
			for (const [path, symbols] of ctagsResults) {
				if (symbols.length === 0) continue;
				await this.#store.set({
					runId,
					loopId,
					turn: currentTurn,
					path,
					attributes: { symbols: formatSymbols(symbols) },
					writer: "plugin",
				});
			}
		}

		for (const [relPath] of fileKeys) {
			// Symmetric to the set-log injection above: surface the
			// disk-side delete as an engine-injected <rm> log entry
			// (model's grammar for removal) so the model sees state it
			// didn't author. attrs.external=true; empty body. Then the
			// actual entry removal runs.
			if (loopId !== null) {
				const logPath = await this.#store.logPath(
					runId,
					loopId,
					currentTurn,
					"rm",
				);
				await this.#store.set({
					runId,
					loopId,
					turn: currentTurn,
					path: logPath,
					body: "",
					state: "resolved",
					attributes: { path: relPath, external: true },
					writer: "plugin",
				});
			}
			await this.#store.rm({ runId, path: relPath, writer: "plugin" });
		}

		// Project manifest at `repo://manifest`. Refreshed every scan so
		// files added or removed during the run become visible to the
		// model on next loop start. Per-file entries (loop above) carry
		// current content; the manifest is the orientation catalog.
		//
		// Body shape: canonical JSON-per-row — `{"path":"...","tokens":N}`.
		// Directory rollup rows first (path ends in `/`), per-file rows
		// after. One list, one format, no separators.
		const fileEntries = await this.#store.getEntriesByPattern(
			runId,
			"**",
			null,
		);
		const files = fileEntries
			.filter((e) => e.scheme == null)
			.toSorted((a, b) => a.path.localeCompare(b.path));
		// Manifest write requires loopId (schema NOT NULL). When the
		// run hasn't dispatched its first turn yet, there's no active
		// loop — skip; the next scan (during loop 1's first turn) will
		// write the manifest then. File entries themselves carry their
		// own loopId; this skip only defers the manifest tile.
		if (loopId == null) return;
		await this.#store.set({
			runId,
			loopId,
			turn: 0,
			path: "repo://manifest",
			body: buildManifestBody(files),
			state: "resolved",
			visibility: "indexed",
			writer: "plugin",
		});
	}

	async #extractAntlrSymbols(relPath, content) {
		const ext = extname(relPath);
		if (!ext || !antlrmapSupported.has(ext)) return null;
		try {
			const symbols = await this.#antlrmap.mapSource(content, ext);
			if (!symbols || symbols.length === 0) return null;
			return formatSymbols(symbols);
		} catch {
			return null;
		}
	}
}

function matchConstraint(constraints, relPath, match) {
	for (const [pattern, visibility] of constraints) {
		if (match(pattern, relPath)) return visibility;
	}
	return null;
}

// Manifest body: directory rollup + flat file list as JSON-per-row.
// Rollup rows have paths ending in `/` (e.g., `src/`, `./`); per-file
// rows carry `lines` (file body line count) alongside `tokens` so the
// model can plan `<get lineFirst=… lineFinal=…/>` partial reads
// without computing the denominator. Rollup rows aggregate tokens but
// not lines (line count across heterogeneous files isn't meaningful).
export function buildManifestBody(files) {
	const byDir = new Map();
	for (const f of files) {
		const idx = f.path.lastIndexOf("/");
		const dir = idx === -1 ? "./" : `${f.path.slice(0, idx)}/`;
		const e = byDir.get(dir) ?? { count: 0, tokens: 0 };
		e.count += 1;
		e.tokens += f.tokens;
		byDir.set(dir, e);
	}
	const rollup = [...byDir.entries()]
		.toSorted(([a], [b]) => a.localeCompare(b))
		.map(([path, { tokens }]) => JSON.stringify({ path, tokens }));
	const flat = files.map((f) => {
		const lines = countLines(f.body);
		return lines
			? JSON.stringify({ path: f.path, tokens: f.tokens, lines })
			: JSON.stringify({ path: f.path, tokens: f.tokens });
	});
	return [...rollup, ...flat].join("\n");
}

function countLines(text) {
	if (typeof text !== "string" || text === "") return 0;
	return text.endsWith("\n")
		? text.split("\n").length - 1
		: text.split("\n").length;
}
