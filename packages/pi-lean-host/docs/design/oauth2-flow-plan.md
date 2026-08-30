# OAuth2 Flow — Plan & Decision Record

> Realizes the `auth.kind: oauth2` seam. **Phases 0–2.8 are LANDED** (see
> the status table); **Phase 2.9** (token-slot multi-grant) has landed; what
> remains is **Phase 3** (axis guide + caritas recipes)
> and the coordinated **`0.5.0` hard-gate flip**. This doc is the decision
> record for the landed work and the plan for the remainder — the full
> deliberation history lives in git and in the companion docs.
>
> **Release context.** Everything landed under the v1 schema work
> (`GUIDE_SCHEMA_VERSION` `0` → `1`); the `0.5.0` release is the coordinated
> breaking-schema event — the still-deferred **hard-gate flip** rides that
> same gate as the lockstep release label change tracked in
> [`guides-decoupling-caritas-remaining-host.md`](./guides-decoupling-caritas-remaining-host.md).
> Do not treat the schema bump as a separate release event. Until `0.5.0`,
> `pi-lean-host` docs carry a development-preview notice; `0.4.0` is the last
> preview release.

## Landed status (Phases 0–2.9)

| Phase | What shipped | Where |
|-------|--------------|-------|
| **0 — Research** | Locked candidates: Twitch (`client_credentials`), Mastodon + OpenStreetMap (`authorization_code` + PKCE), with rejected candidates and live-verified provider facts. | [`oauth2-flow-research.md`](./oauth2-flow-research.md), [`oauth2-bluesky-followup.md`](./oauth2-bluesky-followup.md) |
| **1 — Client credentials + auth union** | `AuthConfig` → `NoneAuth \| StaticKeyAuth \| OAuth2Auth` discriminated union with nested `SecretRef` (`{ secret, prefix?, optional? }`); top-level `requires`/`optional`/`headerPrefixes` deleted; per-variant field allowlists; `GUIDE_SCHEMA_VERSION` → `1`. Runtime: `oauth-store.ts` (per-domain token store), `resolveAccessToken` (mint → cache → lazy refresh, per-domain in-flight lock, 60s skew buffer), `/api oauth <domain>` (`--status`/`--refresh`/`--revoke`/`--code`), oauth2 arms in all eight `switch (auth.kind)` consumer sites, Bearer/query injection riding the existing scrub + SSRF paths. | `core/api-guide-types.ts`, `core/auth.ts`, `core/oauth-store.ts`, `core/parse-api-guide.ts`, `core/resolve-op.ts` |
| **2 — Authorization code + PKCE** | `core/oauth-flow.ts` (PKCE pair gen, authorize URL, paste exchange, `mintAuthCodeToken`), `/api verify` oauth2 precheck arm, probe inline `auth.useTokenStore` (store-read; miss → note, never fail-closed). | `core/oauth-flow.ts`, `core/oauth-command.ts`, `core/verify-command.ts`, `tools/api-probe.ts` |
| **2.5 — Final auth shape (pre-freeze)** | Deleted the oauth2 form-field map + `apiHeaders`; client auth is two named refs (`clientId: SecretRef` required, `clientSecret?: SecretRef`) + `tokenEndpointAuthMethod`. Deleted `pkce` (implicit), `redirectUri` (2.6), and semantically impossible ref flags (`prefix`/`optional` on `clientId`; `optional` on `clientSecret` for cc). Request decoration is uniform across kinds (`secretRefs` headers, `secretQueryRefs` params, `headers` literals). | `core/api-guide-types.ts`, `core/parse-api-guide.ts` (`validateOAuth2`) |
| **2.6 — Headless-only paste flow** | The loopback listener + interactive callback capture were **deleted** — the paste path is the only auth-code path. `redirectUri` deleted from the schema; the runtime convention `http://127.0.0.1/callback` (RFC 8252 §7.3) replaces it. Paste parsing accepts the full address-bar URL (default — enables `state` validation + provider `?error=` surfacing), a bare query, or a bare code. The `127.0.0.1` spelling (not `localhost`) is required by OSM and recommended by RFC 8252 §7.3 itself; the paste parser is host-agnostic. | `core/oauth-flow.ts`, `core/oauth-store.ts` |
| **Post-plan: guide-less `/api oauth`** | Bare listing + `--status`/`--revoke` work guide-less on the literal domain (tokens outlive their guide); revoke is local-only without a guide's `revokeUrl` and also clears any pending flow. Minting/refreshing still needs a guide or `init`. | `core/oauth-command.ts` |
| **Post-plan addendum: probe mint-on-demand** | Probe's inline `auth` block accepts client-credentials mint fields (`tokenUrl` + `clientId` [+ `clientSecret`, `scopes`, `tokenEndpointAuthMethod`] — store NAMES); on a store miss it mints once, stamps the token store, injects the Bearer. Auth-code is not inlined (the pending state is command-shaped — see 2.7). | `tools/api-probe.ts` (`resolveProbeAuth`) |
| **2.7 — Human guide-less bootstrap** | `/api oauth init <domain>` wizard: interactive prompts (TUI) or headless flags; both grants; two-call `init … --code` headless completion; parent-domain token-store normalization shared with the probe. | `core/oauth-command.ts` (`handleOauthInit`), `core/auth.ts` (`buildSyntheticOAuth2Auth`) |
| **2.8 — Agent-driven bootstrap** | `oauth-mint` (learn-gated tool) + `/api bootstrap oauth <domain> <spec>` (inject-and-exit command). Locked spec + semantics: [`oauth2-agent-bootstrap.md`](./oauth2-agent-bootstrap.md). Tool count 18→19 suite / 5→6 host. | `tools/oauth-mint.ts`, `core/api-toggle.ts`, `core/select-picker.ts` (`pickChecklist`) |
| **2.9 — Token-slot multi-grant + multi-issuer** *(landed)* | Token slots keyed by `(storeDomain, grant, tokenUrl)` instead of bare domain. Closes the clobber hole: minting a user token for one domain no longer wipes its app token, and two OAuth issuers behind one API domain get separate slots. Zero schema change, zero author ceremony — the slot derives entirely from facts every consumer already carries in its `OAuth2Auth` object. | `core/oauth-store.ts` (`slotKey`, slot map, tmp+rename writes, `.pending.json` listDomains fix), `core/auth.ts` (slot-aware reads/writes + `(domain, slot)` refresh lock), `core/oauth-command.ts` (per-slot listing, grant qualifier, guide-less orphan slots), `core/oauth-flow.ts`, `tools/api-probe.ts` (`grant` param + loud slot-key validation), `tools/oauth-mint.ts` (slot delete-before-mint + overwrite warning) |
| **Post-plan: `api-store` inspection** | Learn-gated read-only combined view over both stores (the agent-facing read of the self-describing token store 2.9 created): bare call → orphan view, `domain`/`apiHost` → provisioned/declared/gap secrets + token slots + declared-slot gaps → `oauth-mint`. Probe's `listSecrets` arm was removed (clean removal, no deprecation — host is all `[Unreleased]`); probe is pure shape discovery again. The store-domain seam now lives in `core/auth.ts` (`resolveProvisionedParentDomain` + `hostnameOf`); the former `resolveProbeStoreDomain` wrapper was deleted rather than moved (it was a pure alias). Spec + decision record: [`api-store-inspection-tool.md`](./api-store-inspection-tool.md). Tool count 19→20 suite / 6→7 host. | `tools/api-store.ts`, `tools/api-probe.ts`, `core/auth.ts`, `core/api-toggle.ts` |

