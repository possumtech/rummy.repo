import FileScanner from "./FileScanner.js";
import ProjectContext from "./ProjectContext.js";

export default class RummyRepo {
	#core;
	#scanner = null;

	constructor(core) {
		this.#core = core;
		core.on("turn.started", this.#onTurnStarted.bind(this));

		// `repo` scheme owns the project-level manifest entry (`repo://manifest`).
		// Catalog data so it lands in <index> alongside files and knowns.
		// Plugin-only: the manifest is engine-maintained orientation; model
		// writes to repo:// raise PermissionError and strike.
		core.registerScheme({
			name: "repo",
			category: "data",
			writableBy: ["plugin"],
		});

		// file tile in <index>: symbols if rummy.repo extracted any
		// (compact code outline); empty otherwise (envelope only — path
		// + token count). <index> is a catalog, not a content dump;
		// model retrieves the full body via `<get path=...>` which
		// reads entry.body directly and bypasses this view hook.
		core.hooks.tools.onView("file", (entry) => {
			const attrs =
				typeof entry.attributes === "string"
					? JSON.parse(entry.attributes)
					: entry.attributes;
			return attrs?.symbols ?? "";
		});
		// repo://manifest tile renders empty body in <index> — envelope
		// only. The full inventory is the compaction lifeline,
		// retrieved via `<get repo://manifest>` which reads entry.body
		// directly and bypasses this view hook.
		core.hooks.tools.onView("repo", () => "");

		// Mimetype-keyed view hooks: any entry tagged with these content
		// types flows through rummy.repo's handler regardless of scheme
		// (`known://`, `unknown://`, `https://`, bare-file paths,
		// `repo://manifest` rows — all of them). First-wins over the
		// scheme handler per rummy core SPEC #mimetype dispatch
		// precedence. The handler bodies are envelope-only today —
		// future enrichments (markdown TOC, JSON schema summary) attach
		// here without touching dispatch.
		core.hooks.tools.onViewByMimetype("text/markdown", () => "");
		core.hooks.tools.onViewByMimetype("application/json", () => "");
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
