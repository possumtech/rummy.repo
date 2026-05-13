import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mimetypeFromPath } from "./mimetype.js";

describe("mimetypeFromPath", () => {
	describe("textual", () => {
		it("markdown extensions", () => {
			assert.equal(mimetypeFromPath("README.md"), "text/markdown");
			assert.equal(mimetypeFromPath("foo.markdown"), "text/markdown");
		});

		it("javascript / typescript", () => {
			assert.equal(mimetypeFromPath("src/x.js"), "text/javascript");
			assert.equal(mimetypeFromPath("src/x.mjs"), "text/javascript");
			assert.equal(mimetypeFromPath("src/x.ts"), "text/typescript");
			assert.equal(mimetypeFromPath("src/x.tsx"), "text/typescript");
		});

		it("structured data", () => {
			assert.equal(mimetypeFromPath("package.json"), "application/json");
			assert.equal(mimetypeFromPath("data.xml"), "application/xml");
			assert.equal(mimetypeFromPath("config.yaml"), "application/yaml");
			assert.equal(mimetypeFromPath("config.yml"), "application/yaml");
			assert.equal(mimetypeFromPath("config.toml"), "application/toml");
		});

		it("shell + sql", () => {
			assert.equal(mimetypeFromPath("scripts/run.sh"), "application/x-sh");
			assert.equal(mimetypeFromPath("schema.sql"), "application/sql");
		});
	});

	describe("binary", () => {
		it("images", () => {
			assert.equal(mimetypeFromPath("docs/diagram.png"), "image/png");
			assert.equal(mimetypeFromPath("logo.jpg"), "image/jpeg");
			assert.equal(mimetypeFromPath("logo.JPEG"), "image/jpeg");
			assert.equal(mimetypeFromPath("icon.svg"), "image/svg+xml");
		});

		it("documents", () => {
			assert.equal(mimetypeFromPath("spec.pdf"), "application/pdf");
			assert.equal(mimetypeFromPath("archive.zip"), "application/zip");
		});

		it("audio + video", () => {
			assert.equal(mimetypeFromPath("song.mp3"), "audio/mpeg");
			assert.equal(mimetypeFromPath("video.mp4"), "video/mp4");
		});
	});

	describe("fallback", () => {
		it("unknown extension falls back to text/markdown", () => {
			assert.equal(mimetypeFromPath("foo.xyz123"), "text/markdown");
		});

		it("no extension falls back to text/markdown", () => {
			assert.equal(mimetypeFromPath("Makefile"), "text/markdown");
		});

		it("empty / null falls back to text/markdown", () => {
			assert.equal(mimetypeFromPath(""), "text/markdown");
			assert.equal(mimetypeFromPath(null), "text/markdown");
		});

		it("dotfile without extension falls back", () => {
			// .gitignore has no extension (the leading "." is the path,
			// not a suffix); fallback to engine default.
			assert.equal(mimetypeFromPath(".gitignore"), "text/markdown");
		});

		it("dot in directory but no file extension falls back", () => {
			assert.equal(mimetypeFromPath("./foo/bar"), "text/markdown");
			assert.equal(mimetypeFromPath("path.to/Makefile"), "text/markdown");
		});
	});

	describe("case insensitivity", () => {
		it("uppercase extensions resolve", () => {
			assert.equal(mimetypeFromPath("README.MD"), "text/markdown");
			assert.equal(mimetypeFromPath("DATA.JSON"), "application/json");
		});
	});
});