**Deferred by decision:** the `isStaleSchema` hard-gate flip (`isStaleSchema` stays a non-blocking ⚠ warning) — its own plan doc lives at
[`schema-version-hard-gate.md`](./schema-version-hard-gate.md); it lands under the coordinated `0.5.0` step alongside the caritas re-stamp.

## Grants: realized vs deferred

Realized: **authorization_code + PKCE** (the user consents in their own
browser — the agent never sees provider credentials), **client_credentials**
(pure HTTP), and **refresh token** as the lazy lifecycle mechanism both
produce. Everything else is deliberately out (see **Deferred**): device flow
(the paste path subsumes its usability), implicit + password grants
(deprecated), multiple accounts per domain, scope management UI, background
refresh worker, OS-keychain token backend (additive seams, same as the
secrets store).

## Why portal is NOT a runtime dependency

The user consents in **their own browser** at the provider, logging in with
their own credentials. Routing that through portal's driven browser would
flow the user's provider password through agent context — a hard no. So the
auth-code flow is host-only: host prints the authorize URL (with a PKCE
challenge), the user pastes back the redirect URL their browser lands on at
`http://127.0.0.1/callback`, host validates `state` and exchanges the code.
No static portal import, no listener, no inbound network surface — the flow
works unchanged whether pi runs on the user's machine, in a container, or
inside a VM. Portal is used only for the one-off research/authoring step,
not by shipped code.

## The frozen v1 auth shape

`AuthConfig` is the discriminated union below (v1, frozen under `0.5.0`).
The flat pre-union interface is gone; every consumer is a `switch
(auth.kind)` with a `default: never` exhaustiveness arm, so a new kind is a
compile error at every consumer seam.

