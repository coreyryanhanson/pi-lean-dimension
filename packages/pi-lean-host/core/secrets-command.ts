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
import { findGuidesByDomain } from "./guide-store.js";
import { declaredSecretRefNames } from "./auth.js";

/** One-line pointer to `--help`, used in place of the full instructions block. */
const HELP_HINT = "Run /api secrets --help for usage & storage details.";

/** Direct-file-write instructions for headless mode / manual provisioning. */
function fileWriteInstructions(): string {
	return (
		"Secrets are stored per-domain as JSON (0600), one file per domain:\n" +
		`  ${getSecretsDir()}/<domain>.json\n\n` +
		"Each file maps secret name → value. To provision manually, write:\n" +
		'  { "api_key": "<value>" }\n' +
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

/**
 * Declared secret store-names for a domain, from every registered guide's
 * auth block — a thin domain-level fan-out over the shared per-guide
 * scanner in core/auth.ts (single source of truth for the declared/gap
 * report too).
 */
function declaredSecretNames(domain: string): string[] {
	const names = new Set<string>();
	for (const { guide } of findGuidesByDomain(domain))
		for (const name of declaredSecretRefNames(guide)) names.add(name);
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The guide-declared header prefix for a secret name, or undefined. When a
 * guide maps a secret to a prefixed header, the store must hold the raw
 * credential (the guide adds the prefix at fetch time) — surface that in the
 * provisioning prompt so the user pastes the raw token, not the prefixed form.
 */
function declaredPrefixHint(domain: string, name: string): string | undefined {
	for (const { guide } of findGuidesByDomain(domain)) {
		switch (guide.auth.kind) {
			case "static-key":
				for (const ref of Object.values(guide.auth.secretRefs ?? {})) {
					if (ref.secret === name && ref.prefix) return ref.prefix;
				}
				break;
			case "oauth2":
			case "none":
				break;
			default: {
				const _exhaustive: never = guide.auth;
				throw new Error(`Unhandled auth kind: ${_exhaustive}`);
			}
		}
	}
	return undefined;
}

// ── Assisted entry: /api secrets <domain> ──────────────────────────

async function assistedEntry(
	ctx: ExtensionCommandContext,
	domain: string,
): Promise<void> {
	const stored = listNames(domain);
	const storedLine = stored.length ? stored.join(", ") : "(none)";
	const declared = declaredSecretNames(domain);

	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Stored secrets for '${domain}': ${storedLine}\n\n` +
				fileWriteInstructions(),
			"info",
		);
		return;
	}

	const detailLines = [`🔐 Secrets for '${domain}'`, `  Stored: ${storedLine}`];
	if (declared.length > 0) {
		detailLines.push(`  Declared (guide): ${declared.join(", ")}`);
		const missing = declared.filter((n) => !stored.includes(n));
		if (missing.length) detailLines.push(`  Missing: ${missing.join(", ")}`);
	}
	ctx.ui.notify(detailLines.join("\n"), "info");

	// Guide-aware assisted entry: exactly one declared secret name → prompt
	// its value directly; multiple → a picker. No declared names (public API
	// or no registered guide) → fall back to a name + value prompt.
	if (declared.length === 1) {
		await promptAndStore(ctx, domain, declared[0]!);
		return;
	}
	if (declared.length > 1) {
		const picked = await ctx.ui.select(
			`Secret to provision for '${domain}'`,
			declared,
		);
		if (picked === undefined) {
			ctx.ui.notify("Cancelled — nothing stored.", "info");
			return;
		}
		await promptAndStore(ctx, domain, picked);
		return;
	}

	const newName = await ctx.ui.input(
		`Secret name for '${domain}'`,
		"e.g. api_key",
	);
	if (newName === undefined) return; // cancelled
	const trimmedName = newName.trim();
	if (!trimmedName) {
		ctx.ui.notify("Aborted — empty secret name.", "warning");
		return;
	}
	await promptAndStore(ctx, domain, trimmedName);
}

/** Prompt for a secret's value and store it. Value never leaves the store. */
async function promptAndStore(
	ctx: ExtensionCommandContext,
	domain: string,
	name: string,
): Promise<void> {
	const prefix = declaredPrefixHint(domain, name);
	const value = await ctx.ui.input(
		prefix
			? `Value for '${domain}'.${name} (raw token — the guide adds \`${prefix}\`)`
			: `Value for '${domain}'.${name}`,
		prefix ? "paste the raw token" : "paste the secret value",
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

	// Escape-valve validation: when a guide declares secret names, a manual
	// name outside them is likely a typo — warn but still store (this is the
	// chicken-and-egg escape hatch).
	const declared = declaredSecretNames(domain);
	if (declared.length > 0 && !declared.includes(name)) {
		ctx.ui.notify(
			`⚠ '${name}' is not a declared secret for '${domain}' ` +
				`(guide declares: ${declared.join(", ")}). Storing anyway.`,
			"warning",
		);
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
