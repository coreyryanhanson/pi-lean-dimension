#!/usr/bin/env node
/**
 * Release script for pi-lean-portal monorepo
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Before running:
 *   Draft [Unreleased] entries in CHANGELOG.md.
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Warn if [Unreleased] section is empty
 * 3. Bump version via npm run version:xxx (lockstep across all packages)
 * 4. Promote root CHANGELOG: [Unreleased] -> [version] - date
 * 5. Commit and tag
 * 6. Publish to npm (portal + search via workspace; dimension via isolated pack)
 * 7. Reinstate [Unreleased] section in CHANGELOG
 * 8. Commit the [Unreleased] reinstatement
 * 9. Push main + tag
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (
	!RELEASE_TARGET ||
	(!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))
) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			stdio: options.silent ? "pipe" : "inherit",
			...options,
		});
	} catch (_e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	try {
		const pkg = JSON.parse(
			readFileSync("packages/pi-lean-portal/package.json", "utf-8"),
		);
		return pkg.version;
	} catch (e) {
		console.error(
			`Error reading packages/pi-lean-portal/package.json: ${e.message}`,
		);
		process.exit(1);
	}
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", {
		silent: true,
	});
	const paths = [
		...new Set(
			(output || "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	if (paths.length === 0) return;
	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	if (compareVersions(target, currentVersion) <= 0) {
		console.error(
			`Error: explicit version ${target} must be greater than current version ${currentVersion}.`,
		);
		process.exit(1);
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		`npm version ${target} -ws --no-git-tag-version && node scripts/sync-versions.js && npx shx rm -rf node_modules packages/*/node_modules package-lock.json && npm install`,
	);
	return getVersion();
}

const ROOT_CHANGELOG = "CHANGELOG.md";

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const content = readFileSync(ROOT_CHANGELOG, "utf-8");

	if (!content.includes("## [Unreleased]")) {
		console.log(`  Skipping ${ROOT_CHANGELOG}: no [Unreleased] section`);
		return;
	}

	const updated = content.replace(
		"## [Unreleased]",
		`## [${version}] - ${date}`,
	);
	writeFileSync(ROOT_CHANGELOG, updated);
	console.log(`  Updated ${ROOT_CHANGELOG}`);
}

// Insert "## [Unreleased]" above the first "## [" heading
function addUnreleasedSection() {
	const content = readFileSync(ROOT_CHANGELOG, "utf-8");
	const updated = content.replace(/^(## \[)/m, "## [Unreleased]\n\n$1");
	writeFileSync(ROOT_CHANGELOG, updated);
	console.log(`  Added [Unreleased] to ${ROOT_CHANGELOG}`);
}

function getUnreleasedBody(changelogPath) {
	const content = readFileSync(changelogPath, "utf-8");
	const start = content.indexOf("## [Unreleased]");
	if (start === -1) return null;
	const after = content.slice(start + "## [Unreleased]".length);
	const nextHeader = after.search(/^## \[/m);
	const body = nextHeader === -1 ? after : after.slice(0, nextHeader);
	return body;
}

function hasUnreleasedEntries() {
	const body = getUnreleasedBody(ROOT_CHANGELOG);
	if (body && /^- /m.test(body)) return true;
	return false;
}

// Main
console.log("\n=== pi-lean-portal Release ===\n");

console.log("Reminder: draft [Unreleased] entries before releasing.\n");

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status?.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

console.log("Checking [Unreleased] section...");
if (hasUnreleasedEntries()) {
	console.log("  The [Unreleased] section has entries\n");
} else {
	console.log("  Warning: the [Unreleased] section is empty.");
	console.log(
		"  Proceeding — this is valid for a no-user-visible-change lockstep bump.\n",
	);
}

console.log("Running test suite...");
run("npm test");
console.log();

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

console.log("Promoting [Unreleased] to release version...");
updateChangelogsForRelease(version);
console.log();

console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Publishing to npm...\n");

console.log("  Publishing portal + search + host (targeted workspaces)...");
run(
	"npm publish -w packages/pi-lean-portal -w packages/pi-lean-search -w packages/pi-lean-host --access public",
);
console.log();

console.log(
	"  Publishing dimension (isolated pack for bundledDependencies)...",
);
run("node scripts/publish-dimension.mjs");
console.log();

console.log("Reinstating [Unreleased] section for next cycle...");
addUnreleasedSection();
console.log();

console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