```ts
interface NoneAuth { kind: "none"; headers?: Record<string, string> }

// Self-contained secret reference. Availability + prefix live HERE
// (default: required, fail-closed when absent) — not in a separate roster.
// This makes the old ref-consistency checks structurally unnecessary.
interface SecretRef {
  secret: string;          // store name
  prefix?: string;         // e.g. "Bearer " — applied at resolution time
  optional?: boolean;      // default false (absent → fail-closed)
}

interface StaticKeyAuth {
  kind: "static-key";
  headers?: Record<string, string>;
  secretRefs?: Record<string, SecretRef>;        // header name → ref
  secretQueryRefs?: Record<string, SecretRef>;   // query param name → ref
}

interface OAuth2Auth {
  kind: "oauth2";
  grant: "client_credentials" | "authorization_code";
  tokenUrl: string;
  clientId: SecretRef;          // required for both grants
  clientSecret?: SecretRef;     // parser-required for client_credentials; absent for PKCE public clients
  secretRefs?: Record<string, SecretRef>;  // request headers — SAME semantics as static-key
  scopes?: string[];
  paramStyle?: "bearer-header" | "query";        // default bearer-header
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  authorizeUrl?: string;        // parser-required iff grant === "authorization_code"
  revokeUrl?: string;           // optional revocation endpoint
}

type AuthConfig = NoneAuth | StaticKeyAuth | OAuth2Auth;
```

```yaml
# static-key — nested refs replaced the flat secretRefs + requires/optional/headerPrefixes trio
auth:
  kind: static-key
  secretRefs:
    Authorization:
      secret: api_key
      optional: true     # default: required (fail-closed)

# oauth2 client_credentials (Twitch-shaped)
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://id.twitch.tv/oauth2/token
  clientId: { secret: client_id }
  clientSecret: { secret: client_secret }
  tokenEndpointAuthMethod: client_secret_post
  secretRefs:                 # identical meaning to static-key
    Client-Id:
      secret: client_id
```

The shape decisions and why they hold:

+ **Nested `SecretRef` everywhere.** One self-contained entry per secret
  (`{ secret, prefix?, optional? }`) replaces the old three-field split
  (`secretRefs` + `optional` + `headerPrefixes`), making ref/availability
  divergence structurally impossible — the parser's ~85-line consistency
  block was deleted with it. `resolveSecretHeaders` applies `ref.prefix`
  inline. Post-2.5 the keys mean **request header names** on every kind —
  never form-field names (the 2.5 `apiHeaders`/form-map wobble is deleted).
+ **Client auth at the token endpoint is two named refs + a method**, never
  an open-ended map: `clientId`/`clientSecret` as SecretRefs +
  `tokenEndpointAuthMethod` (`client_secret_basic` / `client_secret_post` /
  `none`; RFC 6749 §2.3.1). Store-resolved values appear **only** as
  `SecretRef.secret` — a shippable recipe bakes in no per-user credentials.
+ **The redirect URI is not in the schema.** It's a fact of the *user's* app
  registration, not the provider's API. The runtime owns it via the
  convention `http://127.0.0.1/callback` (RFC 8252 §7.3 — loopback, variable
  port; nothing listens there — the paste flow owns it end-to-end, see 2.6).
  The only auth-code-only per-provider fact is `authorizeUrl`.
+ **PKCE is implicit.** `grant: authorization_code` is always PKCE; a field
  whose only legal value was `true` is authoring ceremony. An opt-out, if a
  no-PKCE provider ever appears, is a relaxing post-freeze non-event.
+ **Per-variant field allowlists** replace the global `KNOWN_AUTH_KEYS` —
  each variant rejects fields not legal for it (the old `none`
  field-presence check became the `NoneAuth` allowlist).
+ **Deliberately omitted** (additive post-freeze, non-events when a recipe
  needs them): oauth2 `secretQueryRefs`, oauth2 literal `headers`, static
  extra token-endpoint params. The likeliest first need is Auth0's machine
  apps (a static `audience` form param) — the sanctioned future fix is
  `tokenEndpointParams?: Record<string, string>` (**literal values only**;
  secrets belong in refs — never resurrect the deleted form map). For a
  future ROPC (`grant: "password"`, see
  [`oauth2-peertube-login-followup.md`](./oauth2-peertube-login-followup.md)):
  token-endpoint credentials must be **named optional fields** (e.g.
  `username?: SecretRef`) or prompt-sourced — never a `secretRefs` overload.

## Landed flow behavior (the parts future work must not break)

+ **Auth-code flow is the paste path, headless-only (2.6).** The interactive
  loopback-listener path was deleted: its entire delta over paste was one
  saved copy-paste, against an HTTP server, port/NAT caveats, timeout and
  cleanup logic in the environments pi actually runs in (VMs, containers).
  Flow: pi prints the authorize URL (PKCE challenge, state,
  `redirect_uri=http://127.0.0.1/callback`) → user consents in their own
  browser → provider redirects to a dead page → user pastes the address-bar
  URL (or bare code) → pi validates `state`, exchanges (+ verifier), stamps.
  Paste parsing accepts the full URL (default — enables state validation +
  provider `?error=` surfacing) or a bare code. The pending flow survives a
  failed paste so the user retries without re-authorizing.
