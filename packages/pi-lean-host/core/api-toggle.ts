/**
 * API Toggle — independent peer toggle for pi-lean-host.
 *
 * Provides /api on, /api off, /api learn, /api status, and /api helpers
 * commands to enable/disable API tools in the system prompt.
 *
 * Three states: on (api-guide + api-fetch), learn (on + api-learn + api-probe +
 * api-scaffold + api-store + oauth-mint), off (all disabled).
 *
 * Starts enabled (api-guide + api-fetch on; api-learn + api-probe + api-scaffold + api-store + oauth-mint off), mirroring
 * portal's browser toggle. Both defaults are overridable via the
 * `toolsetDefaults` settings tier read by pi-tool-masking. The /api toggle
 * is an independent peer: it composes freely with /web (portal's toggle)
 * by using additive-on / filter-off semantics.
 *
 * Persistence: handled by the pi-tool-masking library via ToolsetSpec.persistKey.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	defineToolset,
	TOOLSET_EVENTS,
	getDefaultResolutionMode,
} from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";
import { handleHelpersSubcommand } from "./helpers-command.js";
import { handleSecretsSubcommand } from "./secrets-command.js";
import { handleOauthSubcommand } from "./oauth-command.js";
import { handleVerifySubcommand } from "./verify-command.js";
import { handleDeleteSubcommand } from "./delete-command.js";
import { loadAllGuides } from "./guide-store.js";
import { getAllHelpers, getDisabledHelperDomains } from "./local-helpers.js";
import { resolveProvisionedParentDomain } from "./auth.js";
import { listNames } from "./secrets-store.js";

// Focus-mode guard: refuse actuating subcommands while the library holds the
// line — inclusion mode or allowlist focus (an upstream pi-tool-masking
// consumer). Either way a sibling toggle must not write a focus-
// indistinguishable {enabled} entry.
function isFocusHolding(): boolean {
	const mode = getDefaultResolutionMode();
	return mode === "inclusion" || mode === "allowlist";
}

// ---- Toolset specs -----------------------------------------------

const HOST_API_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.api",
	names: new Set(["api-guide", "api-fetch"]),
	persistKey: "toolset-state:pi-lean-dimension.api",
};

const HOST_API_LEARN_SPEC: ToolsetSpec = {
	id: "pi-lean-dimension.api-learn",
	names: new Set([
		"api-learn",
		"api-probe",
		"api-scaffold",
		"api-store",
		"oauth-mint",
	]),
	persistKey: "toolset-state:pi-lean-dimension.api-learn",
	defaultEnabled: false,
	requires: ["pi-lean-dimension.api"],
};

/** The learn toolset's tool names, rendered for status/notify strings —
 *  derived from the spec so the enumeration can't rot when tools are added. */
function learnToolNames(): string {
	return [...HOST_API_LEARN_SPEC.names]
		.sort((a, b) => a.localeCompare(b))
		.join(" + ");
}

// ---- Status bar cached state (derived from library events) ------

/** @internal Last known api-tools toggle state for status bar rendering. */
let _lastToggleState = false;

/** @internal Last known learn state for status bar coloring. */
let _lastLearnState = false;

/** @internal Last captured ExtensionContext for event-driven glyph rendering. */
let _lastCtx: ExtensionContext | null = null;

export function getApiToggleState(): boolean {
	return _lastToggleState;
}

/**
 * Learn-mode gate for the authoring tools (api-probe, api-store). Returns
 * the cached learn state synced on session_start and toolset events. A hard
 * runtime gate (not just toolset masking) so a store-inspection call under
 * `/api on` is refused even if the tool is somehow reachable.
 */
export function isApiLearnEnabled(): boolean {
	return _lastLearnState;
}

/** @internal Test-only read access to live learn state. */
export function _getApiLearnStateForTest(): boolean {
	return _lastLearnState;
}

// ---- Test helpers -------------------------------------------------

/** @internal Reset cached state to defaults (test helper). */
export function _resetToggleStateForTest(): void {
	_lastToggleState = false;
	_lastLearnState = false;
	_lastCtx = null;
}

