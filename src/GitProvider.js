import { execSync } from "node:child_process";
import fs from "node:fs";

let git;
try {
	git = await import("isomorphic-git");
} catch {
	git = null;
}

export default class GitProvider {
	static async detectRoot(path) {
		if (git) {
			try {
				return await git.findRoot({ fs, filepath: path });
			} catch {
				return null;
			}
		}
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

	static async getTrackedFiles(root) {
		if (git) {
			try {
				const files = await git.listFiles({ fs, dir: root, ref: "HEAD" });
				return new Set(files);
			} catch {
				return new Set();
			}
		}
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

	static async isIgnored(root, path) {
		if (git) {
			try {
				return await git.isIgnored({ fs, dir: root, filepath: path });
			} catch {
				return false;
			}
		}
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

	static async getHeadHash(root) {
		if (git) {
			try {
				return await git.resolveRef({ fs, dir: root, ref: "HEAD" });
			} catch {
				return null;
			}
		}
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
}