+ **The redirect URI is a flow-start parameter with the RFC 8252 default
  (post-2.6 addendum).** The default `http://127.0.0.1/callback` can't serve
  every provider — Twitch accepts only https (or the `localhost` spelling)
  for loopback, OSM only `http://127.0.0.1*` — and the URI is a fact of the
  USER's app registration anyway, so it stays out of the schema and is
  overridable per invocation: `--redirect-uri <url>` on `/api oauth` / `init`,
  the `redirectUri` param on `oauth-mint`. It rides the existing token-URL
  confirm prompt (same trust class — it decides where the provider sends the
  code), and the pending flow record stores it so the `--code` completion
  exchanges with the SAME value (RFC 6749 §4.1.3) without re-supplying the
  flag. A client_credentials mint never touches it.
+ **Guide-less bootstrap (2.7):** `/api oauth init <domain>` wizard, both
  grants. Plain `/api oauth <domain>` never state-forks into a wizard — one
  meaning, no guide-present/absent dispatch fork. Credentials are
  **secrets-store NAMES** picked from what's provisioned (values never enter
  the transcript; a miss points at `/api secrets`). Token-store keying
  applies the probe's parent-domain normalization against the **secrets**
  store; the stamp-time note surfaces the ordering dependency ("provision
  secrets under the same domain the guide will claim as `domains[0]`").
  Headless completion is the two-call `init <domain> <same flags> --code
  <paste>` — `init` owns it because `completePastedCode` needs the
  flag-reconstructed synthetic auth, which plain `/api oauth` can't derive
  guide-less.
+ **Agent-driven bootstrap (2.8):** `/api bootstrap oauth <domain> <spec>`
  inject-and-exit + `oauth-mint` (fail-closed validation, store-name
  precheck, token-URL confirm first, scopes ✓/○ checklist, paste prompt,
  cancel → the two-call `init … --code` escape hatch). Full semantics:
  [`oauth2-agent-bootstrap.md`](./oauth2-agent-bootstrap.md).
+ **Token lifecycle:** lazy on-demand refresh inside `resolveAccessToken`
  (store read fresh every call; no background worker), per-slot
  `Map<string, Promise>` refresh lock (prevents double-spending a rotated
  refresh token), `expiresAt − 60_000` skew buffer. Slots are keyed
  `(storeDomain, grant, tokenUrl)` — Phase 2.9 (landed) — so one domain can hold an
  app token and a user token (and tokens from two issuers) without
  clobbering. `client_secret` lives in the secrets store; only minted
  tokens live in the token store (separate 0600 files — tokens rotate and
  have structure).
+ **Token endpoints POST via a small helper in `core/auth.ts`
  (`oauthPost`)** — never through `transport.ts` (GET-only by contract).
  Secret values are scrubbed from error bodies. The probe's mint-on-demand
  and both bootstrap surfaces feed the same `resolveAccessToken` /
  `mintAuthCodeToken` machinery, so cache/refresh/lock/stamp is shared code.

## Phase 2.9 — Token-slot multi-grant + multi-issuer (landed)

**The hole.** The token store was one file per domain (`<domain>.json`); the
grant lived only on the guide's auth block. Minting a `client_credentials`
token for one guide, then an `authorization_code` token for a sibling guide
on the same domain, silently overwrote the first token — and each guide's
lazy-refresh re-minted its *own* grant over the other's slot forever after.
Live example: Twitch app-token (63 both-type endpoints) vs a future
user-token guide (55 user-only endpoints) on `twitch.tv`. A second hole:
two OAuth **issuers** behind one API domain (same grant, different
`tokenUrl`) would also clobber — discovered reviewing whether API versions
(`v1`/`v2`) or per-dataset tokens need distinct slots (they don't: versions
live in paths; same-issuer tokens are shared by design).

**The fix.** Slot key = `(storeDomain, grant, tokenUrl)`, realized as an
**in-file slot map** (status: **landed**). The token store stays one file per domain
(`<domain>.json`); the file now holds `Record<slot, StoredToken>` where
`slot = <grant>__<hash(tokenUrl)>`. This converges on the secrets store's
shape — which is already a per-domain file keyed by name
(`Record<name, value>`) and which this store's own header comment claims to
mirror — instead of a filename-as-database layout of
`<domain>__<grant>__<issuer-slug>.json` files.

+ Same domain + same grant + same issuer → same slot (multi-recipe domains
  keep sharing — `internet-archive`/`wayback-availability` unchanged).
+ Any difference → different slot key, same file. No `tokenKey` field in
  the schema: the slot derives from `auth.grant` + `auth.tokenUrl`, both
  parse-required, both already carried by every consumer
  (`resolveAccessToken`, `mintAuthCodeToken`, `buildSyntheticOAuth2Auth`,
  probe inline auth).
+ Derivation is **internal to the store layer** — the eight
  `switch (auth.kind)` consumer sites and all tool/command entry points
  keep their signatures.
+ **Why in-file map, not one file per slot:** a slot-per-file layout makes
  the filename the database, and every "which slots exist" consumer
  (guide-less `--status`/`--revoke` orphan enumeration, keychain backends)
  then has to structurally parse `<domain>__<grant>__<hex>` filenames —
  with `assertSafeDomain` permitting `__` inside domains, bare prefix
  matching is ambiguous and enumeration needs a grant-enum grammar. The
  in-file map gets slot enumeration for free (`Object.keys` of the file —
  exactly the secrets store's `listNames` pattern) and keeps the
  `TokenStore` backend swap clean (one keychain entry per domain, not one
  per slot with mangled keys). Costs, both accepted: in-process cross-slot lost-update is
  **impossible** as long as `write()`'s read-modify-write stays synchronous
  (sync read+write with no `await` between is atomic wrt the event loop —
  the same property the secrets store already relies on); the per-slot
  refresh lock's job is only the same-slot double-refresh (rotated refresh
  token), not cross-slot serialization. Cross-**process** writers on one
  domain file remain last-writer-wins — the same race class the secrets
  store already accepts — and tmp+rename covers crash, not concurrency
  (different mechanisms; both worth a doc line). A crash mid-write would
  otherwise corrupt all slots of the domain rather than one — mitigated by
  a ~4-line tmp-file + `renameSync` in `write()` (atomic on POSIX;
  recommended here; tokens are re-mintable, and a corrupt file already
  reads as absent today).

**What changed (implementation record)** — the pre-implementation checklist
below was executed with one deviation: the slot read/write/delete convenience
API takes `(domain, grant, tokenUrl)` directly (derivation fully internal to
the store layer) rather than a caller-precomputed slot; `slotKey` is exported
for the refresh lock map (`(domain, slot)` keys) and orphan enumeration. The
`.pending.json` `listDomains` leak and the empty-file prune were fixed as
planned. Original checklist kept for reference:

+ `core/oauth-store.ts` — `TokenStore` becomes (domain, slot)-keyed:
  `read(domain, slot)`, `write(domain, slot, token)`, `delete(domain,
  slot)`, `listSlots(domain)`; `listDomains()` unchanged (one
  `<domain>.json` per domain, pruned when its last slot is deleted — the
  secrets store's empty-file pattern; while reworking `listDomains`, fix
  the pre-existing filter leak: `endsWith(".json")`
  (`oauth-store.ts:145-147`) counts `<domain>.pending.json` as a domain,
  so a live pending flow surfaces as a bogus `example.pending`
  "unreadable" row in bare `/api oauth` — exclude `.pending.json`). `slotKey` lives in the store and
  takes grant + tokenUrl **structurally** (the two fields it needs, no
  `OAuth2Auth` — the store layer stays free of `auth.ts` types). Slot =
  `<grant>__` + **hashed full tokenUrl** — hash the complete URL string,
  never just the path: two issuers behind one API domain can differ by host
  only, e.g. `tenant-a.auth0.com/oauth/token` vs `tenant-b.auth0.com/oauth/token`,
  and a path-only hash recreates the exact multi-issuer clobber this phase
  exists to fix; **keep ≥16 hex chars of the SHA-256** — shorter truncation
  risks cross-issuer collisions on tenant-farm issuers like Auth0. TokenUrl
  *spelling* differences (`/oauth/token` vs `/oauth/token/`, http vs https)
  fragment slots rather than clobber them — harmless, just expected. The
  stored token record gains `grant` + `tokenUrl` (self-describing store —
  status rows can render the real issuer instead of the opaque hash; readers
  need no legacy branch, pre-release tokens are re-minted not migrated).
  `write()` is read-modify-write on the domain file; harden it with
  tmp-file + `renameSync` (atomic on POSIX) so a crash can't shred every
  slot at once. Pending flow: `<domain>.pending.json` becomes
  `Record<slot, PendingAuthCodeFlow>` — only `authorization_code` ever
  writes pending entries, so the pending slot is always the auth-code slot.
  It stays a separate file outside `TokenStore` on purpose: ephemeral
  scratch that survives a keychain backend swap.
+ `core/auth.ts` — **every** `readToken`/`writeToken`/`deleteToken` call
  site derives its slot via `slotKey(auth)`, not just the two originally
  named. Full inventory: `resolveTokenUnlocked` + the refresh-lock map
  (keyed by the *same* helper as the store — two derivations that can
  diverge are a second clobber), `authStatusLine`'s oauth2 branch (a
  bare domain read post-2.9 would report "no token" even when the slot
  exists), `hasUsableTokenPath` (used by `/api verify`'s oauth2 precheck —
  a bare domain read would wrongly refuse ops whose token exists),
  `forceRefreshToken`, and `revokeAccessToken`. Also: the
  `deleteToken(domain)`-before-mint in the `--refresh` client-credentials
  path and `init`'s client-credentials arm must use the slot derivation —
  a bare delete leaves a stale prior-grant slot surviving a refresh.
  `buildSyntheticOAuth2Auth` unchanged (flags already reconstruct grant +
  tokenUrl, so two-call `init … --code` completion lands in the same slot).
