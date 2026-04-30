import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ProjectContext from "./ProjectContext.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

describe("ProjectContext", () => {
	it("opens a git-backed project", async () => {
		const ctx = await ProjectContext.open(repoRoot);
		assert.ok(ctx);
		assert.equal(ctx.isGit, true);
		assert.equal(ctx.root, repoRoot);
	});

	it("returns mappable files from git", async () => {
		const ctx = await ProjectContext.open(repoRoot);
		const files = await ctx.getMappableFiles();
		assert.ok(Array.isArray(files));
		assert.ok(files.length > 0);
		assert.ok(files.includes("package.json") || files.includes("README.md"));
	});

	it("includes dbFiles in mappable output", async () => {
		const dbFiles = new Set(["extra/injected.txt"]);
		const ctx = await ProjectContext.open(repoRoot, dbFiles);
		const files = await ctx.getMappableFiles();
		assert.ok(files.includes("extra/injected.txt"));
	});

	it("reports tracked file as in project", async () => {
		const ctx = await ProjectContext.open(repoRoot);
		const files = await ctx.getMappableFiles();
		if (files.length > 0) {
			const inProject = await ctx.isInProject(files[0]);
			assert.equal(inProject, true);
		}
	});

	it("reports unknown file as not in project", async () => {
		const ctx = await ProjectContext.open(repoRoot);
		const inProject = await ctx.isInProject("nonexistent/file.xyz");
		assert.equal(inProject, false);
	});

	it("caches context on repeated open with same HEAD", async () => {
		const ctx1 = await ProjectContext.open(repoRoot);
		const ctx2 = await ProjectContext.open(repoRoot);
		const files1 = await ctx1.getMappableFiles();
		const files2 = await ctx2.getMappableFiles();
		assert.deepEqual(files1, files2);
	});

	describe("non-git fs-walk", () => {
		let root;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "rummy_repo_pc_"));
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("walks a non-git directory and discovers files", async () => {
			writeFileSync(join(root, "README.md"), "# Project\n");
			writeFileSync(join(root, "main.js"), "export const x = 1;\n");
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "src", "a.js"), "export const a = 'a';\n");
			writeFileSync(join(root, "src", "b.js"), "export const b = 'b';\n");

			const ctx = await ProjectContext.open(root);
			assert.equal(ctx.isGit, false);
			assert.equal(ctx.root, root);

			const files = await ctx.getMappableFiles();
			assert.deepEqual(files.toSorted(), [
				"README.md",
				"main.js",
				"src/a.js",
				"src/b.js",
			]);
		});

		it("excludes node_modules / dist / build / out / target / .git", async () => {
			writeFileSync(join(root, "keep.js"), "");
			for (const dir of [
				".git",
				"node_modules",
				"dist",
				"build",
				"out",
				"target",
			]) {
				mkdirSync(join(root, dir));
				writeFileSync(join(root, dir, "ignored.js"), "");
			}

			const ctx = await ProjectContext.open(root);
			const files = await ctx.getMappableFiles();
			assert.deepEqual(files, ["keep.js"]);
		});

		it("excludes leading-dot directories (tooling state)", async () => {
			writeFileSync(join(root, "keep.js"), "");
			for (const dir of [".venv", ".cache", ".idea", ".vscode"]) {
				mkdirSync(join(root, dir));
				writeFileSync(join(root, dir, "ignored.txt"), "");
			}

			const ctx = await ProjectContext.open(root);
			const files = await ctx.getMappableFiles();
			assert.deepEqual(files, ["keep.js"]);
		});

		it("includes leading-dot files at root (e.g. .gitignore, .env.example)", async () => {
			writeFileSync(join(root, ".gitignore"), "node_modules\n");
			writeFileSync(join(root, ".env.example"), "FOO=bar\n");
			writeFileSync(join(root, "main.js"), "");

			const ctx = await ProjectContext.open(root);
			const files = await ctx.getMappableFiles();
			assert.deepEqual(files.toSorted(), [
				".env.example",
				".gitignore",
				"main.js",
			]);
		});

		it("does not follow symlinks", async () => {
			writeFileSync(join(root, "real.js"), "");
			const outside = mkdtempSync(join(tmpdir(), "rummy_repo_outside_"));
			try {
				writeFileSync(join(outside, "leak.txt"), "do not follow");
				symlinkSync(outside, join(root, "linked"));
				symlinkSync(join(outside, "leak.txt"), join(root, "leaked-file.txt"));

				const ctx = await ProjectContext.open(root);
				const files = await ctx.getMappableFiles();
				assert.deepEqual(files, ["real.js"]);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});

		it("recurses through nested directories without excluded ancestors", async () => {
			mkdirSync(join(root, "a", "b", "c"), { recursive: true });
			writeFileSync(join(root, "a", "b", "c", "deep.js"), "");

			const ctx = await ProjectContext.open(root);
			const files = await ctx.getMappableFiles();
			assert.deepEqual(files, ["a/b/c/deep.js"]);
		});

		it("non-git project still includes dbFiles", async () => {
			writeFileSync(join(root, "real.js"), "");
			const dbFiles = new Set(["virtual/from-db.txt"]);

			const ctx = await ProjectContext.open(root, dbFiles);
			const files = await ctx.getMappableFiles();
			assert.deepEqual(files.toSorted(), ["real.js", "virtual/from-db.txt"]);
		});

		it("isInProject returns true for fs-walked files", async () => {
			writeFileSync(join(root, "discovered.js"), "");

			const ctx = await ProjectContext.open(root);
			assert.equal(await ctx.isInProject("discovered.js"), true);
			assert.equal(await ctx.isInProject("nonexistent.js"), false);
		});
	});
});
