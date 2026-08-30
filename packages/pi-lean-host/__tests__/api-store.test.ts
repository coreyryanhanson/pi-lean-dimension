/**
 * api-store structural tests — read-only inspection of both credential
 * stores, against isolated temp stores and a temp guides dir (no network).
 *
 * Covers: bare orphan view, per-domain combined view, declared-slot gaps,
 * the two-layer learn gate, value redaction (asserted against structured
 * `details`, not just rendered text), and the scope "(assumed)" fallback.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiStoreTool } from "../tools/index.js";
import { contentText } from "../tools/utils.js";
import { Check } from "typebox/value";
import { writeSecret, setSecretsDir } from "../core/secrets-store.js";
import { writeToken } from "../core/oauth-store.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import {
	_setToggleStateForTest,
	_resetToggleStateForTest,
} from "../core/api-toggle.js";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock theme: fg/bold pass text through so assertions see raw strings.
const mockTheme = {
	fg: (_style: string, text: string) => text,
	bold: (s: string) => s,
} as any;

const STATIC_RECIPE = `---
domains: [example.com]
apiHost: https://api.example.com/v2/api
auth:
  kind: static-key
  secretQueryRefs:
    apikey:
      secret: api_key
responseShape:
  format: json
operations:
  - name: ping
    via: restGet
    path: /
    accept: json
    params: {}
---
`;

const GITHUB_OAUTH_RECIPE = `---
domains: [github.com]
apiHost: https://api.github.com
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://github.com/login/oauth/access_token
  clientId:
    secret: client_id
  clientSecret:
    secret: client_secret
  scopes: [repo, read:org]
responseShape:
  format: json
operations:
  - name: repos
    via: restGet
    path: /user/repos
    accept: json
    params: {}
---
`;

const GITLAB_OAUTH_RECIPE = `---
domains: [gitlab.com]
apiHost: https://gitlab.com/api/v4
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://gitlab.com/oauth/token
  clientId:
    secret: gl_client_id
  clientSecret:
    secret: gl_client_secret
responseShape:
  format: json
operations:
  - name: projects
    via: restGet
    path: /projects
    accept: json
    params: {}
---
`;

let tmpSecrets: string;
let tmpGuides: string;

beforeAll(() => {
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-store-secrets-"));
	tmpGuides = mkdtempSync(join(tmpdir(), "host-store-guides-"));
	setSecretsDir(tmpSecrets);
	setUserGuidesDir(tmpGuides);
	_setToggleStateForTest(true, true);

	// Scoped secret domain (guide declares api_key).
	writeSecret("example.com", "api_key", "REALSECRETVALUE");
	// Unscoped secret domain (no guide anywhere).
	writeSecret("random.dev", "orphan_secret", "ORPHANVALUE");
	// Parent-domain provisioning: secret lives under the registrable domain.
	writeSecret("coinmarketcap.com", "cmc_key", "CMC-KEY");

	// Guides: static-key (example.com), oauth2 with a minted slot (github.com),
	// oauth2 with NO minted slot (gitlab.com — the declared-gap case).
	const exDir = join(tmpGuides, "example-com");
	mkdirSync(exDir, { recursive: true });
	writeFileSync(join(exDir, "guide.md"), STATIC_RECIPE);
	const ghDir = join(tmpGuides, "github-com");
	mkdirSync(ghDir, { recursive: true });
	writeFileSync(join(ghDir, "guide.md"), GITHUB_OAUTH_RECIPE);
	const glDir = join(tmpGuides, "gitlab-com");
	mkdirSync(glDir, { recursive: true });
	writeFileSync(join(glDir, "guide.md"), GITLAB_OAUTH_RECIPE);

	// Tokens: one guideless domain (random.dev), one matching a guide's
	// declared slot (github.com). Values here are canaries — they must never
	// surface in text or details.
	writeToken(
		"random.dev",
		"client_credentials",
		"https://random.dev/oauth/token",
		{
			accessToken: "CANARY-ACCESS",
			refreshToken: "CANARY-REFRESH",
			expiresAt: Date.now() + 6 * 3_600_000,
			scope: "read",
		},
	);
	writeToken(
		"github.com",
		"client_credentials",
		"https://github.com/login/oauth/access_token",
		{
			// No scope echoed → falls back to the guide's requested scopes "(assumed)".
			accessToken: "GH-ACCESS",
			expiresAt: Date.now() + 6 * 3_600_000,
		},
	);
	invalidateCache();
});

afterAll(() => {
	rmSync(tmpSecrets, { recursive: true, force: true });
	rmSync(tmpGuides, { recursive: true, force: true });
	_resetToggleStateForTest();
});

function run(
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof apiStoreTool.execute>>> {
	return apiStoreTool.execute(
		"t",
		params,
		undefined,
		undefined,
		undefined as any,
	);
}

describe("api-store", () => {
	it("is registered on the learn toolset (schema-legal bare call)", () => {
		expect(apiStoreTool.name).toBe("api-store");
		// The documented bare call passes the schema (apiHost/path not required).
		expect(Check(apiStoreTool.parameters, {})).toBe(true);
		expect(Check(apiStoreTool.parameters, { domain: "github.com" })).toBe(true);
	});

	it("bare call lists unscoped secret domains + guideless token domains", async () => {
		const res = await run({});
		const d = res.details as Record<string, unknown>;
		const unscoped = d.unscoped as {
			secretDomains: string[];
			tokenDomains: string[];
		};
		// random.dev is provisioned + guideless in BOTH stores → both lists.
		expect(unscoped.secretDomains).toContain("random.dev");
		expect(unscoped.secretDomains).not.toContain("example.com");
		expect(unscoped.tokenDomains).toContain("random.dev");
		// github.com has a guide → not an orphan, despite holding a token.
		expect(unscoped.tokenDomains).not.toContain("github.com");
		const text = contentText(res);
		expect(text).toContain("store overview");
		expect(text).toContain("random.dev");
	});

	it("apiHost without domain resolves the provisioned parent domain", async () => {
		const res = await run({
			apiHost: "https://pro-api.coinmarketcap.com/v1",
		});
		const d = res.details as Record<string, unknown>;
		expect(d.domain).toBe("coinmarketcap.com");
		const secrets = d.secrets as { provisioned: string[] };
		expect(secrets.provisioned).toEqual(["cmc_key"]);
	});

	it("per-domain combined view: secrets section with declared + gaps", async () => {
		const res = await run({ domain: "example.com" });
		const d = res.details as Record<string, unknown>;
		const secrets = d.secrets as {
			provisioned: string[];
			declared: string[];
			gaps: string[];
			guides: string[];
		};
		expect(secrets.provisioned).toEqual(["api_key"]);
		expect(secrets.declared).toEqual(["api_key"]);
		expect(secrets.gaps).toEqual([]);
		expect(secrets.guides).toEqual(["example-com"]);
		const text = contentText(res);
		expect(text).toContain("🔐 store: example.com");
		expect(text).toContain("provisioned: api_key");
		expect(text).not.toContain("REALSECRETVALUE"); // names only
	});

	it("declared-slot gap: guide-declared oauth2 with no token → mint pointer", async () => {
		const res = await run({ domain: "gitlab.com" });
		const d = res.details as Record<string, unknown>;
		const tokens = d.tokens as {
			slots: unknown[];
			unclaimed: { guide: string; grant: string; tokenUrl: string }[];
		};
		expect(tokens.slots).toEqual([]);
		expect(tokens.unclaimed).toHaveLength(1);
		expect(tokens.unclaimed[0]!.grant).toBe("client_credentials");
		expect(tokens.unclaimed[0]!.tokenUrl).toBe("https://gitlab.com/oauth/token");
		const text = contentText(res);
		expect(text).toContain("no token minted");
	});

	it("token slot renders metadata; scope falls back to requested '(assumed)'", async () => {
		const res = await run({ domain: "github.com" });
		const d = res.details as Record<string, unknown>;
		const tokens = d.tokens as {
			slots: {
				slot: string;
				grant: string;
				issuer: string;
				granted: string;
				expires: string;
			}[];
			unclaimed: unknown[];
		};
		expect(tokens.slots).toHaveLength(1);
		const slot = tokens.slots[0]!;
		expect(slot.issuer).toBe("https://github.com/login/oauth/access_token");
		// Provider echoed no scope → the guide's requested scopes, "(assumed)".
		expect(slot.granted).toContain("repo, read:org");
		expect(slot.granted).toContain("(assumed)");
		// No refresh token on the github slot → not refreshable.
		expect(slot.expires).not.toContain("(refreshable)");
		expect(tokens.unclaimed).toEqual([]);
		const text = contentText(res);
		expect(text).toContain("assumed");
		expect(text).not.toContain("GH-ACCESS");
	});

	it("redaction: token values appear in neither text nor details (canaries)", async () => {
		const res = await run({ domain: "random.dev" });
		const text = contentText(res);
		for (const canary of ["CANARY-ACCESS", "CANARY-REFRESH"]) {
			expect(text).not.toContain(canary);
		}
		// Walk the WHOLE structured details tree — raw TokenSlotInfos in
		// details would leak token values past the clean rendered text.
		const serialized = JSON.stringify(res.details);
		expect(serialized).not.toContain("CANARY-ACCESS");
		expect(serialized).not.toContain("CANARY-REFRESH");
		// Metadata IS present.
		const tokens = (res.details as Record<string, unknown>).tokens as {
			slots: { slot: string; refreshable: boolean }[];
		};
		expect(tokens.slots[0]!.refreshable).toBe(true);
		expect(contentText(res)).toContain("refreshable");
	});

	it("learn gate: refused under /api on (non-learn), store untouched", async () => {
		_setToggleStateForTest(true, false); // /api on — learn off
		try {
			const res = await run({ domain: "example.com" });
			const d = res.details as Record<string, unknown>;
			expect(d.error).toBe("learn_mode_only");
			expect(d.secrets).toBeUndefined();
			expect(contentText(res)).toContain("learn mode only");
			// Bare call is gated identically.
			const bare = await run({});
			expect((bare.details as Record<string, unknown>).error).toBe(
				"learn_mode_only",
			);
		} finally {
			_setToggleStateForTest(true, true);
		}
	});

	it("renders the orphan summary and the per-domain summary", () => {
		const orphan = apiStoreTool.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { unscoped: { secretDomains: ["a.dev"], tokenDomains: [] } },
			},
			{ expanded: false },
			mockTheme,
			{},
		);
		expect(orphan.text).toContain("🔐 api-store");
		expect(orphan.text).toContain("1 unscoped secret domain(s)");
		const perDomain = apiStoreTool.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					domain: "github.com",
					secrets: {
						provisioned: ["a"],
						declared: ["a"],
						gaps: [],
						guides: ["github-com"],
					},
					tokens: { slots: [{}], unclaimed: [{}] },
				},
			},
			{ expanded: false },
			mockTheme,
			{},
		);
		expect(perDomain.text).toContain("1 provisioned · 1 token slot(s)");
		expect(perDomain.text).toContain("1 unclaimed");
	});
});