+ `core/oauth-command.ts` — bare listing shows per-slot rows
  (`domain · grant · issuer`); `--status`/`--refresh`/`--revoke` take an
  optional grant qualifier **only when a domain has 2+ slots** (single slot
  keeps today's one-argument behavior; two slots without a qualifier →
  listing + usage error, never a guess). **Guide-less paths need their own
  slot story** (they have no auth object to derive from): single-domain
  `--status <domain>` / `--revoke <domain>` on orphaned tokens use
  `listSlots(domain)` and act on each slot (rows for status; per-slot
  delete for revoke; pending entries deleted per-slot alongside), instead
  of today's bare `readToken(domain)` / `deleteToken(domain)` which
  post-2.9 would find/delete nothing — with the in-file map this is
  `Object.keys` of the domain file, no filename parsing anywhere. Status
  rows render the real issuer (the stored record carries `tokenUrl`).
  Slot-scoped reads/deletes beyond the guide-less arm (pre-implementation
  review found these; `auth` is in scope at every one): the guide-backed
  `--revoke` arm's bare `deletePendingFlow(storeDomain)`
  (`oauth-command.ts:274`) must derive the slot or a stale pending entry
  survives revoke and a later `--code` paste reads a stale verifier; the
  guide-backed `--status` read (`:283`) reads the slot, not the domain; and
  the `--help` text hardcodes "stored per-domain … `<domain>.json`"
  (`:91`) — update it in this landing. Also update the `oauth-store.ts`
  header comment ("one token object per domain") and the probe tool-param
  descriptions for the new `grant` field and `tokenUrl`'s new
  load-bearing role in the store read. Optional free improvement: apply the
  same parent-domain normalization `init` uses
  (`resolveProvisionedParentDomain`) to orphan enumeration so a subdomain
  spelling still finds the slot (today's literal-domain behavior finds
  nothing — consistent, but 2.9 touches this arm anyway).
