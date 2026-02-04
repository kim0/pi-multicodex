#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sh(cmd, args, opts = {}) {
	return execFileSync(cmd, args, {
		stdio: "pipe",
		encoding: "utf8",
		...opts,
	});
}

function shInherit(cmd, args, opts = {}) {
	execFileSync(cmd, args, {
		stdio: "inherit",
		encoding: "utf8",
		...opts,
	});
}

function fail(message) {
	console.error(`\n[publish] ${message}`);
	process.exit(1);
}

function getPkg() {
	const pkgPath = path.join(process.cwd(), "package.json");
	const text = fs.readFileSync(pkgPath, "utf8");
	return JSON.parse(text);
}

function isCleanGit() {
	try {
		const out = sh("git", ["status", "--porcelain"]).trim();
		return out.length === 0;
	} catch {
		// Not a git repo or git not installed – ignore.
		return true;
	}
}

function normalizeVersionArg(arg) {
	if (!arg) return undefined;
	const v = String(arg).trim();
	if (!v) return undefined;
	return v.startsWith("v") ? v.slice(1) : v;
}

function npmVersionExists(pkgName, version) {
	try {
		sh("npm", ["view", `${pkgName}@${version}`, "version"]);
		return true;
	} catch {
		return false;
	}
}

function main() {
	const rawArgs = process.argv.slice(2);
	const dryRun = rawArgs.includes("--dry-run");
	const args = rawArgs.filter((a) => a !== "--dry-run");

	const requested = normalizeVersionArg(args[0]);

	if (!isCleanGit()) {
		fail("git working tree is not clean. Commit/stash first.");
	}

	const pkg = getPkg();
	if (!pkg?.name) fail("package.json is missing name");
	if (!pkg?.version) fail("package.json is missing version");

	console.log(`[publish] package: ${pkg.name}`);
	console.log(`[publish] current version (package.json): ${pkg.version}`);

	// 1) Bump version (writes package.json + package-lock.json)
	if (requested) {
		console.log(`[publish] setting version: ${requested}`);
		if (npmVersionExists(pkg.name, requested)) {
			fail(`version ${requested} already exists on npm for ${pkg.name}`);
		}
		shInherit("npm", ["version", requested, "--no-git-tag-version"]);
	} else {
		// Default: patch bump based on package.json version
		console.log("[publish] bumping patch version");
		// npm will choose the next patch based on the current package.json version.
		// If that version already exists on npm, publish will fail; we surface that.
		shInherit("npm", ["version", "patch", "--no-git-tag-version"]);
	}

	const bumped = getPkg();
	console.log(`[publish] new version: ${bumped.version}`);

	// Safety: ensure we didn't bump to something that exists already.
	if (npmVersionExists(bumped.name, bumped.version)) {
		fail(`version ${bumped.version} already exists on npm for ${bumped.name}`);
	}

	// 2) Run checks
	console.log("[publish] running checks (lint, tsgo, test)");
	shInherit("npm", ["run", "lint"]);
	shInherit("npm", ["run", "tsgo"]);
	shInherit("npm", ["run", "test"]);

	// 3) Verify tarball contents
	console.log("[publish] npm pack --dry-run");
	shInherit("npm", ["pack", "--dry-run"]);

	// 4) Publish
	if (dryRun) {
		console.log("[publish] npm publish --dry-run");
		shInherit("npm", ["publish", "--dry-run", "--access", "public"]);
		console.log("\n[publish] dry-run complete. No publish happened.");

		// Since we require a clean git tree at the start, it's safe to revert the
		// version bump for dry runs.
		try {
			shInherit("git", ["checkout", "--", "package.json", "package-lock.json"]);
			console.log("[publish] reverted version bump (dry-run)");
		} catch {
			// Not a git repo or git not available; leave the bumped files as-is.
		}
		return;
	}

	console.log("[publish] publishing to npm");
	shInherit("npm", ["publish", "--access", "public"]);

	console.log("\n[publish] published successfully.");
	console.log("[publish] next steps (recommended):");
	console.log(`  git add package.json package-lock.json`);
	console.log(`  git commit -m "release: v${bumped.version}"`);
	console.log(`  git tag v${bumped.version}`);
	console.log("  git push --follow-tags");
}

main();
