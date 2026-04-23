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
			if (visibility === "active" && !mappableFiles.includes(pattern)) {
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

			if (entry?.body && this.#hooks?.hedberg?.generatePatch) {
				const diff = this.#hooks.hedberg.generatePatch(
					relPath,
					entry.body,
					content,
				);
				if (diff) {
					await this.#store.set({
						runId,
						turn: currentTurn,
						path: `set://${relPath}`,
						body: diff,
						state: "resolved",
						attributes: { path: relPath, external: true },
						writer: "plugin",
					});
				}
			}

			const constraint = matchConstraint(
				constraints,
				relPath,
				this.#hooks.hedberg.match,
			);
			// constraint=active → visible; otherwise preserve prior visibility
			// so the model's own <get> / <set visibility=...> changes aren't
			// clobbered on the next scan. First-scan default is summarized.
			const visibility =
				constraint === "active" ? "visible" : entry?.visibility || "summarized";

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
					path,
					attributes: { symbols: formatSymbols(symbols) },
					writer: "plugin",
				});
			}
		}

		for (const [relPath] of fileKeys) {
			await this.#store.rm({ runId, path: relPath, writer: "plugin" });
		}
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