+ `core/oauth-flow.ts` — pending-flow read/write/delete keyed by slot (an
  entry in the per-domain pending map; only the auth-code slot ever has
  one); `completePastedCode` derives the slot from the synthetic auth.
+ `tools/api-probe.ts` — **one change, not zero**: the `useTokenStore: true`
  arm calls `readToken(domain)` with no auth object, so post-2.9 it must
  carry the same inline `grant` + `tokenUrl` facts the mint-on-demand arm
  already has (they key the store lookup); without them it looks for a slot
  that never exists. The probe **tool-param schema gains `grant`** (guide
  schema untouched — "zero schema change" refers to the guide schema only;
  `tokenUrl` also becomes load-bearing for the store read, not just mint).
  A `useTokenStore: true` call without `grant` + `tokenUrl` post-2.9 is a
  **loud validation error**, not a silent store miss with a misleading
  "run /api oauth" note. Residual (pre-existing, not a 2.9 regression,
  worth a doc line): probe's store-domain resolution
  (`resolveProvisionedParentDomain(hostnameOf(apiHost))` — since the
  `api-store` landing this lives in `core/auth.ts` and is shared with
  `api-store`, overridable via `opts.domain`) can normalize to a parent
  domain while a guide's token lives at `domains[0]`
  (`canonicalStoreDomain`) — the useTokenStore read can miss across that
  seam today too.
+ `tools/oauth-mint.ts` — **not zero changes** (the original checklist
  wrongly claimed auth-object carriers need none): the client-credentials
  arm does a bare `deleteToken(storeDomain)` before minting
  (`oauth-mint.ts:242`) — the identical delete-before-mint pattern the
  `--refresh` and `init` arms already have on the checklist. Post-2.9 the
  bare delete targets a slot that no longer exists, so a stale
  prior-grant/prior-issuer slot survives a re-mint — the exact clobber
  class this phase exists to fix, inside one of the three bootstrap
  surfaces. Fix: derive the slot from `finalSynthetic` (it already carries
  grant + tokenUrl) and slot-delete (a map-key delete now, not a file
  delete). Also add the mint-time overwrite
  warning (see "Reserved on paper" below): when the target slot already
  holds a token, warn "overwriting existing token for this slot
  (previous scope: X)" before minting — the same-grant scope collision is
  reachable through all three bootstrap surfaces and deserves a cheap
  signal.
+ `core/verify-command.ts` — **no changes** (its precheck goes through
  `hasUsableTokenPath`, which is now slot-aware inside `auth.ts`).
