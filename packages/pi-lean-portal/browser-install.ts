/**
 * Browser Install — `/web install` subcommand.
 *
 * The `playwright` npm package ships no browser binaries, and the generic
 * `npx playwright install` advice can resolve a different playwright copy
 * than the one the backends import — installing revisions the backends
 * don't match. This command resolves the *bundled* playwright CLI (the same
 * copy the backends use) and downloads engines from it, guaranteeing
 * revision parity.
 *
 * Forms:
 *   /web install            — checkbox dialog (TUI only; other modes print
 *                             the manual bundled-CLI command)
 *   /web install chromium   — direct download, no dialog (TUI + RPC spawn;
 *                             print/JSON modes print the manual command)
 *
 * Never throws: resolution, detection, and download failures all fall back
 * to printing a manual command. Removal is intentionally out of scope —
 * `playwright uninstall` takes no per-engine arguments and the cache
 * directory is machine-global; document the real CLI instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

// ─── Engines ─────────────────────────────────────────────────────

export const ENGINES = ["chromium", "firefox"] as const;
export type Engine = (typeof ENGINES)[number];

/** Rough per-engine download sizes, for the dialog rows. */
const ENGINE_SIZES = {
	chromium: "~170 MB",
	firefox: "~90 MB",
} as const;

// ─── Bundled playwright resolution ───────────────────────────────

export interface BundledPlaywright {
	/** The playwright module the backends import (same copy, same revisions). */
	pw: typeof import("playwright");
	/** Absolute path to the bundled playwright CLI entry. */
	cliJs: string;
	/** Node interpreter for spawning the CLI. */
	nodeExe: string;
}

/**
 * Node interpreter for spawning the bundled CLI. `process.execPath` is only
 * a Node binary under the npm-shim distribution; pi also ships a
 * bun-compiled standalone binary where `process.execPath` is the pi binary
 * itself — spawning it with playwright's args re-runs pi, not the CLI. The
 * `.exe` strip handles Windows (`...\node.exe` there); on POSIX the replace
 * is a no-op.
 */
export function resolveNodeInterpreter(): string {
	return basename(process.execPath).replace(/\.exe$/i, "") === "node"
		? process.execPath
		: "node";
}

/**
 * Resolve the bundled playwright module + CLI path. Throws if playwright is
 * missing entirely (corrupted install) — callers must catch and fall back to
 * the generic manual command. Must be called lazily (inside the command
 * handler), never at module top level: this module is imported by the `/web`
 * dispatcher, and a throwing top-level require would break the entire `/web`
 * command in exactly the corrupt-install scenario this command exists for.
 */
export function resolveBundledPlaywright(): BundledPlaywright {
	const req = createRequire(import.meta.url);
	const pw = req("playwright");
	// `playwright/package.json` is exported; `playwright/cli.js` is not —
	// resolving the CLI subpath directly throws ERR_PACKAGE_PATH_NOT_EXPORTED.
	const pkgDir = dirname(req.resolve("playwright/package.json"));
	return {
		pw,
		cliJs: join(pkgDir, "cli.js"),
		nodeExe: resolveNodeInterpreter(),
	};
}

// ─── Installed-browser detection (no launch) ─────────────────────

export interface BrowserDetection {
	chromium: boolean;
	firefox: boolean;
}

/**
 * Detect installed Node-backend browsers without launching. Unexpected
 * layouts degrade to `missing` — the safe direction, since re-running
 * install is harmless.
 */
export function detectInstalledBrowsers(
	pw: typeof import("playwright"),
): BrowserDetection {
	return { chromium: detectChromium(pw), firefox: detectFirefox(pw) };
}

