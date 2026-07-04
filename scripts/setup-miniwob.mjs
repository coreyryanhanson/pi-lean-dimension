#!/usr/bin/env node

/**
 * One-time setup script for MiniWoB++ test content (Step 4 of
 * `miniwob-integration-plan.md`).
 *
 * Clones `miniwob-plusplus` at the frozen commit pin and prints the
 * path the test suite expects. No-op when the target directory already
 * exists (idempotent).
 *
 * The test suite (`miniwob.test.ts`) and helpers
 * (`helpers/miniwob.ts`) default to
 * `/tmp/miniwob-plusplus/miniwob/html` as the HTML root.  Override
 * at test time via `MINIWOB_HTML_ROOT` (path to the html directory on
 * disk) or `MINIWOB_URL` (URL of an already-running HTTP server
 * serving the html directory).
 *
 * Usage:
 *   node scripts/setup-miniwob.mjs                          # default: /tmp/miniwob-plusplus
 *   MINIWOB_HTML_ROOT=/opt/miniwob node scripts/setup-miniwob.mjs  # custom path
 *   node scripts/setup-miniwob.mjs /custom/path             # positional override
 *
 * ── Attribution ────────────────────────────────────────────────
 *
 * MiniWoB++ © Farama-Foundation, Apache-2.0. Pinned commit:
 * miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ─── Config ──────────────────────────────────────────────────────

/** Pinned MiniWoB++ commit (matches the plan, helpers, and suite). */
const PINNED_COMMIT = "7fd85d71a4b60325c6585396ec4f48377d049838";

/** GitHub repository URL. */
const REPO_URL = "https://github.com/ServiceNow/miniwob-plusplus.git";

/** Default checkout root (matches the hardcoded default in helpers/miniwob.ts). */
const DEFAULT_ROOT = "/tmp/miniwob-plusplus";

// ─── Helpers ─────────────────────────────────────────────────────

function die(message) {
	console.error(`[setup-miniwob] ERROR: ${message}`);
	process.exit(1);
}

function info(message) {
	console.log(`[setup-miniwob] ${message}`);
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
	// Resolve target directory (env > positional > default)
	const envRoot = process.env.MINIWOB_HTML_ROOT;
	const positionalArg = process.argv[2];
	const checkoutRoot = resolve(positionalArg ?? envRoot ?? DEFAULT_ROOT);
	const htmlDir = join(checkoutRoot, "miniwob", "html");

	// ── Idempotency guard ────────────────────────────────────────
	if (existsSync(join(checkoutRoot, ".git"))) {
		info(
			`MiniWoB++ already cloned at ${checkoutRoot}. Nothing to do.\n` +
				`  HTML root: ${htmlDir}\n` +
				`  To re-clone, remove ${checkoutRoot} and re-run.`,
		);
		process.exit(0);
	}

	// ── Guard: if HTML root exists w/o .git (e.g. user placed it manually) ──
	if (existsSync(htmlDir)) {
		info(
			`HTML content already present at ${htmlDir} (no .git checkout). Nothing to do.\n` +
				`  Set MINIWOB_HTML_ROOT=${htmlDir} or leave the default if that matches.`,
		);
		process.exit(0);
	}

	// ── Clone ────────────────────────────────────────────────────
	info(`Cloning miniwob-plusplus into ${checkoutRoot} …`);
	mkdirSync(resolve(checkoutRoot, ".."), { recursive: true });

	try {
		execSync(`git clone ${REPO_URL} ${checkoutRoot}`, {
			stdio: "inherit",
			cwd: resolve(checkoutRoot, ".."),
		});
	} catch {
		die(`Failed to clone ${REPO_URL}. Check network or permissions.`);
	}

	// ── Checkout pinned commit ──────────────────────────────────
	info(`Checking out pinned commit ${PINNED_COMMIT} …`);
	try {
		execSync(`git checkout ${PINNED_COMMIT}`, {
			stdio: "inherit",
			cwd: checkoutRoot,
		});
	} catch {
		die(`Failed to checkout ${PINNED_COMMIT}.`);
	}

	// ── Confirm ─────────────────────────────────────────────────
	if (!existsSync(htmlDir)) {
		die(`Expected HTML root not found after clone: ${htmlDir}`);
	}

	info("Done. MiniWoB++ content ready at:");
	console.log(`  HTML root: ${htmlDir}`);
	console.log("");
	console.log("  The test suite uses this path by default.");
	console.log("  To customise at test time:");
	console.log(
		`    export MINIWOB_HTML_ROOT=${htmlDir}   # path to html directory`,
	);
	console.log(
		"    export MINIWOB_URL=http://…   # URL of an already-running server",
	);
}

main();
