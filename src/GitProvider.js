import { execSync } from "node:child_process";
import fs from "node:fs";

let git = null;
let gitChecked = false;

async function getIsomorphicGit() {
	if (gitChecked) return git;
	gitChecked = true;
	try {
		git = await import("isomorphic-git");
	} catch {
		git = null;
	}
	return git;
}

function hasCliGit() {
	try {
		execSync("git --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const cliAvailable = hasCliGit();

export default class GitProvider {
	static async detectRoot(path) {
		if (cliAvailable) {
			try {
				return execSync("git rev-parse --show-toplevel", {
					cwd: path,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
			} catch {
				return null;
			}
		}
		const iso = await getIsomorphicGit();
		if (iso) {
			try {
				return await iso.findRoot({ fs, filepath: path });
			} catch {
				return null;
			}
		}
		return null;
	}

	static async getTrackedFiles(root) {
		if (cliAvailable) {
			try {
				const output = execSync("git ls-files", {
					cwd: root,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				return new Set(output ? output.split("\n") : []);
			} catch {
				return new Set();
			}
		}
		const iso = await getIsomorphicGit();
		if (iso) {
			try {
				const files = await iso.listFiles({ fs, dir: root, ref: "HEAD" });
				return new Set(files);
			} catch {
				return new Set();
			}
		}
		return new Set();
	}

	static async isIgnored(root, path) {
		if (cliAvailable) {
			try {
				execSync(`git check-ignore -q "${path}"`, {
					cwd: root,
					stdio: ["pipe", "pipe", "pipe"],
				});
				return true;
			} catch {
				return false;
			}
		}
		const iso = await getIsomorphicGit();
		if (iso) {
			try {
				return await iso.isIgnored({ fs, dir: root, filepath: path });
			} catch {
				return false;
			}
		}
		return false;
	}

	static async getHeadHash(root) {
		if (cliAvailable) {
			try {
				return execSync("git rev-parse HEAD", {
					cwd: root,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
			} catch {
				return null;
			}
		}
		const iso = await getIsomorphicGit();
		if (iso) {
			try {
				return await iso.resolveRef({ fs, dir: root, ref: "HEAD" });
			} catch {
				return null;
			}
		}
		return null;
	}
}
