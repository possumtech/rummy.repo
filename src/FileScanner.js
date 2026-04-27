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
			// clobbered on the next scan. First-scan default is `archived`
			// so a 5000-file repo doesn't dump 400K tokens into context
			// before any work happens. The model navigates via the
			// `repo://overview` entry (registered below) and promotes
			// individual files to summarized/visible as needed.
			const visibility =
				constraint === "active" ? "visible" : entry?.visibility || "archived";

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

		// Write the navigable project overview. Lives at `repo://overview`,
		// visible by default. Lists root-level files + per-directory file
		// counts + active/readonly constraints + a four-line navigation
		// legend. Stays bounded regardless of repo size — the model uses
		// `<get path="dir/" preview/>` to drill in.
		await this.#store.set({
			runId,
			turn: currentTurn,
			path: "repo://overview",
			body: this.#renderOverview(projectPath, diskStats, constraints),
			state: "resolved",
			visibility: "visible",
			writer: "plugin",
		});
	}

	/**
	 * Build the body of `repo://overview` — a compact, navigable map of
	 * the project. Constant-ish in token cost regardless of repo size.
	 */
	#renderOverview(projectPath, diskStats, constraints) {
		const rootFiles = [];
		const dirCounts = new Map(); // top-level dir → file count

		for (const [relPath, info] of diskStats) {
			const slash = relPath.indexOf("/");
			if (slash === -1) {
				rootFiles.push({ path: relPath, ...info });
			} else {
				const dir = relPath.slice(0, slash);
				dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
			}
		}

		const lines = [];
		lines.push(`# ${projectPath} (${diskStats.size} files)`);
		lines.push("");

		if (rootFiles.length > 0) {
			lines.push("## Root files");
			rootFiles.toSorted((a, b) => a.path.localeCompare(b.path));
			for (const f of rootFiles.slice(0, 50)) {
				lines.push(`- ${f.path}`);
			}
			if (rootFiles.length > 50) {
				lines.push(`- ... ${rootFiles.length - 50} more`);
			}
			lines.push("");
		}

		if (dirCounts.size > 0) {
			lines.push("## Directories");
			const dirs = [...dirCounts.entries()].toSorted((a, b) => b[1] - a[1]);
			for (const [dir, count] of dirs) {
				lines.push(`- ${dir}/ — ${count} file${count === 1 ? "" : "s"}`);
			}
			lines.push("");
		}

		const activeFiles = [...constraints.entries()]
			.filter(([, vis]) => vis === "active")
			.map(([p]) => p);
		const readonlyFiles = [...constraints.entries()]
			.filter(([, vis]) => vis === "readonly")
			.map(([p]) => p);
		if (activeFiles.length > 0 || readonlyFiles.length > 0) {
			lines.push("## Constraints");
			if (activeFiles.length > 0) {
				lines.push(`- active: ${activeFiles.join(", ")}`);
			}
			if (readonlyFiles.length > 0) {
				lines.push(`- readonly: ${readonlyFiles.join(", ")}`);
			}
			lines.push("");
		}

		lines.push("## Navigate");
		lines.push(
			'- Skim a folder\'s symbols: <set path="dir/**" visibility="summarized"/>',
		);
		lines.push('- Read a specific file: <get path="dir/file.ext"/>');
		lines.push('- List a folder\'s files: <get path="dir/" preview/>');
		lines.push('- Search across files: <get path="**" preview>keyword</get>');
		lines.push(
			'- Demote when done: <set path="dir/**" visibility="archived"/>',
		);

		return lines.join("\n");
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
