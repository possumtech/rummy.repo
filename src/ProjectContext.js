import fs from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import GitProvider from "./GitProvider.js";

// Cache: path → { headHash, context } — git-mode only.
const cache = new Map();

// Directories never worth walking. Pruned at directory boundary so
// their contents don't get stat'd. .git is structural; node_modules
// is vendored bloat; dist/build/out/target are common build outputs.
// Any leading-dot directory (.venv, .cache, .pytest_cache, .idea,
// .vscode) is also pruned — these are tooling state, not project
// source.
const EXCLUDED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
]);

function isExcludedDir(name) {
	return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

// Walk the filesystem from `root`, returning a Set of file paths
// relative to `root`. Symlinks are skipped (not followed). Used as
// the no-git fallback for project discovery — a non-git project is
// still a project. Excludes mirror the spirit of `git ls-files`
// minus the explicit tracking: source over vendored/build/state.
async function fsWalk(root) {
	const tracked = new Set();
	await walkDir(root, "", tracked);
	return tracked;
}

async function walkDir(absDir, relDir, tracked) {
	const dirents = await fs.readdir(absDir, { withFileTypes: true });
	for (const dirent of dirents) {
		const name = dirent.name;
		if (dirent.isSymbolicLink()) continue;
		const childRel = relDir ? `${relDir}/${name}` : name;
		if (dirent.isDirectory()) {
			if (isExcludedDir(name)) continue;
			await walkDir(join(absDir, name), childRel, tracked);
		} else if (dirent.isFile()) {
			tracked.add(childRel);
		}
	}
}

export default class ProjectContext {
	#root;
	#isGit = false;
	#trackedFiles = new Set();
	#dbFiles = new Set();

	constructor(root, isGit, trackedFiles, dbFiles) {
		this.#root = root;
		this.#isGit = isGit;
		this.#trackedFiles = trackedFiles;
		this.#dbFiles = dbFiles;
	}

	static async open(path, dbFiles = new Set()) {
		const detectedRoot = await GitProvider.detectRoot(path);
		const isGit = detectedRoot !== null;

		// Reuse cached context if HEAD hasn't changed (git only — fs-walk
		// invalidation is a function of every file mtime, not worth the
		// bookkeeping until performance demands it).
		if (isGit) {
			const headHash = await GitProvider.getHeadHash(detectedRoot);
			const cached = cache.get(path);
			if (cached && cached.headHash === headHash) {
				return new ProjectContext(path, true, cached.trackedFiles, dbFiles);
			}

			const allTracked = await GitProvider.getTrackedFiles(detectedRoot);
			const trackedFiles = new Set();
			for (const f of allTracked) {
				const fullF = join(detectedRoot, f);
				const relToProject = relative(path, fullF);
				if (!relToProject.startsWith("..") && !isAbsolute(relToProject)) {
					trackedFiles.add(relToProject);
				}
			}

			cache.set(path, { headHash, trackedFiles });
			return new ProjectContext(path, true, trackedFiles, dbFiles);
		}

		const trackedFiles = await fsWalk(path);
		return new ProjectContext(path, false, trackedFiles, dbFiles);
	}

	async isInProject(relPath) {
		if (this.#dbFiles.has(relPath)) return true;
		if (this.#trackedFiles.has(relPath)) return true;
		return false;
	}

	get root() {
		return this.#root;
	}

	get isGit() {
		return this.#isGit;
	}

	async getMappableFiles() {
		const all = new Set(this.#trackedFiles);
		for (const path of this.#dbFiles) {
			all.add(path);
		}
		return Array.from(all);
	}
}
