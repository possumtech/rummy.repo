import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import Antlrmap from "@possumtech/antlrmap";
import CtagsExtractor from "./CtagsExtractor.js";
import formatSymbols from "./formatSymbols.js";

const antlrmapSupported = new Set(Object.keys(Antlrmap.extensions));

/**
 * RepoMapPlugin: symbol extraction via antlrmap (ANTLR4 grammars)
 * with ctags fallback.
 *
 * Filter: hooks.file.symbols
 * Input:  Map (empty or partially populated)
 * Context: { paths, projectPath }
 *   - paths: string[] of relative file paths that changed
 *   - projectPath: string, absolute project root
 * Output: Map<string, symbol[]> where symbol = { name, kind?, params?, line?, endLine? }
 */
export default class RepoMapPlugin {
	static register(hooks) {
		hooks.file.symbols.addFilter(async (symbolMap, { paths, projectPath }) => {
			const result = symbolMap instanceof Map ? symbolMap : new Map();
			const antlrmap = new Antlrmap();
			const ctagsQueue = [];

			for (const relPath of paths) {
				if (result.has(relPath)) continue;
				const ext = extname(relPath);

				if (antlrmapSupported.has(ext)) {
					try {
						const content = readFileSync(join(projectPath, relPath), "utf8");
						const symbols = await antlrmap.mapSource(content, ext);
						if (symbols?.length > 0) {
							result.set(relPath, symbols);
							continue;
						}
					} catch {
						// Fall through to ctags
					}
				}
				ctagsQueue.push(relPath);
			}

			if (ctagsQueue.length > 0) {
				const extractor = new CtagsExtractor(projectPath);
				const ctagsResults = extractor.extract(ctagsQueue);
				for (const [path, symbols] of ctagsResults) {
					if (symbols.length > 0) result.set(path, symbols);
				}
			}

			return result;
		}, 50);
	}

	static formatSymbols = formatSymbols;
}
