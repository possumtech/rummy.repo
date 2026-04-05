import assert from "node:assert/strict";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import GitProvider from "./GitProvider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

describe("GitProvider", () => {
	it("detects a git root from a path inside a repo", async () => {
		const root = await GitProvider.detectRoot(repoRoot);
		assert.ok(root);
		assert.equal(typeof root, "string");
	});

	it("returns null for a non-git path", async () => {
		const root = await GitProvider.detectRoot("/tmp");
		assert.equal(root, null);
	});

	it("returns tracked files for a git repo", async () => {
		const root = await GitProvider.detectRoot(repoRoot);
		if (!root) return;
		const files = await GitProvider.getTrackedFiles(root);
		assert.ok(files instanceof Set);
		assert.ok(files.size > 0);
		assert.ok(files.has("package.json") || files.has("README.md"));
	});

	it("returns empty set for non-git path", async () => {
		const files = await GitProvider.getTrackedFiles("/tmp");
		assert.ok(files instanceof Set);
		assert.equal(files.size, 0);
	});

	it("resolves HEAD hash for a git repo", async () => {
		const root = await GitProvider.detectRoot(repoRoot);
		if (!root) return;
		const hash = await GitProvider.getHeadHash(root);
		assert.ok(hash);
		assert.equal(typeof hash, "string");
		assert.ok(hash.length >= 7);
	});

	it("returns null HEAD hash for non-git path", async () => {
		const hash = await GitProvider.getHeadHash("/tmp");
		assert.equal(hash, null);
	});

	it("checks gitignore for tracked files", async () => {
		const root = await GitProvider.detectRoot(repoRoot);
		if (!root) return;
		const ignored = await GitProvider.isIgnored(root, "node_modules/foo.js");
		assert.equal(typeof ignored, "boolean");
	});

	it("returns false for non-ignored file", async () => {
		const root = await GitProvider.detectRoot(repoRoot);
		if (!root) return;
		const ignored = await GitProvider.isIgnored(root, "package.json");
		assert.equal(ignored, false);
	});
});