/** @internal Set cached state for test purposes only. */
export function _setToggleStateForTest(apiOn: boolean, learnOn: boolean): void {
	_lastToggleState = apiOn;
	_lastLearnState = learnOn;
}

/** @internal Reset cached state (called from index.ts on re-entry). */
function resetToggleModuleState(): void {
	_lastToggleState = false;
	_lastLearnState = false;
	_lastCtx = null;
}

export { resetToggleModuleState };

// ---- Glyph helpers -----------------------------------------------

function renderApiGlyph(
	ctx: {
		ui: {
			setStatus: (key: string, label: string) => void;
			theme: { fg: (c: ThemeColor, t: string) => string };
		};
	},
	apiEnabled: boolean,
	learnEnabled: boolean,
): void {
	if (!apiEnabled) {
		ctx.ui.setStatus("api", "○ api");
		return;
	}
	const color: ThemeColor = learnEnabled ? "success" : "accent";
	const dot = ctx.ui.theme?.fg(color, "●") ?? "●";
	ctx.ui.setStatus("api", `${dot} api`);
}

// ---- /api status command ------------------------------------------

function handleStatusSubcommand(
	apiOn: boolean,
	learnOn: boolean,
	ctx: ExtensionCommandContext,
): void {
	let state: string;
	if (apiOn) {
		state = learnOn ? "learn" : "on";
	} else {
		state = "off";
	}
	const learnFlag = learnOn ? `✅ on (${learnToolNames()} available)` : "❌ off";

	const allGuides = loadAllGuides();
	const guideCount = Object.keys(allGuides.guides).length;
	const domainList = Object.values(allGuides.guides)
		.flatMap((g) => g.domains ?? [])
		.filter(Boolean);
	const uniqueDomains = [...new Set(domainList)];

	const helpers = getAllHelpers();
	const disabled = getDisabledHelperDomains();

	const lines: string[] = [
		`📡 API status`,
		`  State: ${state}`,
		`  Learn: ${learnFlag}`,
		``,
		`  Guides: ${guideCount} active`,
	];

	if (uniqueDomains.length > 0) {
		lines.push(`  Domains: ${uniqueDomains.join(", ")}`);
	} else {
		lines.push(`  Domains: (none — write a guide via api-learn)`);
	}

	lines.push(`  Helpers: ${helpers.length} present`);
	if (disabled.length > 0) {
		lines.push(`  ⚠ Disabled: ${disabled.join(", ")}`);
	}
	if (helpers.length > 0) {
		lines.push(`  Run /api helpers to list them.`);
	}

	lines.push(
		``,
		`  /api on           enable api-guide + api-fetch`,
		`  /api learn       enable all seven tools (adds ${learnToolNames()})`,
		`  /api off         disable all API tools`,
		`  /api verify      verify a guide's ops against its live API (stamps verified)`,
		`  /api oauth       provision/inspect/revoke OAuth2 tokens (client_credentials + auth-code/PKCE)`,
		`  /api bootstrap   agent-driven OAuth2 bootstrap (injects a research brief; enables learn)`,
		`  /api delete      delete a guide directory (human-typed recovery gesture)`,
		``,
		`  Focus mode: /api on|off|learn are refused while focus holds;`,
		`  /api bootstrap flips learn mode, so enabling it is blocked there too.`,
	);

	ctx.ui.notify(lines.join("\n"), "info");
}

// ---- /api bootstrap: agent-driven OAuth2 bootstrap ------------------

const BOOTSTRAP_USAGE = [
	"Usage: /api bootstrap oauth <domain> <spec>",
	"",
	"  Hand OAuth2 bootstrap for <domain> to the agent: composes a research brief",
	"  from <spec> (a provider docs URL or file), injects it as a follow-up turn,",
	"  and exits — the agent researches the provider's OAuth2 shape, then calls the",
	"  oauth-mint tool, which walks the human through confirm → scopes → paste.",
	"",
	"  Requires an interactive session (the mint prompts the human).",
	"  Enables learn mode when off (blocked by focus mode — exit focus first).",
	"",
	"  Available modes: oauth",
].join("\n");