+ Tests — `__tests__/oauth.test.ts` gains the both-grants-one-domain
  non-clobber case; `__tests__/oauth-flow.test.ts` pending-slot isolation;
  oauth-command tests cover the disambiguation arm **and** the guide-less
  orphan-slot status/revoke paths (token *and* pending entries), plus the
  empty-file prune when a domain's last slot is deleted. **Also broken by
  the shape change — add to the checklist:** the bare-domain
  `writeToken(domain, …)` fixtures in `__tests__/verify-command.test.ts`
  (line ~399), `__tests__/api-probe.test.ts` (lines ~547/623/726),
  `__tests__/oauth.test.ts` (lines ~169/184/209/318/420/428/436), and
  `__tests__/oauth-flow.test.ts` (line ~317) — every one writes the old
  flat `<domain>.json` shape that slotted reads will miss, going red on
  landing (the TS signature change catches these, so the checklist is
  completeness, not correctness). Two files contain **zero `writeToken`
  calls** — an implementer grepping `writeToken(` would miss them:
  `__tests__/oauth-mint.test.ts` (lines ~188/223/249/334/384) and
  `__tests__/oauth-command.test.ts` — both need bare `readToken`/
  `readPendingFlow` assertion updates, not write-fixture rewrites.
+ Docs — this section; AGENTS.md token-store bullet; the deferred
  multiple-accounts bullet now points here; the `--help` layout string in
  `oauth-command.ts` (called out above).

**Landed deviation (one, deliberate):** probe's `useTokenStore` slot key
requires `grant` + `tokenUrl` per the checklist — implemented as a thrown
validation error from `resolveProbeAuth` (surfaced by the tool's error
path), and the guide-less orphan `--status`/`--revoke` arms apply
`resolveProvisionedParentDomain` normalization (the plan's optional
improvement). **Reserved on paper (not implemented):** `tokenKey?: string` on
`OAuth2Auth` — the sanctioned future fix when a recipe needs two same-grant
slots. Slot becomes
`<grant>__<hash>__<tokenKey>` — one more map key; additive, non-breaking,
tokens re-mint on first use, zero file-layout change. **Known same-grant collision, deliberately deferred:**
two sibling guides on one domain with the same grant, same tokenUrl, but
different `scopes` (or different `clientId` — two app registrations)
collapse into one slot; whoever mints/refreshes first wins, and
`refreshAccessToken` doesn't re-send scopes, so the token keeps the first
guide's scope. Folding `scopes`/`clientId` into the slot key would be
wrong — it fragments legitimately shared same-issuer tokens and orphans
probe-minted slots — so `tokenKey` is the relief valve. **Name this when it
bites:** a future sibling-guide-with-different-scopes bug is the reserved
`tokenKey` seam, not a 2.9 regression. Because the collision is reachable
today through all three bootstrap surfaces (`init` with different
`--scopes`, `oauth-mint` with different picked scopes, sibling guides),
2.9 ships a **mint-time overwrite warning**: when the target slot already
holds a token, mint surfaces "overwriting existing token for this slot
(previous scope: X)" — cheap mitigation until `tokenKey` is ever needed. Also deferred: per-op grant override
(an op needing a different grant belongs in a sibling guide). The likeliest
first consumer of `tokenKey` is the deferred ROPC `/api login`
([`oauth2-peertube-login-followup.md`](./oauth2-peertube-login-followup.md))
— ROPC tokens are account-scoped, so a second user on one PeerTube instance
is a second same-grant slot.

**Migration:** none — pre-release branch (host is entirely under
`[Unreleased]`; 0.4.0 shipped with `oauth2` rejected at parse, so no shipped
version ever had a domain-keyed token store). The two dev-minted tokens
(mastodon.social, twitch.tv) get re-minted under the new slot map when this
lands.

## Remaining work

### Phase 3 — Axis coverage + caritas recipes (open)

+ **Host axis guide** — add the synthetic OAuth2 axis guide chosen in
  Phase 0 (see [`oauth2-flow-research.md`](./oauth2-flow-research.md)) to
  `api-guides/`, with a co-located mocked-transport test exercising token
  injection + refresh + fail-closed. Update the
  `__tests__/axis-coverage.test.ts` matrix (kept-set count + auth-kind axis:
  `none` + `static-key` + `oauth2`) and the
  `__tests__/all-guides-parse.test.ts` auth-kind assertion (extend to
  `oauth2`). Move `oauth2` from "Deferred" to "Built-in" in
  `api-helper-escape-valve.md`'s classification table.
