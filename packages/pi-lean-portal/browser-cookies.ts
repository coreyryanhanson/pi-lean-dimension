/**
 * Browser Cookies management.
 *
 * Provides the `/web cookies` subcommand handler: inspecting and clearing
 * session cookies via the router, and importing a Netscape cookies.txt
 * export into the active profile (`import [file]` — from a file path, or
 * pasted into a TUI editor dialog when the argument is omitted).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as router from "./core/router.js";
import { pluginRegistry } from "./core/plugin-registry.js";
import { loadFullConfig } from "./core/plugin-config.js";
import { taskId } from "./core/shared/task-id.js";
import { sessionManager } from "./core/shared/session-manager.js";
import {
	liftSecurityAttributes,
	MAX_COOKIE_IMPORT_BYTES,
	MAX_COOKIE_IMPORT_MB,
	parseCookiesTxt,
	restorePastedTabs,
} from "./core/shared/cookie-import.js";
import {
	mergeProfilePrecedence,
	resolveActiveProfile,
} from "./core/profile-resolution.js";
import {
	getProfileLabel,
	loadStorageState,
	probeStorageState,
	saveStorageState,
} from "./core/shared/storage-state.js";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── Handler ─────────────────────────────────────────────────────

/**
 * Handle the `/web cookies` subcommand.
 *
 * @param sub  The case-preserved sub-command text after "cookies"
 *             (e.g. "", "list", "clear --confirm", "import /path/to/file")
 * @param ctx  The extension context (for UI notifications)
 * @param conversationDefaultProfile  The conversation default profile set via
 *             `/web profile <name>`, passed in so the handler reads
 *             browser-toggle's module state without importing it.
 */