/**
 * The research brief injected via `pi.sendUserMessage(brief, {deliverAs:
 * "followUp"})` — from oauth2-agent-bootstrap.md (BRIEF), with
 * {domain} / {spec} filled from the command args, plus the doc's conditional
 * provisioned-secrets sentence when the store has names for the domain.
 * Inject-and-exit: the
 * command's entire output is this one message.
 */
export function composeBootstrapBrief(
	domain: string,
	spec: string,
	provisionedSecrets?: string[],
): string {
	// Names only (audit rule, same as /api secrets) — lets the agent skip the
	// failed oauth-mint precheck call when credentials are already provisioned.
	const provisionedNote = provisionedSecrets?.length
		? `\nProvisioned secret names for this domain: ${provisionedSecrets.map((n) => `\`${n}\``).join(", ")} — use these store names (pick the ones matching the provider's client-id/secret semantics).`
		: "";
	return `**OAuth2 bootstrap for \`${domain}\` — research then mint.**

Your task: bootstrap OAuth2 access for the API at domain \`${domain}\`. The
user has pointed you at the provider's documentation as the starting source.
Learn mode is on — you'll need it to author the
guide afterwards.

**Step 1 — Research.** Read \`${spec}\` (a URL or file path; if it references
other pages or files, follow them as needed). From the docs, determine:

- the OAuth2 **grant type** this provider expects for a read-only CLI client
  (\`client_credentials\` or \`authorization_code\`),
- the **token URL** (the endpoint that exchanges credentials/codes for
  tokens),
- the **authorize URL** (authorization_code only),
- the **scopes** the provider defines and what each one grants — you'll
  offer these to the user as a selectable list with short descriptions, so
  research what each scope means, not just its name.

**Step 2 — Mint.** Call the \`oauth-mint\` tool with what you found: \`domain\`,
\`grant\`, \`tokenUrl\`, \`authorizeUrl\` (auth-code only), \`clientId\` and
optional \`clientSecret\` as **secrets-store names** (never literal values —
if the needed names aren't provisioned, the tool will tell you and the user
will provision via \`/api secrets ${domain} <name>\`), the optional
\`tokenEndpointAuthMethod\` (\`client_secret_post\` is the default; some
providers require \`client_secret_basic\` — research which), and \`scopes\` as
\`{name, description}\` pairs for the human to pick from.${provisionedNote}

**Boundaries.** Do not fetch or mint anything yourself — \`oauth-mint\`
performs the consent flow with the user. Do not author the guide yet; that
comes after a successful mint. If the user cancels a prompt, stop and ask them how to proceed — never
auto-re-prompt a human who just declined. If they already authorized before
cancelling, they can finish without re-consenting — ask the user to run
the two-call form the tool's cancel error printed:
\`/api oauth init ${domain} --grant <grant> --token-url <tokenUrl>
[--authorize-url <authorizeUrl>] --client-id <store name> --code
<redirect-url>\`. Before calling \`oauth-mint\`,
**verify that both the authorize URL and the token URL belong to
\`${domain}\`'s provider** — the token URL is where the client secret is sent,
so if the docs point either endpoint somewhere that doesn't match, stop and
ask the user rather than proceeding. (The tool also asks the human to
confirm the token URL before the exchange — that check is yours, this is a
second pair of eyes, not a substitute.)

When the mint succeeds, report the granted scopes and store domain to the
user.`;
}

/**
 * `/api bootstrap oauth <domain> <spec>` — inject-and-exit (F1–F5, H1).
 * hooks close over the toolsets created in initApiToggle.
 */
