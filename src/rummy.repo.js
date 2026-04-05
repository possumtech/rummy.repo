import { extname } from "node:path";
import Antlrmap from "@possumtech/antlrmap";
import CtagsExtractor from "./CtagsExtractor.js";
import formatSymbols from "./formatSymbols.js";

const antlrmapSupported = new Set(Object.keys(Antlrmap.extensions));

export default class RepoMapPlugin {
	constructor(core) {
		core.on("entry.changed", this.#onChanged.bind(this));
	}

	async #onChanged({ rummy, paths }) {
		const antlrmap = new Antlrmap();
		const ctagsQueue = [];

		for (const path of paths) {
			const ext = extname(path);
			if (!ext) continue;

			if (antlrmapSupported.has(ext)) {
				const body = await rummy.getBody(path);
				if (!body) continue;
				try {
					const symbols = await antlrmap.mapSource(body, ext);
					if (symbols?.length > 0) {
						await rummy.setAttributes(path, {
							symbols: formatSymbols(symbols),
						});
						continue;
					}
				} catch {
					// Fall through to ctags
				}
			}
			ctagsQueue.push(path);
		}

		if (ctagsQueue.length > 0) {
			const extractor = new CtagsExtractor(rummy.project.project_root);
			const ctagsResults = extractor.extract(ctagsQueue);
			for (const [path, symbols] of ctagsResults) {
				if (symbols.length > 0) {
					await rummy.setAttributes(path, { symbols: formatSymbols(symbols) });
				}
			}
		}
	}
}