/**
 * Chromium detection is keyed on the headless-shell binary, not the full
 * browser: portal launches headless, and headless launches use
 * `chromium_headless_shell-<rev>`, not the full `chromium-<rev>` binary that
 * `executablePath()` reports — keying on the full browser would report
 * "downloaded" in exactly the broken-cache scenario this command fixes
 * (full chromium present, shell missing).
 *
 * ponytail: the directory-name transform is a heuristic on the documented
 * cache layout (`chromium-<rev>/` ↔ `chromium_headless_shell-<rev>/`, same
 * parent); the shell revision comes from playwright-core's `browsers.json`,
 * not the chromium path, so the two may safely diverge. Correctness rests on
 * the `INSTALLATION_COMPLETE` marker (what `playwright install` writes as
 * its final step), which is immune to inner-layout renames. If playwright
 * renames the shell *directory*, detection degrades to "missing" (safe) —
 * resolve the shell directory through the registry only if that misfires.
 */
function detectChromium(pw: typeof import("playwright")): boolean {
	try {
		const exec = pw.chromium.executablePath();
		const revMatch = /([/\\])chromium-(\d+)[/\\]/.exec(exec);
		if (!revMatch) return false;
		let shellRev = revMatch[2];
		try {
			const req = createRequire(import.meta.url);
			const coreDir = dirname(req.resolve("playwright-core/package.json"));
			const browsers = JSON.parse(
				readFileSync(join(coreDir, "browsers.json"), "utf8"),
			) as { browsers: Array<{ name: string; revision: number | string }> };
			const entry = browsers.browsers.find(
				(b) => b.name === "chromium-headless-shell",
			);
			// Independent revision field from chromium's — read the shell's own,
			// fall back to the chromium revision if the read/entry fails.
			if (entry) shellRev = String(entry.revision);
		} catch {
			/* keep chromium-revision fallback */
		}
		const shellDir = exec.replace(
			/([/\\])chromium-\d+[/\\].*/,
			`$1chromium_headless_shell-${shellRev}`,
		);
		// replace() returning the input means the layout didn't match.
		return (
			shellDir !== exec && existsSync(join(shellDir, "INSTALLATION_COMPLETE"))
		);
	} catch {
		return false;
	}
}

/**
 * Firefox has no headless-shell split — one binary. Same
 * INSTALLATION_COMPLETE marker as chromium: a partial download that has
 * extracted the executable but not finished would otherwise false-report
 * "downloaded".
 */
function detectFirefox(pw: typeof import("playwright")): boolean {
	try {
		const exec = pw.firefox.executablePath();
		const dirMatch = /[/\\]firefox-\d+[/\\]/.exec(exec);
		if (!dirMatch) return false;
		return existsSync(
			join(
				exec.slice(0, dirMatch.index + dirMatch[0].length),
				"INSTALLATION_COMPLETE",
			),
		);
	} catch {
		return false;
	}
}

// ─── Manual-command fallback ─────────────────────────────────────

function manualCommand(bundled: BundledPlaywright, engines: Engine[]): string {
	return `Install: ${bundled.nodeExe} ${bundled.cliJs} install ${engines.join(" ")}`;
}

function genericManualCommand(): string {
	// Bundled path unresolvable — only the generic advice remains.
	return "Install: npx playwright install chromium firefox";
}

/**
 * Emit a manual-command fallback everywhere a feedback channel exists.
 * `notify` reaches the TUI and RPC clients but is a no-op in print/JSON
 * (their UI context is a no-op stub), where stderr is the only channel —
 * write there too so those modes still print the command.
 */
function emitManualCommand(ctx: ExtensionContext, msg: string): void {
	ctx.ui.notify(msg, "info");
	if (!ctx.hasUI) process.stderr.write(`${msg}\n`);
}

// ─── Checklist dialog (copied from pi-lean-host select-picker.ts) ─
//
// pi's ctx.ui.select is single-choice and portal must not depend on host,
// so pickChecklist is copied here. Keep the dialog rendering visually
// identical to the host copy via the shared pickerTheme shape; the
// behavioral deltas are intentional: an Install confirm row, pre-checked
// rows, and an empty-selection guard (host resolves empty as []). UX
// changes should propagate to
// packages/pi-lean-host/core/select-picker.ts.

/** Shared SelectList theme callbacks — keep both pickers visually identical. */
function pickerTheme(theme: { fg(color: string, text: string): string }) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