async function handleBootstrapSubcommand(
	args: string,
	hooks: { learnEnabled: () => boolean; enableLearn: () => void },
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const mode = parts[0]?.toLowerCase();
	if (!mode) {
		ctx.ui.notify(
			`Usage: /api bootstrap <mode> <args…>\n\n${BOOTSTRAP_USAGE}`,
			"info",
		);
		return;
	}
	if (mode !== "oauth") {
		ctx.ui.notify(
			`Unknown bootstrap mode: "${mode}".\n\n${BOOTSTRAP_USAGE}`,
			"warning",
		);
		return;
	}
	const domain = parts[1];
	const spec = parts.slice(2).join(" ");
	if (!domain || !spec) {
		ctx.ui.notify(
			`Usage: /api bootstrap oauth <domain> <spec> — both required, domain first.\n` +
				`  <spec> is any provider docs URL or file for the agent to research.\n` +
				`  Example: /api bootstrap oauth openstreetmap.org https://wiki.openstreetmap.org/wiki/API OAuth`,
			"warning",
		);
		return;
	}

	// H1 (command side): the downstream oauth-mint prompts all need ctx.hasUI,
	// so injecting a brief into a headless session would dead-end at the
	// first prompt.
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/api bootstrap requires an interactive session — the downstream oauth-mint prompts need one. " +
				"Use the headless flags instead: /api oauth init <domain> --grant … --token-url …",
			"warning",
		);
		return;
	}

	// F5: auto-enable learn when off (same as the user running /api learn);
	// loud fail if the focus-mode guard blocks the enable. Learn stays on.
	if (!hooks.learnEnabled()) {
		if (isFocusHolding()) {
			const inInclusion = getDefaultResolutionMode() === "inclusion";
			ctx.ui.notify(
				inInclusion
					? "Another plugin has active inclusion mode — bootstrap needs to enable learn mode, which can't be toggled while inclusion is holding the line. Deactivate it there first."
					: "Focus mode (allowlist) is active — bootstrap needs to enable learn mode, which can't be toggled while focus is holding the line. Exit focus there first.",
				"warning",
			);
			return;
		}
		hooks.enableLearn();
		// A mode flip the user didn't ask for must not be silent (inject-and-exit
		// otherwise produces no output).
		ctx.ui.notify(
			"📖 Learn mode enabled (bootstrap needs api-learn to author the guide afterwards).",
			"info",
		);
	}

	const brief = composeBootstrapBrief(
		domain,
		spec,
		// Parent-domain normalization shared with probe/oauth-mint store
		// resolution — names only, never values.
		listNames(resolveProvisionedParentDomain(domain)),
	);
	pi.sendUserMessage(brief, { deliverAs: "followUp" });
}

// ---- Extension factory -------------------------------------------

