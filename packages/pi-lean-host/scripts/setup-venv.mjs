#!/usr/bin/env node

/**
 * One-time setup script for the dedicated BrowserGym venv
 * (`browsergym-migration-plan-v2.md` §1.7).
 *
 * Creates `packages/pi-lean-host/venv/` (gitignored) and installs
 * the pinned `browsergym-miniwob` + `playwright` from
 * `packages/pi-lean-host/requirements.txt`. Isolated from the
 * portal's `chromium-py` / `firefox-py` venv so browsergym's own
 * `playwright==1.44` pin + gymnasium/numpy don't collide with
 * those backends' deps.
 *
 * Also attempts `playwright install chromium` inside the venv so
 * Mode B (host-owns-browser) has a browser to launch. This step is
 * NON-FATAL — Mode A (plugin-owns-browser) attaches via CDP to a
 * Node-launched Chromium and never starts the venv's own browser, so
 * a download failure (offline CI, blocked CDN) only disables Mode B.
 *
 * Usage:
 *   npm run setup:venv -w pi-lean-host
 *   node packages/pi-lean-host/scripts/setup-venv.mjs
 *
 * Idempotent: re-running upgrades/reinstalls to match requirements.txt.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_PKG_DIR = resolve(__dirname, "..");
const VENV_DIR = join(HOST_PKG_DIR, "venv");
const VENV_PYTHON = join(VENV_DIR, "bin", "python3");
const REQUIREMENTS = join(HOST_PKG_DIR, "requirements.txt");

function info(msg) {
	console.log(`[setup-venv] ${msg}`);
}

function die(msg) {
	console.error(`[setup-venv] ERROR: ${msg}`);
	process.exit(1);
}

function run(cmd, opts = {}) {
	info(`$ ${cmd}`);
	try {
		execSync(cmd, { stdio: "inherit", cwd: HOST_PKG_DIR, ...opts });
	} catch (err) {
		throw new Error(
			`Command failed: ${cmd}\n${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function main() {
	if (!existsSync(REQUIREMENTS)) {
		die(`requirements.txt not found at ${REQUIREMENTS}`);
	}

	const basePython = process.env.PI_LEAN_HOST_VENV_BASE_PYTHON ?? "python3";

	// 1. Create the venv if absent.
	if (!existsSync(VENV_PYTHON)) {
		info(`Creating venv at ${VENV_DIR} (base interpreter: ${basePython}) …`);
		try {
			run(`${basePython} -m venv ${VENV_DIR}`);
		} catch {
			die(
				`Failed to create venv at ${VENV_DIR} using '${basePython}'. ` +
					`Check it is a working Python 3.10–3.12 interpreter ` +
					`(browsergym's pinned greenlet does not build on 3.13+). ` +
					`Override with PI_LEAN_HOST_VENV_BASE_PYTHON.`,
			);
		}
	} else {
		info(
			`venv already exists at ${VENV_DIR} — upgrading deps to match requirements.txt.`,
		);
	}

	// 2. Install / upgrade requirements.
	info(`Installing requirements from ${REQUIREMENTS} …`);
	try {
		run(`${VENV_PYTHON} -m pip install --upgrade pip`);
		run(`${VENV_PYTHON} -m pip install -r ${REQUIREMENTS}`);
	} catch {
		die(`Failed to install requirements. See pip output above.`);
	}

	// 3. Install the Playwright Chromium browser for the venv (Mode B only).
	//    Mode A (plugin-owns-browser) attaches via CDP to a Node-launched
	//    Chromium and never launches the venv's own browser, so this step is
	//    NON-FATAL — a download failure (offline CI, blocked CDN) just means
	//    Mode B is unavailable until it's run manually.
	info(`Installing Playwright Chromium into the venv (Mode B; non-fatal) …`);
	try {
		run(`${VENV_PYTHON} -m playwright install chromium`);
	} catch (err) {
		console.warn(
			`[setup-venv] WARNING: Playwright Chromium install failed ` +
				`(Mode B unavailable until resolved). Mode A still works.\n` +
				(err instanceof Error ? err.message : String(err)),
		);
	}

	info("Done. BrowserGym venv ready at:");
	console.log(`  venv python: ${VENV_PYTHON}`);
	console.log("  The adapter resolves this path automatically; set");
	console.log("  PI_LEAN_HOST_VENV_PYTHON to override.");
}

main();
