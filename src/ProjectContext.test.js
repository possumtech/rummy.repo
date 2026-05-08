import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	describe("non-git", () => {
		let root;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "rummy_repo_pc_"));
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("opens with no tracked files (no fs-walk fallback)", async () => {
			writeFileSync(join(root, "README.md"), "# Project\n");
			writeFileSync(join(root, "main.js"), "");

			const ctx = await ProjectContext.open(root);
			assert.equal(ctx.isGit, false);
			assert.equal(ctx.root, root);
			assert.deepEqual(await ctx.getMappableFiles(), []);
			assert.equal(await ctx.isInProject("README.md"), false);
			assert.equal(await ctx.isInProject("main.js"), false);
		});

		it("dbFiles is the sole authority for membership in non-git mode", async () => {
			writeFileSync(join(root, "on-disk.js"), "");
			const dbFiles = new Set(["virtual/from-db.txt"]);

			const ctx = await ProjectContext.open(root, dbFiles);
			assert.deepEqual(await ctx.getMappableFiles(), ["virtual/from-db.txt"]);
			assert.equal(await ctx.isInProject("virtual/from-db.txt"), true);
			assert.equal(await ctx.isInProject("on-disk.js"), false);
		});
	});
});