export default function initApiToggle(pi: ExtensionAPI): void {
	// Settings-based toolset defaults (`toolsetDefaults` tier) are read by
	// pi-tool-masking itself inside defineToolset/restore — pass the packaged
	// spec straight through.
	const apiToolset = defineToolset(pi, HOST_API_SPEC);
	const learnToolset = defineToolset(pi, HOST_API_LEARN_SPEC);

	// ── Keep cached state in sync with library events ─────────
	const syncCachedState = () => {
		_lastToggleState = apiToolset.isEnabled(pi);
		_lastLearnState = learnToolset.isEnabled(pi);
		if (_lastCtx) {
			renderApiGlyph(_lastCtx, _lastToggleState, _lastLearnState);
		}
	};

	pi.events.on(TOOLSET_EVENTS.changed, syncCachedState);
	pi.events.on(TOOLSET_EVENTS.restored, syncCachedState);

	// ── /api command ──────────────────────────────────────────
	pi.registerCommand("api", {
		description:
			"Enable/disable API tools. " +
			"Usage: /api on | off | learn | status | helpers [domain] | secrets [domain [name] | --help] | verify <domain> [guide] [--force] | delete <domain> [guide] | bootstrap oauth <domain> <spec>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const rest = parts.slice(1).join(" ");

			// Focus-mode guard: refuse actuating subcommands while the library
			// holds the line — either inclusion mode or allowlist focus (an
			// upstream pi-tool-masking consumer). Either way a sibling toggle
			// must not write a focus-indistinguishable {enabled} entry.
			// Read-only subcommands (status/helpers/bare /api) stay unguarded.
			if (["on", "off", "learn"].includes(sub) && isFocusHolding()) {
				const inInclusion = getDefaultResolutionMode() === "inclusion";
				ctx.ui.notify(
					inInclusion
						? "Another plugin has active inclusion mode — this toolset can't be toggled while inclusion is holding the line. Deactivate it there first."
						: "Focus mode (allowlist) is active — this toolset can't be toggled while focus is holding the line. Exit focus there first.",
					"warning",
				);
				return;
			}

			switch (sub) {
				case "on": {
					apiToolset.enable(pi);
					learnToolset.disable(pi);
					ctx.ui.notify(
						`📡 API tools enabled. /api learn to make ${learnToolNames()} available.`,
						"info",
					);
					return;
				}

				case "off": {
					apiToolset.disable(pi); // cascades learn off via requires
					ctx.ui.notify("📡 API tools disabled. /api on to re-enable.", "info");
					return;
				}

				case "learn": {
					learnToolset.enable(pi); // cascades api on via requires
					ctx.ui.notify(
						`📖 ${learnToolNames()} tools are now available. ` +
							"Agent will discover shapes and save/update guides when asked.",
						"info",
					);
					return;
				}

				case "status": {
					handleStatusSubcommand(
						apiToolset.isEnabled(pi),
						learnToolset.isEnabled(pi),
						ctx,
					);
					return;
				}

				case "helpers": {
					await handleHelpersSubcommand(rest, ctx);
					return;
				}

				case "secrets": {
					// Peer of status/helpers/bare — read/write to the secrets store,
					// not a toolset actuation, so the focus-mode guard does not apply.
					await handleSecretsSubcommand(rest, ctx);
					return;
				}

				case "oauth": {
					// Peer of secrets/verify/delete — writes the token store, not
					// toolset state, so the focus-mode guard does not apply.
					await handleOauthSubcommand(rest, ctx);
					return;
				}

				case "verify": {
					// Peer of status/helpers/secrets — verifies a guide's ops and
					// stamps verified: (writes guide.md, not toolset state), so the
					// focus-mode guard does not apply.
					await handleVerifySubcommand(rest, ctx);
					return;
				}

				case "delete": {
					// Peer of status/helpers/secrets/verify — removes a guide
					// directory and invalidates the cache (writes guide.md, not
					// toolset state), so the focus-mode guard does not apply.
					await handleDeleteSubcommand(rest, ctx);
					return;
				}

				case "bootstrap": {
					// F4: explicit dispatch arm — no mode registry. Writes toolset
					// state (learn flip) only when learn was off, so the focus-mode
					// guard is enforced INSIDE the handler, scoped to the flip (F5).
					await handleBootstrapSubcommand(
						rest,
						{
							learnEnabled: () => learnToolset.isEnabled(pi),
							enableLearn: () => learnToolset.enable(pi), // cascades api on via requires
						},
						pi,
						ctx,
					);
					return;
				}

				default: {
					const apiStatus = apiToolset.isEnabled(pi) ? "✅ on" : "❌ off";
					const learnStatus = learnToolset.isEnabled(pi) ? "✅ on" : "❌ off";

					const lines: string[] = [
						`📡 API tools: ${apiStatus}`,
						`📖 Learn mode: ${learnStatus}`,
						``,
						`   /api on           enable api-guide + api-fetch`,
						`   /api learn        enable all seven tools (adds ${learnToolNames()})`,
						`   /api off          disable all API tools`,
						`   /api status       detailed status (guides, helpers)`,
						`   /api helpers      list local helpers`,
						`   /api secrets      list/provision stored secrets (names only)`,
						`   /api oauth        provision/inspect/revoke OAuth2 tokens (client_credentials + auth-code/PKCE)`,
						`   /api verify       verify a guide's ops against its live API (stamps verified)`,
						`   /api bootstrap    agent-driven OAuth2 bootstrap (injects a research brief; enables learn)`,
						`   /api delete       delete a guide directory (human-typed recovery gesture)`,
						`   /api              show this status`,
					];

					if (sub) {
						lines.unshift(`Unknown /api subcommand: "${sub}".`, "");
					}

					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});

	// ── Session handlers: restore profile + render glyph ─────
	pi.on("session_start", async (_event, ctx) => {
		_lastCtx = ctx;
		syncCachedState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		_lastCtx = ctx;
		syncCachedState();
	});

	pi.on("session_shutdown", async () => {
		_lastCtx = null;
	});
}
