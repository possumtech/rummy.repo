import FileScanner from "./FileScanner.js";
import ProjectContext from "./ProjectContext.js";

export default class RummyRepo {
	#core;
	#scanner = null;

	constructor(core) {
		this.#core = core;
		core.on("turn.started", this.#onTurnStarted.bind(this));

		// `repo://` scheme — entries describing the project itself
		// (currently just `repo://overview`, the navigable tree summary).
		// `data` category puts it in the same projection family as files;
		// model_visible default = 1.
		core.registerScheme({ name: "repo", category: "data" });
		core.hooks.tools.onView("repo", (entry) => entry.body, "visible");
		core.hooks.tools.onView(
			"repo",
			(entry) => {
				// Summarized view: first ~12 lines of the overview, enough
				// to read top-level structure without the legend or dir
				// listings. Promote to visible to read the full tree.
				const body = entry.body || "";
				const lines = body.split("\n");
				if (lines.length <= 12) return body;
				return `${lines.slice(0, 12).join("\n")}\n[truncated — promote to see full overview]`;
			},
			"summarized",
		);

		core.hooks.tools.onView(
			"file",
			(entry) => {
				const attrs =
					typeof entry.attributes === "string"
						? JSON.parse(entry.attributes)
						: entry.attributes;
				return attrs?.symbols || "";
			},
			"summarized",
		);
	}

	async #onTurnStarted({ rummy }) {
		if (rummy.noRepo) return;
		const project = rummy.project;
		if (!project?.project_root) return;

		if (!this.#scanner) {
			this.#scanner = new FileScanner(
				rummy.entries,
				this.#core.db || rummy.db,
				this.#core.hooks,
			);
		}

		const ctx = await ProjectContext.open(project.project_root);
		const files = await ctx.getMappableFiles();
		await this.#scanner.scan(
			project.project_root,
			project.id,
			files,
			rummy.sequence,
		);
	}
}
