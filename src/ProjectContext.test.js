import assert from "node:assert/strict";
import { dirname } from "node:path";
import { describe, it } from "node:test";
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

	it("opens a non-git directory", async () => {
		const ctx = await ProjectContext.open("/tmp");
		assert.equal(ctx.isGit, false);
		assert.equal(ctx.root, "/tmp");
	});

	it("returns empty mappable files for non-git directory", async () => {
		const ctx = await ProjectContext.open("/tmp");
		const files = await ctx.getMappableFiles();
		assert.ok(Array.isArray(files));
		assert.equal(files.length, 0);
	});

	it("caches context on repeated open with same HEAD", async () => {
		const ctx1 = await ProjectContext.open(repoRoot);
		const ctx2 = await ProjectContext.open(repoRoot);
		const files1 = await ctx1.getMappableFiles();
		const files2 = await ctx2.getMappableFiles();
		assert.deepEqual(files1, files2);
	});
});
