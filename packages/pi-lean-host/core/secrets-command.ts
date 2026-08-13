/**
 * `/api secrets [domain [name]]` — list and provision stored API secrets.
 *
 * - `secrets [--help]`              — list stored domains + names (names only), or show help.
 * - `secrets <domain>`              — detail view + assisted entry for a domain.
 * - `secrets <domain> <name>`       — manual entry (escape valve for the chicken-and-egg case).
 * - `secrets <domain> --delete`        — delete all secrets for a domain (interactive confirm).
 * - `secrets <domain> <name> --delete` — delete a single secret (no confirm).
 *
 * All values are entered via `ctx.ui.input()` and land only in the store; the
 * value never touches a tool result, `pi.sendMessage`, or the session file.
 * Returns metadata-only status lines (names, never values).
 *
 * Headless (`ctx.hasUI` false): print direct-file-write instructions; never
 * prompt or hang. Full usage/file-format lives behind `--help`; the bare list
 * shows a one-line hint instead of the whole block.
 *
 * Focus-mode guard is **not** applied — this is a peer of `status`/`helpers`/
 * bare `/api`, not an actuation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	deleteDomain,
	deleteSecret,
	getSecretsDir,
	listDomains,
	listNames,
	readSecret,
	writeSecret,
} from "./secrets-store.js";

/** One-line pointer to `--help`, used in place of the full instructions block. */
const HELP_HINT = "Run /api secrets --help for usage & storage details.";

/** Direct-file-write instructions for headless mode / manual provisioning. */
function fileWriteInstructions(): string {
	return (
		"Secrets are stored per-domain as JSON (0600), one file per domain:\n" +
		`  ${getSecretsDir()}/<domain>.json\n\n` +
		"Each file maps secret name → value. To provision manually, write:\n" +
		'  { "apiKey": "<value>" }\n' +
		"into `<domain>.json`, then run /api secrets <domain> to verify."
	);
}

/** Full usage + storage docs, surfaced by `--help`. */
function helpText(): string {
	return [
		"Usage: /api secrets [domain [name]] [--delete]",
		"  /api secrets                          list stored secrets (names only)",
		"  /api secrets <domain>                 view + provision secrets for a domain",
		"  /api secrets <domain> <name>          set a single secret by name",
		"  /api secrets <domain> --delete        delete all secrets for a domain (confirm)",
		"  /api secrets <domain> <name> --delete delete a single secret",
		"  /api secrets --help                   this help",
		"",
		fileWriteInstructions(),
	].join("\n");
}

/**
 * Handle the `secrets` subcommand of `/api`.
 *
 * @param args  The text after "secrets" ("" / "<domain>" / "<domain> <name>")
 * @param ctx   The extension command context
 */
export async function handleSecretsSubcommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	// `--help` (or `help`) short-circuits before domain dispatch — it must
	// never be mistaken for a domain name.
	if (parts.includes("--help") || parts.includes("help")) {
		ctx.ui.notify(helpText(), "info");
		return;
	}

	// Extract the `--delete` flag; it isn't a domain or secret name.
	const deleteFlag = parts.includes("--delete");
	const tokens = parts.filter((p) => p !== "--delete");
	const domain = tokens[0];
	const name = tokens[1];

	if (deleteFlag && !domain) {
		ctx.ui.notify(
			"Usage: /api secrets <domain> [name] --delete — see /api secrets --help.",
			"warning",
		);
		return;
	}
	if (domain && name) {
		if (deleteFlag) {
			await deleteOne(ctx, domain, name);
		} else {
			await provisionOne(ctx, domain, name);
		}
		return;
	}
	if (domain) {
		if (deleteFlag) {
			await deleteAllSecrets(ctx, domain);
		} else {
			await assistedEntry(ctx, domain);
		}
		return;
	}
	listAll(ctx);
}

// ── No-arg list ────────────────────────────────────────────────────