+ **Caritas recipes** — publish the Phase-0 client-credentials recipe and
  the auth-code-with-PKCE recipe into
  [`caritas`](https://github.com/coreyryanhanson/caritas) with live tests
  (`HOST_INTEGRATION=1`) and `verified:` dates. Caritas owns the drift
  disclaimer; host ships only the synthetic axis fixture. **Every caritas
  guide also gets `schemaVersion: 1` stamped** (hard-gate flip below) and
  any static-key guide gets its auth block rewritten to the nested
  `SecretRef` shape — a one-time `0.5.0` migration, not ongoing drift.
  Phase 2.8's bootstrap is the tool for the auth-code live runs.

### The coordinated 0.5.0 hard-gate flip (open)

The `GUIDE_SCHEMA_VERSION` bump already landed (Phase 1); the **hard-gate
flip** is deliberately deferred until caritas re-stamps its corpus. Full
implementation plan: [`schema-version-hard-gate.md`](./schema-version-hard-gate.md).
Summary: `isStaleSchema` flips from a non-blocking ⚠ warning to a **hard
load refusal** (fail-loudly; no deprecated reading code), the
`schema-version.test.ts` "never a gate" assertions invert, and the AGENTS.md
`schemaVersion` + bump-rule sections are amended (the bump rule gains its
explicit trigger for breaking TS-type/YAML-shape changes to `AuthConfig` —
the v1 union refactor is the precedent). Every caritas guide gets stamped
`schemaVersion: 1`; static-key guides additionally get the nested
auth-block rewrite. This ships as one PR of the coordinated `0.5.0` release.

## Cross-cutting decisions (still binding)

+ **Host-only boundary.** `oauth-flow.ts` never statically imports
  `pi-lean-portal` (the user's provider password must never flow through
  agent context). No listener ⇒ no inbound network surface.
  `__tests__/host-only-boundary.test.ts` stays green.
+ **Transport stays GET-only.** OAuth2's token/refresh/revocation POSTs are
  auth plumbing, not user ops — they stay scoped to the small `oauthPost`
  helper in `core/auth.ts`. The general mutations / write-gate deferral
  stands; do not generalize `transport.ts` into a write-capable pipeline.
+ **Token store ≠ secrets store.** Tokens rotate and have structure; raw
  secrets don't. Two 0600 file stores with the same interface shape beat one
  overloaded file. Both are swappable backends (deferred OS-keychain
  upgrade).
+ **`client_secret` lives in the secrets store**, referenced via the named
  `clientSecret: { secret: … }` ref; only minted tokens live in the token
  store. Auth-code `clientSecret` is optional (PKCE public clients omit it).
+ **Lazy refresh, serialized per domain, skewed early** — see "Landed flow
  behavior"; add a background worker only if a recipe's token TTL makes
  on-demand latency hurt.
+ **Bearer by default; `paramStyle: query` rides the existing URL-redaction
  path** (`access_token` per RFC 6750 §2.3 enters `secretQueryParamNames`,
  so every surfaced URL redacts it).
+ **Per-variant field allowlists** keyed by `kind` (the global
  `KNOWN_AUTH_KEYS` set is gone).
+ **Schema-version bump rule (amended):** breaking TS-type or YAML-shape
  changes to `AuthConfig` bump `GUIDE_SCHEMA_VERSION` even when parse
  behavior relaxes; additions are non-events. See
  [`schema-version-hard-gate.md`](./schema-version-hard-gate.md) for the
  pending hard-gate flip.

## Deferred (explicitly out of scope)

+ Device flow (RFC 8628) — the paste path covers usability.
+ Implicit / password grants — deprecated, never.
+ Multiple accounts per domain (one token set per slot — slots are
  `(domain, grant, tokenUrl)`, see Phase 2.9; a same-grant second account
  is the reserved `tokenKey` seam).
+ Scope management UI (scopes are static in the guide / tool params).
+ Background refresh worker (lazy refresh covers it; add if a recipe's TTL
  makes on-demand latency hurt).
+ OS-keychain token backend (additive upgrade seam, same as secrets store).
+ Token introspection / JWKS validation (the provider validates; we store
  what it returns).
+ General write/POST surface beyond OAuth2's own token endpoints.
+ Wizard/tool growth: DPoP, PAR, device flow, JWT assertions, ROPC must NOT
  grow wizard branches or the synthetic-auth constructor — provisioning aid,
  not an OAuth playground.

## Exit criteria

+ [x] `kind: oauth2` parses (both grants), loads, and runs through the
  existing `resolveOpForExecution` path; Bearer tokens are injected,
  scrubbed, and refreshed lazily.
+ [x] `/api oauth <domain>` provisions tokens (client-credentials: pure
  HTTP; auth-code: print-URL + paste-back, headless-only per 2.6, works
  across VM/container boundaries), headless-safe, not focus-guarded.
+ [ ] A synthetic OAuth2 axis guide + co-located mocked test land in host;
  `axis-coverage.test.ts` and `all-guides-parse.test.ts` matrices updated;
  escape-valve doc table updated. *(Phase 3 — open)*
+ [ ] One client-credentials + one auth-code-with-PKCE recipe land in
  caritas with live tests and `verified:` dates; every caritas guide stamped
  `schemaVersion: 1` and static-key guides rewritten to nested `SecretRef`.
  *(Phase 3 / caritas — open)*
+ [x] `GUIDE_SCHEMA_VERSION` bumped `0` → `1`; all eight consumer sites on
  `switch (auth.kind)`; per-variant field allowlists in place;
  ref-consistency block deleted; host-only boundary test green.
+ [ ] `isStaleSchema` flipped to a hard gate; AGENTS.md bump rule +
  `schemaVersion` section amended; caritas corpus re-stamped — coordinated
  `0.5.0` step, own plan at
  [`schema-version-hard-gate.md`](./schema-version-hard-gate.md).
