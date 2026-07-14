#!/usr/bin/env node

/**
 * Preflight gate for `npm run test:miniwob`.
 *
 * Ensures MiniWoB++ test content is available before invoking vitest.
 * If content is absent, prints a loud error and exits non-zero so the
 * test run never silently skips all 130 tasks.
 *
 * Design points:
 * - Fast: only `existsSync` + env var checks, no subprocess or network.
 * - Fails hard when someone explicitly asks for MiniWoB tests but
 *   hasn't set up the content. This prevents a lazy agent (or dev)
 *   from seeing a green exit with 130 skipped tests and moving on.
 * - CI is unaffected because CI runs `setup:miniwob` before
 *   `test:miniwob` in its workflow.
 * - `npm test` / `npm run test:ci` are unaffected (bench is excluded).
 *
 * Exit codes:
 *   0 — content is available (or MINIWOB_URL is set)
 *   1 — content missing on disk and no MINIWOB_URL
 *
 * @module
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────

const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function loud(msg) {
	console.error(`${RED}${BOLD}${msg}${RESET}`);
}

function info(msg) {
	console.error(`  ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────

function main() {
	// If an external URL is set, the content could be anywhere — trust the user.
	if (process.env.MINIWOB_URL) {
		console.error(
			"[miniwob-preflight] MINIWOB_URL is set — skipping content check.",
		);
		process.exit(0);
	}

	const htmlRoot =
		process.env.MINIWOB_HTML_ROOT ?? "/tmp/miniwob-plusplus/miniwob/html";
	const resolved = resolve(htmlRoot);

	if (existsSync(resolved)) {
		console.error(`[miniwob-preflight] MiniWoB++ content found at ${resolved}`);
		process.exit(0);
	}

	// ── Content missing — fail hard ────────────────────────────
	console.error(""); // blank line for separation
	loud("╔══════════════════════════════════════════════════════════════╗");
	loud("║  ✗  MiniWoB++ content not found!                         ║");
	loud("╚══════════════════════════════════════════════════════════════╝");
	console.error("");
	info("The MiniWoB++ evaluation harness needs test fixtures that are");
	info("cloned from an external repository. They are not bundled with");
	info("this project.");
	console.error("");
	info("Checked path:");
	info(`  ${resolved}`);
	console.error("");
	info("To download the content, run:");
	info("");
	info(`  ${BOLD}npm run setup:miniwob${RESET}`);
	info("");
	info("Or point to an existing checkout or running server:");
	info(`  export MINIWOB_HTML_ROOT=/path/to/miniwob/html`);
	info(`  export MINIWOB_URL=http://localhost:8080`);
	info("");
	info("Then re-run:");
	info(`  ${BOLD}npm run test:miniwob${RESET}`);
	console.error("");

	process.exit(1);
}

main();