function listAll(ctx: ExtensionCommandContext): void {
	const domains = listDomains();
	if (domains.length === 0) {
		ctx.ui.notify("(no secrets stored)\n\n" + HELP_HINT, "info");
		return;
	}

	const lines = domains.map((d) => {
		const names = listNames(d);
		const listing = names.length ? names.join(", ") : "(no names)";
		return `  · ${d}: ${listing}`;
	});

	ctx.ui.notify(
		["Stored secrets (names only):", ...lines, "", HELP_HINT].join("\n"),
		"info",
	);
}

// ── Assisted entry: /api secrets <domain> ──────────────────────────

async function assistedEntry(
	ctx: ExtensionCommandContext,
	domain: string,
): Promise<void> {
	const names = listNames(domain);
	const storedLine = names.length ? names.join(", ") : "(none)";

	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Stored secrets for '${domain}': ${storedLine}\n\n` +
				fileWriteInstructions(),
			"info",
		);
		return;
	}

	ctx.ui.notify(`🔐 Secrets for '${domain}'\n  Stored: ${storedLine}`, "info");

	// Guide-aware assisted entry (prompt the single declared name / show a
	// picker over declared names) lands with the sprint-1 auth schema; until
	// the schema exists no guide declares secret names, so fall back to
	// prompting for a name + value.
	const newName = await ctx.ui.input(
		`Secret name for '${domain}'`,
		"e.g. apiKey",
	);
	if (newName === undefined) return; // cancelled
	const trimmedName = newName.trim();
	if (!trimmedName) {
		ctx.ui.notify("Aborted — empty secret name.", "warning");
		return;
	}

	const value = await ctx.ui.input(
		`Value for '${domain}'.${trimmedName}`,
		"paste the secret value",
	);
	if (value === undefined) return; // cancelled
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		ctx.ui.notify("Aborted — empty value.", "warning");
		return;
	}

	writeSecret(domain, trimmedName, trimmedValue);
	ctx.ui.notify(`Stored secret '${trimmedName}' for '${domain}'.`, "info");
}

// ── Delete: /api secrets <domain> [name] --delete ──────────────────

// Delete a single secret. Explicit by name — no confirmation, headless or not
// (deleting needs no value from the user, so headless never hangs).
async function deleteOne(
	ctx: ExtensionCommandContext,
	domain: string,
	name: string,
): Promise<void> {
	if (readSecret(domain, name) === null) {
		ctx.ui.notify(`No secret '${name}' stored for '${domain}'.`, "warning");
		return;
	}
	deleteSecret(domain, name);
	ctx.ui.notify(`Deleted secret '${name}' for '${domain}'.`, "info");
}

// Delete all secrets for a domain. The bigger hammer (wipes several keys at
// once) — confirm once in interactive mode. Headless skips the confirm and
// just does it; no prompt, no hang.
async function deleteAllSecrets(
	ctx: ExtensionCommandContext,
	domain: string,
): Promise<void> {
	const names = listNames(domain);
	if (names.length === 0) {
		ctx.ui.notify(`No secrets stored for '${domain}'.`, "warning");
		return;
	}
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			`Delete all secrets for '${domain}'?`,
			`This removes: ${names.join(", ")}.`,
		);
		if (!ok) {
			ctx.ui.notify("Cancelled — nothing deleted.", "info");
			return;
		}
	}
	deleteDomain(domain);
	ctx.ui.notify(`Deleted all secrets for '${domain}'.`, "info");
}

// ── Manual entry: /api secrets <domain> <name> ─────────────────────

async function provisionOne(
	ctx: ExtensionCommandContext,
	domain: string,
	name: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`No interactive UI — write the value for '${name}' in ` +
				`${getSecretsDir()}/${domain}.json manually.\n\n` +
				fileWriteInstructions(),
			"info",
		);
		return;
	}

	const value = await ctx.ui.input(
		`Value for '${domain}'.${name}`,
		"paste the secret value",
	);
	if (value === undefined) return; // cancelled
	const trimmed = value.trim();
	if (!trimmed) {
		ctx.ui.notify("Aborted — empty value.", "warning");
		return;
	}

	writeSecret(domain, name, trimmed);
	ctx.ui.notify(`Stored secret '${name}' for '${domain}'.`, "info");
}