export async function handleCookiesSubcommand(
	sub: string,
	ctx: ExtensionContext,
	conversationDefaultProfile: string | undefined,
): Promise<void> {
	// Keywords are case-insensitive; the payload (import file path) keeps its case.
	const kw = sub.toLowerCase();
	if (kw === "" || kw === "list") {
		const result = await router.getCookies(taskId(ctx));
		if (!result.success) {
			ctx.ui.notify(
				`Failed to get cookies: ${result.error ?? "unknown error"}`,
				"warning",
			);
			return;
		}
		if (result.cookies.length === 0) {
			ctx.ui.notify("No cookies found for the current session.", "info");
			return;
		}
		// Format cookies
		const lines = [`Found ${result.cookies.length} cookie(s):`, ""];
		for (const c of result.cookies) {
			const flags = [
				c.httpOnly ? "HttpOnly" : "",
				c.secure ? "Secure" : "",
				c.sameSite || "",
			]
				.filter(Boolean)
				.join(" ");
			const expires =
				c.expires && c.expires > 0
					? new Date(c.expires * 1000).toISOString()
					: "Session";
			lines.push(
				`  ${c.name}=${c.value.slice(0, 80)}${c.value.length > 80 ? "…" : ""}`,
			);
			lines.push(`    Domain: ${c.domain ?? "?"}  Path: ${c.path ?? "/"}`);
			lines.push(`    Expires: ${expires}  ${flags}`.trimEnd());
			lines.push("");
		}
		ctx.ui.notify(lines.join("\n"), "info");
	} else if (kw === "clear" || kw === "clear --confirm") {
		if (kw === "clear") {
			ctx.ui.notify(
				"⚠ This will clear ALL cookies for the current session.\n" +
					"  Run /web cookies clear --confirm to proceed.",
				"warning",
			);
			return;
		}
		const result = await router.clearCookies(taskId(ctx));
		if (!result.success) {
			ctx.ui.notify(
				`Failed to clear cookies: ${result.error ?? "unknown error"}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify("Cleared all cookies for the current session.", "info");
	} else if (kw === "import" || kw.startsWith("import ")) {
		// The whole remainder after the verb is the file path — profile names
		// can never contain spaces but file paths can, so no quoting is needed.
		const arg = sub === "import" ? "" : sub.slice("import ".length).trim();
		await importCookies(arg, ctx, conversationDefaultProfile);
	} else {
		// shortcut: Netscape cookies.txt format only — no JSON import; upgrade
		// when a non-Netscape exporter ships.
		ctx.ui.notify(
			`Unknown cookies sub-command: "${sub}". ` +
				`Usage: /web cookies [list|clear [--confirm]|import [file]]`,
			"warning",
		);
	}
}

// ─── Import ──────────────────────────────────────────────────────

/** The import's cookie text, or why acquiring it was refused. */
type CookieSource =
	| { ok: true; text: string; label: string }
	| { ok: false; msg: string };

const refused = (msg: string): CookieSource => ({ ok: false, msg });

// The paste dialog is TUI-only: an RPC host that never answers the editor
// request would hang this await forever — the same unworked-around upstream
// class as the /reload disposal noted below.
async function readPasteSource(
	ctx: ExtensionContext,
): Promise<CookieSource | undefined> {
	if (ctx.mode !== "tui") {
		return refused(
			"Usage: /web cookies import [file] — provide the path to a Netscape cookies.txt export. In the TUI, calling it with no file opens a paste dialog instead.",
		);
	}
	// shortcut: a dialog disposed by resetExtensionUI() (/reload, session
	// invalidation) never resolves this await — upstream pi-tui, not
	// worked around.
	let pasted: string | undefined;
	try {
		pasted = await ctx.ui.editor("Paste a Netscape cookies.txt export");
	} catch (err) {
		return refused(`Failed to open the paste dialog: ${errMessage(err)}.`);
	}
	// undefined = cancel; "" = empty submit (refused below) — branch on ===,
	// not truthiness.
	if (pasted === undefined) return undefined;
	if (!pasted.trim()) return refused("Nothing pasted.");
	if (Buffer.byteLength(pasted, "utf-8") > MAX_COOKIE_IMPORT_BYTES) {
		return refused(
			`Refusing to import the pasted text: it exceeds the ${MAX_COOKIE_IMPORT_MB} MB import limit.`,
		);
	}
	const restored = restorePastedTabs(pasted);
	if (!restored.ok) {
		return refused(
			"Refusing to import the pasted text: ambiguous space runs — paste mode cannot distinguish delimiters from real spaces; use import <file> instead.",
		);
	}
	return { ok: true, text: restored.text, label: "the pasted text" };
}

function readFileSource(arg: string, ctx: ExtensionContext): CookieSource {
	// Expand a leading `~/` (or bare `~`); `~user/` forms are unsupported and
	// fail as literal paths. Relative paths resolve against the session's
	// cwd, not the pi process's launch directory. Never lowercased — real
	// exports have cased filenames and Linux is case-sensitive.
	let filePath = arg;
	if (filePath === "~" || filePath.startsWith("~/")) {
		filePath = join(homedir(), filePath.slice(1));
	}
	filePath = resolve(ctx.cwd, filePath);
	// Bounded by stat before read — a multi-GB export must not be slurped
	// and a FIFO/char device must not block readFileSync forever.
	try {
		const stats: Stats = statSync(filePath);
		if (!stats.isFile()) {
			return refused(`Refusing to import '${arg}': not a regular file.`);
		}
		if (stats.size > MAX_COOKIE_IMPORT_BYTES) {
			return refused(
				`Refusing to import '${arg}': file exceeds the ${MAX_COOKIE_IMPORT_MB} MB import limit.`,
			);
		}
		return {
			ok: true,
			text: readFileSync(filePath, "utf-8"),
			label: `'${arg}'`,
		};
	} catch (err) {
		return refused(`Failed to read '${arg}': ${errMessage(err)}.`);
	}
}

/**
 * Import a Netscape cookies.txt export into the active profile. One flow
 * whose text comes from a file read (`import <file>`) or the TUI paste
 * dialog (bare `import`): get the text (paste mode adds pre-parse refusals:
 * empty submit, size cap, ambiguity guard) → parse (skip-and-warn, hard
 * abort only on zero importable cookies) → resolve the target profile (live
 * session > conversation default > config default; "none" refused) →
 * preflight the disk state → best-effort live-session sync → fresh disk
 * re-read + security lift → `saveStorageState` (the last write) →
 * counts-only notify. Cookie values never appear in any notify — counts and
 * reason codes only.
 */
async function importCookies(
	arg: string,
	ctx: ExtensionContext,
	conversationDefaultProfile: string | undefined,
): Promise<void> {
	// Preflight refusals share one contract: nothing happened. Post-sync
	// failures (unreadable state, save failure) deliberately never use this —
	// synced live contexts may already hold the imported cookies.
	const refuse = (msg: string) => {
		ctx.ui.notify(`${msg} Nothing was written.`, "warning");
	};
	const source = arg ? readFileSource(arg, ctx) : await readPasteSource(ctx);
	// undefined = paste dialog cancelled (Esc/Ctrl+C) — silently return.
	if (!source) return;
	if (!source.ok) return refuse(source.msg);

	const parsed = parseCookiesTxt(source.text);
	if (parsed.cookies.length === 0) {
		// The single hard abort: zero importable cookies signals a wrong or
		// unreadable source, not a damaged export.
		return refuse(
			`No importable cookies in ${source.label} (skipped ${parsed.skipped.length} malformed line(s), ${parsed.expired} expired, ${parsed.duplicates} duplicate line(s)) — is this a Netscape cookies.txt export?`,
		);
	}

	// Resolve the target profile — live session first: `list`/`clear` act on
	// the live session, and "import into the profile I'm browsing with" is
	// the headline use case. A none-mode session has profileName unset and
	// falls through; a live-tier hit is a concrete profile name, never a mode.
	// Unlike navigate (console-warn + fall back to none, dropping the
	// cookies), an unresolvable session id surfaces as a refusal here.
	const mergedProfile = mergeProfilePrecedence({
		liveSessionProfile:
			sessionManager.getSession(taskId(ctx))?.profileName,
		conversationDefault: conversationDefaultProfile,
		settingsDefault: loadFullConfig().browser.defaultProfile,
	});
	const resolution = resolveActiveProfile(
		mergedProfile,
		ctx.sessionManager?.getSessionId?.(),
		"refuse",
	);
	if ("mode" in resolution) {
		ctx.ui.notify(
			"Profile mode is 'none' (no persistence) — nothing to import into. Set a profile first: /web profile <name>, or /web profile session.",
			"warning",
		);
		return;
	}
	if ("refusal" in resolution) {
		ctx.ui.notify(resolution.refusal.error, "warning");
		return;
	}
	const profileName = resolution.profileName;
	const label = getProfileLabel(profileName);

	// Preflight the on-disk state before any live mutation — a refusal must
	// never fire after live contexts were already modified.
	if (probeStorageState(profileName) === "corrupt") {
		return refuse(
			`Existing profile state for '${label}' is unreadable (corrupt or not valid storage state). Refusing to import over it — repair or clear the profile state first.`,
		);
	}

	// Sync active live sessions on the target profile — best-effort, and run
	// before the disk persist so the import's write is the last write (a
	// synced context's subsequent save preserves the imported cookies).
	// Direct plugin calls, never the router: router.getCookies/addCookies go
	// through requireInteractiveSession(), which would auto-create and
	// *navigate* a session — a cookie import must never launch a browser.
	const targets = sessionManager
		.getActiveSessions()
		.filter((s) => s.profileName === profileName);
	let synced = 0;
	let syncFailed = 0;
	// Distinct lift keys, not running counts: the same incoming set is lifted
	// once per live session plus once for the disk merge, so counts would
	// multiply one real collision across every target.
	const collisionKeys = new Set<string>();
	const rejectedKeys = new Set<string>();
	for (const s of targets) {
		try {
			const plugin = pluginRegistry.get(s.pluginName);
			if (!plugin) {
				syncFailed++;
				continue;
			}
			const got = await plugin.getCookies(s.taskId);
			if (!got.success) {
				syncFailed++;
				continue;
			}
			// Re-check after the await: a concurrent navigate can flip the
			// session's profile while this loop is suspended, and pushing into
			// the new owner's context would contaminate that profile's next save.
			if (
				sessionManager.getSession(s.taskId)?.profileName !== profileName
			) {
				syncFailed++;
				continue;
			}
			// Pull-lift-push: the live jar supplies the security-attribute
			// ground truth, the file supplies the values (file-wins — the same
			// incoming-wins rule as the disk merge).
			const lift = liftSecurityAttributes(got.cookies, parsed.cookies);
			for (const k of lift.collidedKeys) collisionKeys.add(k);
			for (const k of lift.rejectedKeys) rejectedKeys.add(k);
			const added = await plugin.addCookies(s.taskId, lift.cookies);
			if (added.success) synced++;
			else syncFailed++;
		} catch {
			syncFailed++;
		}
	}

	// Post-sync outcome framing for both failure exits: a synced context
	// holds the imported cookies (its next save heals the file); otherwise
	// nothing was touched at all.
	const recovery =
		synced > 0
			? ` The ${synced} synced live session(s) hold the imported cookies; their next save should heal the file.`
			: " Nothing was written.";

	// Everything past the sync loop is post-mutation and reports through the
	// single failure exit below — never through refuse().
	const corrupt = probeStorageState(profileName) === "corrupt";
	// Fresh re-read (not the preflight result) — a cookie that gained
	// httpOnly/secure on disk during the sync window must not be lowered by
	// the import's write. Skipped when corrupt — the lift then runs against
	// an empty jar and its keys are never read by the failure exit.
	const disk = corrupt ? undefined : loadStorageState(profileName);
	const lift = liftSecurityAttributes(disk?.cookies ?? [], parsed.cookies);
	for (const k of lift.collidedKeys) collisionKeys.add(k);
	for (const k of lift.rejectedKeys) rejectedKeys.add(k);
	// No await between the unreadable-state check above and this save — the
	// never-lowered guarantee rests on nothing else running in between.
	let saved = false;
	if (!corrupt) {
		try {
			saved = saveStorageState(
				profileName,
				{ cookies: lift.cookies, origins: [] },
				loadFullConfig().browser.maxStorageStateSize,
			);
		} catch {
			saved = false;
		}
	}
	if (corrupt || !saved) {
		ctx.ui.notify(
			corrupt
				? `Existing profile state for '${label}' turned unreadable before the import could be saved.${recovery}`
				: `Failed to save imported cookies to profile '${label}'.${recovery}`,
			"warning",
		);
		return;
	}

	// Counts only — never cookie names or values.
	const lines = [
		`📥 Imported ${lift.cookies.length} cookie(s) into profile '${label}'.`,
	];
	if (parsed.skipped.length > 0) {
		const shown = parsed.skipped
			.slice(0, 10)
			.map((s) => `line ${s.line}: ${s.reason}`);
		if (parsed.skipped.length > 10) {
			shown.push(`…and ${parsed.skipped.length - 10} more`);
		}
		lines.push(
			`   Skipped ${parsed.skipped.length} malformed line(s): ${shown.join("; ")}`,
		);
	}
	if (parsed.expired > 0 || parsed.duplicates > 0) {
		lines.push(
			`   Dropped ${parsed.expired} expired, collapsed ${parsed.duplicates} duplicate line(s).`,
		);
	}
	if (synced > 0) lines.push(`   Synced ${synced} live session(s).`);
	if (collisionKeys.size > 0) {
		lines.push(
			`   Imported values replaced ${collisionKeys.size} existing/live cookie(s) — re-export and re-import to refresh a session that changed after the export.`,
		);
	}
	if (rejectedKeys.size > 0) {
		lines.push(
			`   ${rejectedKeys.size} cookie(s) dropped: __Host-/__Secure- prefix without Secure (the lift could not repair it).`,
		);
	}
	if (syncFailed > 0) {
		lines.push(
			`   ⚠ ${syncFailed} live session(s) could not be synced — their stale jar's next save may overwrite imported cookies on disk.`,
		);
	}
	ctx.ui.notify(
		lines.join("\n"),
		parsed.skipped.length > 0 || syncFailed > 0 ? "warning" : "info",
	);
}