const INSTALL_VALUE = "__install__";
const INSTALL_TITLE = "🌐 Select browsers to install";

/**
 * Multi-select checklist: Enter toggles ✓/○, Enter on the Install row
 * resolves the checked values, Esc returns undefined. Confirming with
 * nothing checked notifies and keeps the dialog open. TUI-only — callers
 * must guard with `ctx.mode === "tui"`.
 */
export async function pickBrowsersToInstall(
	ctx: ExtensionContext,
	rows: SelectItem[],
	preChecked: string[],
): Promise<string[] | undefined> {
	const checked = new Set<string>(preChecked);
	return ctx.ui.custom<string[] | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		let selectedIndex = 0;
		let list = buildList();

		function buildList(): SelectList {
			const selectItems: SelectItem[] = rows.map((r) => ({
				...r,
				label: `${checked.has(r.value) ? "✓" : "○"} ${r.label}`,
			}));
			selectItems.push({
				value: INSTALL_VALUE,
				label: "Install — download the checked browsers",
			});
			const fresh = new SelectList(
				selectItems,
				Math.min(selectItems.length, 12),
				pickerTheme(theme),
			);
			fresh.setSelectedIndex(Math.min(selectedIndex, selectItems.length - 1));
			fresh.onSelectionChange = (item) => {
				const at = selectItems.findIndex((s) => s.value === item.value);
				if (at >= 0) selectedIndex = at;
			};
			fresh.onSelect = (item) => {
				if (item.value === INSTALL_VALUE) {
					if (checked.size === 0) {
						ctx.ui.notify(
							"Nothing selected — toggle a browser row first.",
							"warning",
						);
						return;
					}
					done([...checked]);
					return;
				}
				if (checked.has(item.value)) checked.delete(item.value);
				else checked.add(item.value);
				// Rebuild so the ✓/○ prefixes re-render; the highlight follows
				// the tracked index across the swap.
				container.removeChild(list);
				list = buildList();
				container.addChild(list);
				// addChild appends — keep the footer below the rebuilt list.
				container.removeChild(footer);
				container.addChild(footer);
			};
			fresh.onCancel = () => done(undefined);
			return fresh;
		}

		container.addChild(new Text(theme.fg("accent", theme.bold(INSTALL_TITLE))));
		container.addChild(list);
		const footer = new Text(
			theme.fg("dim", "↑↓ navigate • enter toggle/select • esc cancel"),
		);
		container.addChild(footer);
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ─── Spawn & stream ──────────────────────────────────────────────

/**
 * Run the bundled playwright CLI install for the given engines, streaming
 * output into a widget above the editor. Never throws — spawn errors and non-zero
 * exits notify with the manual command instead.
 */
async function runInstall(
	ctx: ExtensionContext,
	bundled: BundledPlaywright,
	engines: Engine[],
): Promise<void> {
	const manual = manualCommand(bundled, engines);
	await new Promise<void>((resolve) => {
		let out = "";
		const child = spawn(bundled.nodeExe, [bundled.cliJs, "install", ...engines], {
			stdio: "pipe",
		});
		// Bound the accumulated output: a long install must not grow memory
		// without limit or re-split the whole buffer per chunk. The tail is
		// enough — the host-validation warning is emitted near the end.
		const MAX_TAIL = 64 * 1024;
		// Show the last few download lines in a widget above the editor instead
		// of the status bar: full progress visibility without crowding the
		// footer. Piped (non-TTY) playwright prints a newline-terminated 10%-step
		// progress line, so plain line splitting is enough; \r is handled for
		// safety in case output shape changes.
		const WIDGET_LINES = 8;
		const tail = (chunk: Buffer) => {
			out = (out + chunk.toString()).slice(-MAX_TAIL);
			// ponytail: no progress-bar parsing — playwright's output format is
			// not a stable API; the raw tail lines are enough.
			const lines = out.trimEnd().split(/\r\n|\r|\n/);
			ctx.ui.setWidget("install", [
				`⬇ Installing ${engines.join(", ")}…`,
				...lines.slice(-WIDGET_LINES).map((l) => `  ${l.trim().slice(0, 120)}`),
			]);
		};
		child.stdout?.on("data", tail);
		child.stderr?.on("data", tail);
		// Node can fire both `error` and `close` for one failed spawn — settle
		// once so the user gets a single notification.
		let settled = false;
		const finish = (notifyMsg: string, type: "info" | "warning") => {
			if (settled) return;
			settled = true;
			ctx.ui.setWidget("install", undefined);
			ctx.ui.notify(notifyMsg, type);
			resolve();
		};
		child.on("error", (err) => {
			// ENOENT, non-Node runtime with no `node` on PATH, etc.
			finish(`Browser install failed: ${err.message}\n${manual}`, "warning");
		});
		child.on("close", (code) => {
			if (code === 0) {
				let msg = `✅ Installed: ${engines.join(", ")}`;
				// The multi-line host-validation warning scrolls past in status
				// text on exactly the fresh-Linux-host case where it matters —
				// surface it in the completion notify instead. Still no
				// --with-deps (needs root/apt): the warning names the exact
				// install-deps command.
				if (out.includes("Playwright Host validation warning")) {
					msg +=
						"\n⚠ Playwright reported missing host dependencies — run the install-deps command it printed (needs root).";
				}
				finish(msg, "info");
			} else {
				finish(`Browser install failed (exit code ${code}).\n${manual}`, "warning");
			}
		});
	});
}

// ─── Handler ─────────────────────────────────────────────────────

/**
 * Handle the `/web install` subcommand.
 *
 * @param sub The text after "install" ("" | "chromium" | "firefox")
 */
export async function handleInstallSubcommand(
	sub: string,
	ctx: ExtensionContext,
): Promise<void> {
	const arg = sub.trim().toLowerCase();
	const direct: Engine[] | null =
		arg === "chromium" || arg === "firefox" ? [arg] : null;
	if (arg !== "" && !direct) {
		ctx.ui.notify(
			`Unknown install sub-command: "${arg}". Usage: /web install [chromium|firefox]`,
			"warning",
		);
		return;
	}

	// Lazy resolution — see resolveBundledPlaywright. On failure the bundled
	// path doesn't exist to print, so only the generic command remains.
	let bundled: BundledPlaywright;
	try {
		bundled = resolveBundledPlaywright();
	} catch {
		emitManualCommand(ctx, genericManualCommand());
		return;
	}

	if (direct) {
		// Direct form: spawn wherever a feedback channel exists — TUI and RPC
		// (notify reaches the RPC client, so at least the completion message is
		// observable); in print/JSON they're no-ops and the ~170 MB download
		// would appear to hang, so print the manual command instead.
		if (ctx.hasUI) {
			await runInstall(ctx, bundled, direct);
		} else {
			emitManualCommand(ctx, manualCommand(bundled, direct));
		}
		return;
	}

	// Bare form: dialog in TUI only; every other mode (RPC included — the
	// checklist dialog does not exist outside TUI) prints the manual command.
	if (ctx.mode !== "tui") {
		emitManualCommand(ctx, manualCommand(bundled, [...ENGINES]));
		return;
	}

	// The dialog always opens, even when detection reports both downloaded:
	// it cannot see a corrupted binary behind a valid-looking cache marker,
	// so a forced redownload must stay reachable (downloaded rows are
	// toggleable; missing ones come pre-checked).
	const detection = detectInstalledBrowsers(bundled.pw);
	const rows: SelectItem[] = ENGINES.map((engine) => ({
		value: engine,
		label: `${engine === "chromium" ? "Chromium" : "Firefox"} (${ENGINE_SIZES[engine]}) — ${detection[engine] ? "downloaded" : "missing"}`,
	}));
	const preChecked = ENGINES.filter((e) => !detection[e]);

	const checked = await pickBrowsersToInstall(ctx, rows, preChecked);
	if (checked === undefined) return; // Esc — user cancelled
	if (checked.length === 0) return; // guarded in the dialog; defensive no-op
	await runInstall(ctx, bundled, checked as Engine[]);
}
