/**
 * `/api secrets [domain [name]]` — list and provision stored API secrets.
 *
 * - `secrets`                — list stored domains + their secret names (names only).
 * - `secrets <domain>`       — detail view + assisted entry for a domain.
 * - `secrets <domain> <name>`— manual entry (escape valve for the chicken-and-egg case).
 *
 * All values are entered via `ctx.ui.input()` and land only in the store; the
 * value never touches a tool result, `pi.sendMessage`, or the session file.
 * Returns metadata-only status lines (names, never values).
 *
 * Headless (`ctx.hasUI` false): print direct-file-write instructions; never
 * prompt or hang.
 *
 * Focus-mode guard is **not** applied — this is a peer of `status`/`helpers`/
 * bare `/api`, not an actuation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getSecretsDir,
	listDomains,
	listNames,
	writeSecret,
} from "./secrets-store.js";

/** Direct-file-write instructions for headless mode / manual provisioning. */
export function fileWriteInstructions(): string {
	return (
		"Secrets are stored per-domain as JSON (0600), one file per domain:\n" +
		`  ${getSecretsDir()}/<domain>.json\n\n` +
		"Each file maps secret name → value. To provision manually, write:\n" +
		'  { "apiKey": "<value>" }\n' +
		"into `<domain>.json`, then run /api secrets <domain> to verify."
	);
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
	const domain = parts[0];
	const name = parts[1];

	if (domain && name) {
		await provisionOne(ctx, domain, name);
		return;
	}
	if (domain) {
		await assistedEntry(ctx, domain);
		return;
	}
	listAll(ctx);
}

// ── No-arg list ────────────────────────────────────────────────────

function listAll(ctx: ExtensionCommandContext): void {
	const domains = listDomains();
	if (domains.length === 0) {
		ctx.ui.notify("(no secrets stored)\n\n" + fileWriteInstructions(), "info");
		return;
	}

	const lines = domains.map((d) => {
		const names = listNames(d);
		const listing = names.length ? names.join(", ") : "(no names)";
		return `  · ${d}: ${listing}`;
	});

	ctx.ui.notify(
		[
			"Stored secrets (names only):",
			...lines,
			"",
			"Run /api secrets <domain> to view/provision, or /api secrets <domain> <name> to set one by name.",
		].join("\n"),
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
