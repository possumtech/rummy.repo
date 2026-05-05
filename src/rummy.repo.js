import FileScanner, { summarizeManifest } from "./FileScanner.js";
import ProjectContext from "./ProjectContext.js";

export default class RummyRepo {
	#core;
	#scanner = null;

	constructor(core) {
		this.#core = core;
		core.on("turn.started", this.#onTurnStarted.bind(this));

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

		// `log://turn_0/repo/manifest`. materializeContext dispatches log
		// entries by their action segment (the slug after `turn_N/`), so
		// onView("repo", ...) matches the action, not a scheme. We
		// deliberately don't register `repo://` as a public scheme —
		// it would compete with the bare-path file scheme and attract
		// accidental file-entry writes.
		//
		// Manifest body has two sections: directory rollup (summarized
		// projection) + flat file list (visible projection). When the
		// budget plugin demotes the manifest under context pressure,
		// the model gets the rollup — same shape, smaller cost. The
		// model can promote back via `<get path="log://turn_0/repo/manifest"/>`
		// to recover the comprehensive list.
		core.hooks.tools.onView("repo", (entry) => entry.body, "visible");
		core.hooks.tools.onView(
			"repo",
			(entry) => summarizeManifest(entry.body),
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
