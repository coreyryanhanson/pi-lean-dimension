#!/usr/bin/env node
/**
 * Publishes pi-lean-dimension from an isolated directory so that
 * bundledDependencies actually bundle (npm workspaces hoisting defeats
 * bundling at pack time — the isolated dir has no workspace, so deps
 * land in the package's own node_modules).
 *
 * Instead of npm install from registry, this copies the LOCAL workspace
 * packages directly. This means:
 *   • Dry-run works regardless of what's on npm.
 *   • The exact code being published is what gets bundled.
 *   • No semver-range or propagation-delay issues.
 *
 * Usage:
 *   node scripts/publish-dimension.mjs [--dry-run]
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DRY_RUN = process.argv.includes("--dry-run");
const PACKAGE_DIR = join("packages", "pi-lean-dimension");
const PORTAL_DIR = join("packages", "pi-lean-portal");
const SEARCH_DIR = join("packages", "pi-lean-search");

const PKG = JSON.parse(
	readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8"),
);
const BUNDLED_DEPS = PKG.bundledDependencies ?? [];
const VERSION = PKG.version;
const TMP = join(
	tmpdir(),
	`pi-publish-dimension-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

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

function cleanup() {
	if (existsSync(TMP)) {
		rmSync(TMP, { recursive: true, force: true });
	}
}

try {
	console.log(`\n=== Publishing ${PKG.name}@${VERSION} (isolated pack) ===\n`);

	// 1. Copy the dimension package to an isolated temp dir
	console.log(`Copying ${PACKAGE_DIR} → ${TMP}`);
	mkdirSync(TMP, { recursive: true });
	cpSync(PACKAGE_DIR, TMP, { recursive: true });

	// Copy LICENSE alongside (it's in files[] but npm only includes it if
	// present in the package dir at pack time; prepublishOnly doesn't work
	// because this script relocates the package to a temp dir).
	cpSync("LICENSE", join(TMP, "LICENSE"));

	// 2. Copy LOCAL workspace packages into the temp dir's node_modules.
	//    This bundles the exact code being published — not whatever is on npm.
	//    Works for dry-run, alpha, and stable release.
	console.log("\nCopying local workspace packages into node_modules...");

	const portalName = JSON.parse(
		readFileSync(join(PORTAL_DIR, "package.json"), "utf-8"),
	).name;
	const searchName = JSON.parse(
		readFileSync(join(SEARCH_DIR, "package.json"), "utf-8"),
	).name;

	const nodeModules = join(TMP, "node_modules");
	mkdirSync(nodeModules, { recursive: true });

	cpSync(PORTAL_DIR, join(nodeModules, portalName), { recursive: true });
	console.log(`  ✓ ${portalName} copied from workspace`);

	cpSync(SEARCH_DIR, join(nodeModules, searchName), { recursive: true });
	console.log(`  ✓ ${searchName} copied from workspace`);

	// 3. Install transitive deps (playwright, node-html-parser, turndown, etc.)
	//    that the bundled packages need at runtime.
	console.log("\nInstalling transitive dependencies for bundled packages...");
	run("npm install --omit=dev", { cwd: TMP });

	// 4. Verify bundled deps are in node_modules
	console.log("\nVerifying bundled dependencies are present...");
	for (const dep of BUNDLED_DEPS) {
		const depDir = join(nodeModules, dep);
		if (!existsSync(depDir)) {
			console.error(`❌ ERROR: ${dep} not found in node_modules after setup.`);
			console.error(
				`   This will produce a broken tarball with missing dependencies.`,
			);
			process.exit(1);
		}
		console.log(`  ✓ ${dep} present`);
	}

	// 5. Verify bundled deps will appear in the tarball
	console.log("\nVerifying tarball will contain bundled dependencies...");
	const packOutput = run("npm pack --dry-run 2>&1", { cwd: TMP, silent: true });
	const bundledSection = packOutput.split("Bundled Dependencies")[1] ?? "";
	for (const dep of BUNDLED_DEPS) {
		if (!bundledSection.includes(`npm notice ${dep}\n`)) {
			console.error(
				`❌ ERROR: ${dep} not listed as a bundled dependency in the tarball.`,
			);
			console.error("   Output:", packOutput);
			process.exit(1);
		}
		console.log(`  ✓ ${dep} listed as bundled`);
	}

	// 6. Verify extension entrypoints exist
	console.log("\nVerifying extension entrypoints exist in node_modules...");
	for (const extPath of PKG.pi?.extensions ?? []) {
		const resolved = join(TMP, extPath);
		if (!existsSync(resolved)) {
			console.error(`❌ ERROR: Extension entrypoint ${extPath} not found.`);
			console.error(`   Full path: ${resolved}`);
			process.exit(1);
		}
		console.log(`  ✓ ${extPath}`);
	}

	// 7. Publish (or dry-run)
	console.log("\n");
	if (DRY_RUN) {
		console.log(`[--dry-run] Would publish ${TMP} to npm`);
		console.log("[--dry-run] Verifying tarball contents:");
		run("npm pack", { cwd: TMP });
	} else {
		run("npm publish --access public", { cwd: TMP });
		console.log(`\n✅ Published ${PKG.name}@${VERSION} to npm`);
	}
} catch (_e) {
	// Re-throw to let the release script catch it
	throw _e;
} finally {
	cleanup();
}
