# OAuth2 Flow — High-Level Plan

> Realize the `auth.kind: oauth2` seam that is currently **declared but
> rejected at parse** (see `core/parse-api-guide.ts` `validateAuth`,
> `core/helpers.ts` `checkAuth`, and the "Deferred / out of scope" section of
> [`api-helper-escape-valve.md`](./api-helper-escape-valve.md)).
>
> This is a plan doc, not a spec. It names the seams to touch, the grants to
> realize, the grants to defer, and scopes the browser-research step early.

## Current state (the seams already in place)

The framework was built with OAuth2 in mind — most of the load-bearing seams
already exist, which is why this is mostly additive:

- **Schema seam** — `AuthKind = "none" | "static-key" | "oauth2"` and
  `KNOWN_AUTH_KINDS` already include `"oauth2"`
  (`core/api-guide-types.ts`). `AuthConfig` is a **flat interface today** —
  every auth field (`headers`, `secretRefs`, `headerPrefixes`,
  `secretQueryRefs`, `requires`, `optional`) sits on one bag of optionals
  for *every* kind, and every consumer narrows at runtime via
  `auth.kind === "static-key"` string checks (six call sites today:
  `helpers.ts`, `resolve-op.ts`, `verify-command.ts`, `auth.ts`,
  `secrets-command.ts`, `parse-api-guide.ts`). OAuth2 does not slot into
  that flat bag cleanly — see the **Auth type reshape** section below for
  the discriminated-union refactor this plan now commits to, and the schema
  bump to v1 it triggers.
- **Parse rejection** — `validateAuth` returns a fail for `kind: oauth2` with
  a "not yet implemented" `fix`. Un-reject + add a validator.
- **Dispatch seam** — `checkAuth` (`core/helpers.ts`) already branches on
  `kind` and throws for the unrealized case. The `resolveOpForExecution`
  sequence (`core/resolve-op.ts`) already has an auth-resolution block
  (steps 3) that resolves store secrets, fails closed on missing `requires`,
  and hands `authOpts` to the executor + the caller's output-channel scrub.
  OAuth2 slots into that same block.
- **Secrets store** — `core/secrets-store.ts` is a swappable `SecretStore`
  interface (0600 file backend, lazy-mkdir-on-write). Holds raw credentials;
  names-only listing. OAuth2 reuses this for `client_secret` and could host
  tokens, but **tokens rotate** — see the token-store decision below.
- **Interactive provisioning** — `/api secrets [domain [name]]`
  (`core/secrets-command.ts`) is the precedent for a metadata-only, headless-
  safe, focus-guard-exempt subcommand driven by `ctx.ui.input()`. OAuth2 gets
  a peer `/api oauth <domain>` subcommand.
- **Auth-bearing request path** — `transport.ts` already forces the
  SSRF-guarded redirect path for any auth-bearing request and strips
  `Authorization` + named secret headers on cross-domain hops. An OAuth2
  Bearer token rides this same path for free.
- **Output-channel audit** — `scrubSecretValues` / `containsSecret`
  (`core/auth.ts`) already redact known secret values from bodies, error
  bodies, and surfaced URLs. The access token is just one more value to add
  to the `secretValues` list in `resolveOpForExecution`.
- **Host-only boundary** — `__tests__/host-only-boundary.test.ts` forbids
  static imports from `pi-lean-portal`/`pi-lean-search`. The OAuth2 runtime
  flow must stay host-only (it does — see "Why portal is not a runtime dep"
  below).
- **Axis coverage tripwire** — `__tests__/axis-coverage.test.ts` pins the
  synthetic guide set and the axis matrix. Adding an OAuth2 axis guide means
  updating that matrix.

## Which grants to realize

OAuth2 has several grants. Two cover everything a read-only agent-driven API
client needs; the rest are deferred.

### Realize

1. **Authorization Code with PKCE** — the modern default for installed / CLI
   apps. No client secret shipped. Needs an interactive consent step the
   **user performs in their own browser** (the agent never sees the user's
   provider credentials). Produces a refresh token → long-lived access.
2. **Client Credentials** — server-to-server, `client_id` + `client_secret`
   → token, no user, no browser. Pure HTTP. The simple case and the first
   one to ship.
3. **Refresh token** — not a standalone grant but the lifecycle mechanism
   both flows above produce. Lazy on-demand refresh at fetch time (no
   background worker — YAGNI).

### Defer (one-liners in the guide, rejected or ignored at parse)

- **Device flow (RFC 8628)** — covered behaviorally by the manual-code
  headless fallback of the auth-code flow; don't build the full device
  endpoint dance until a recipe needs it.
- **Implicit / `token` response** — deprecated; never build.
- **Resource Owner Password Credentials** — deprecated; never build.
- **Multiple accounts per domain** — one token set per domain (v1). Matches
  the static-key one-store-per-domain model.
- **Scope management UI** — scopes are a static list declared in the guide;
  no runtime picker.
- **Background refresh worker** — refresh lazily, on-demand, inside
  `resolveAccessToken`. A worker is additive later if a recipe's token TTL
  makes on-demand latency hurt.
- **OS-keychain token storage** — same additive-upgrade seam as the deferred
  keychain backend for the secrets store; the 0600 file stays the honest
  default.

## Why portal is NOT a runtime dependency of the OAuth2 flow

The user consents in **their own browser** at the provider, logging in with
their own credentials. Routing that through portal's driven browser would
flow the user's provider password through agent context — a hard no. So the
auth-code flow is: host generates the authorize URL (with a PKCE challenge),
spins up a **loopback HTTP listener** to capture the
`http://localhost:<port>/callback?code=…` redirect, opens/prints the
authorize URL for the user, and exchanges the captured code for tokens. No
static portal import, host-only boundary stays green. (Opening the user's
default browser is best-effort via `ctx.ui` / a printed clickable URL;
headless just prints the URL + a manual code-paste prompt.)

Portal **is** used for the *research/authoring* step below — but that's a
one-off human+agent task, not a runtime dependency of shipped code.

## Auth type reshape — discriminated union (the foundation fix)

The existing `AuthConfig` is a flat interface with optional fields for every
kind. The plan originally kept it flat "to minimize ripples through
`guide.auth.*` readers." That accommodation is the wrong call now, for two
reasons that both land because the schema is not yet frozen at v1:

1. **The flat shape taxes every new auth kind, forever.** Today's six
   `auth.kind === "static-key"` branches become six `oauth2` branches (the
   five P1 touch-list gaps are literally "you forgot to add the oauth2
   branch in file X"), then six `mtls` branches, six `private_key_jwt`
   branches, and so on for the plethora of APIs this suite is meant to
   serve. The compiler cannot tell you a branch is missing. A
   discriminated union with `kind` as the discriminant turns each consumer
   into a `switch (auth.kind)` whose `default: never` arm is an
   **exhaustiveness error at compile time** the moment a new variant lands.
2. **The plan already has to edit all six consumer files** for the P1
   touch-list gaps, so the one-time cost of converting them from `if
   (kind === …)` to `switch (kind)` is marginal over the work already
   scoped. Doing it now is cheaper than doing it later.

This is a **breaking change to the TS type** (any code reading `guide.auth`
as the flat interface must narrow by discriminant), and since v1 is not yet
frozen we **bump `GUIDE_SCHEMA_VERSION` from `0` to `1`** alongside it —
see the revised cross-cutting decision. The YAML author experience is
unchanged in shape (they still write `auth: { kind: oauth2, … }`); the bump
records the v1 auth-type vintage. This is the one breaking change this plan
introduces; it is taken deliberately, while it is still cheap.

### Target shape

Replace the flat `AuthConfig` interface with a discriminated union on
`kind`. Each variant carries only the fields legal for its kind:

```ts
interface NoneAuth { kind: "none"; headers?: Record<string, string> }

interface StaticKeyAuth {
  kind: "static-key";
  headers?: Record<string, string>;
  secretRefs?: Record<string, string>;      // header name → store name
  headerPrefixes?: Record<string, string>;
  secretQueryRefs?: Record<string, string>; // query param → store name
  requires?: string[];
  optional?: string[];
}

interface OAuth2Auth {
  kind: "oauth2";
  grant: "client_credentials" | "authorization_code";
  tokenUrl: string;
  clientId: string;
  // client-credentials auth: a map, not a single string — see note below.
  secretRefs?: Record<string, string>;      // e.g. { client_secret: "<store name>" }
  requires?: string[];                       // secret names whose absence fails closed
  optional?: string[];
  scopes?: string[];
  paramStyle?: "bearer-header" | "query";   // default bearer-header
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  // auth-code-only (parser-enforced present iff grant === "authorization_code"):
  authorizeUrl?: string;
  redirectUri?: string;
  pkce?: boolean;                            // parser-enforced true for auth-code
  revokeUrl?: string;                        // optional revocation endpoint
}

type AuthConfig = NoneAuth | StaticKeyAuth | OAuth2Auth;
```

Two shape decisions baked in:

- **`secretRefs` is a map on the oauth2 variant, not a single
  `clientSecretRef: string`.** The static-key side already proved the
  `Record<name, secretName>` pattern; reusing it on the oauth2 variant
  means the existing ref-consistency check (`requires`/`optional` ↔
  `secretRefs`/`secretQueryRefs`) applies to oauth2 **unchanged** — the P1
  ref-consistency shape mismatch dissolves. It also future-proofs the
  variant for `private_key_jwt` / mTLS, which need more than one secret ref
  (signing key + cert, etc.). `clientSecretRef` as a single string would
  have been a one-recipe shortcut that the second provider outgrows.
- **`tokenEndpointAuthMethod` is declared.** RFC 6749 §2.3.1 / RFC 7591:
  clients authenticate at the token endpoint via `client_secret_basic`,
  `client_secret_post`, `private_key_jwt`, `none`, etc. Hardcoding one (the
  original plan implicitly assumed `client_secret_post`) bites on the second
  provider that requires basic, or rejects basic. Declaring the method now
  is cheap and is exactly the kind of assumption that does not generalize
  across the plethora of APIs.

### Mechanical impact on the six consumers

Each `auth.kind === "static-key"` site becomes a `switch (auth.kind)` with
a `default: never` exhaustiveness arm. The P1 touch-list edits (adding the
oauth2 branch in `helpers.ts`, `resolve-op.ts`, `verify-command.ts`,
`auth.ts`, `secrets-command.ts`) are done **inside** this refactor, not on
top of the flat shape — so the oauth2 branch is added once, in the switch,
and the exhaustiveness check guarantees no seventh site is missed.

## Phased plan

### Phase 0 — Browser research: pick the OAuth2 APIs (scope early)

Before writing framework code, use the portal browser (`/web on`) to find
**good guide candidates** for the OAuth2 flow. Two outputs:

1. **One synthetic axis guide** for host's coverage matrix — an API simple
   enough to mock fully in a co-located `*.test.ts` (mocked transport). It
   just needs to exercise token injection + refresh + fail-closed; the
   endpoint can be synthetic. Candidate criteria: a provider with a clean
   client-credentials grant and well-documented token URL, so the mocked
   test is honest about the real shape.
2. **One or two complete real recipes** for
   [`caritas`](https://github.com/coreyryanhanson/caritas) — real endpoints,
   live tests gated by `HOST_INTEGRATION=1`, each carrying a `verified:`
   date + the caritas drift disclaimer. Prefer one client-credentials
   recipe (simplest, ships first) and one auth-code-with-PKCE recipe (the
   flow that proves the interactive dance).

Selection criteria to apply during research:

- Stable, documented token / authorize / revoke endpoints.
- Sensible scopes for a **read-only** client (transport stays GET-only;
  scoping is behavioral — provision read-only scopes).
- A provider whose docs make the PKCE + redirect-URI story unambiguous.
- Prefer APIs already partially represented (e.g. a `github.com` guide
  exists with static-key; GitHub's OAuth app is a natural auth-code recipe)
  so the multi-recipe domain machinery (`buildDomainMap` multi-valued) gets
  exercised alongside OAuth2.

Deliverable: a short note in this doc (or a sibling) naming the chosen APIs
with links to their OAuth2 docs, before Phase 2 begins.

### Phase 1 — Client Credentials grant (the simple half, ships first)

No browser, no loopback server, no PKCE. The minimum viable OAuth2.

- **`core/api-guide-types.ts`** — replace the flat `AuthConfig` interface
  with the `NoneAuth | StaticKeyAuth | OAuth2Auth` discriminated union from
  the **Auth type reshape** section. Bump `GUIDE_SCHEMA_VERSION` from `0` to
  `1` (see the revised cross-cutting decision). The oauth2 variant carries
  `tokenUrl`, `clientId`, `secretRefs` (a map, not a single string),
  `requires`/`optional`, `scopes?`, `paramStyle?`,
  `tokenEndpointAuthMethod?`, and the auth-code-only `authorizeUrl` /
  `redirectUri` / `pkce` / `revokeUrl?`.
- **`core/parse-api-guide.ts`** — un-reject `oauth2`; add `validateOAuth2`
  with invariants: client-credentials ⇒ a `client_secret` entry in
  `secretRefs` (referenced from `requires`) + `authorizeUrl`/`redirectUri`/
  `pkce` absent; auth-code ⇒ `pkce: true` + `authorizeUrl` + `redirectUri`,
  `client_secret` optional in `secretRefs` (PKCE apps have no secret). Every
  `secretRefs` value targets a declared secrets-store name (same rule as
  static-key). Because oauth2 reuses the existing `secretRefs` map, the
  ref-consistency check (`requires`/`optional` ↔ `secretRefs`/
  `secretQueryRefs`) applies **unchanged** — no special-casing for a single
  string ref. Two parser-internal touch points the existing static-key path
  hides:
  - **Extend `KNOWN_AUTH_KEYS`** (the strict field allowlist that runs after
    the kind reject) with the new oauth2 field names — `tokenUrl`,
    `clientId`, `grant`, `scopes`, `paramStyle`, `tokenEndpointAuthMethod`,
    `authorizeUrl`, `redirectUri`, `pkce`, `revokeUrl`. (`secretRefs`,
    `requires`, `optional` are already allowed.) Without this every oauth2
    guide fails with "unknown key(s)" before `validateOAuth2` is reached.
  - **Convert the kind-narrowing sites in this file** (the `oauth2` reject,
    the `none` field-presence check, the `secretQueryRefs` collision check)
    to `switch (auth.kind)` arms as part of the union refactor; the
    `default: never` arm makes the exhaustiveness guarantee load-bearing
    here too.
- **`core/oauth-store.ts`** (new, small) — per-domain token persistence:
  `{ accessToken, refreshToken?, expiresAt, scope? }`, 0600 file backend,
  lazy-mkdir-on-write. **Separate from the secrets store** because tokens
  rotate and have structure; reuse the `SecretStore` *interface shape* but
  don't cram tokens into `<domain>.json` next to raw keys. Lazy: a ~60-line
  file store mirroring `secrets-store.ts`.
- **`core/auth.ts`** — add `resolveAccessToken(guide, domain)`:
  read cached token → if missing, for client-credentials fetch via
  `tokenUrl` (POST, `client_secret` resolved from the secrets store via
  the oauth2 variant's `secretRefs` map + `tokenEndpointAuthMethod`, never
  logged) → if expired & `refreshToken` present, refresh → return
  `{ header: "Authorization: Bearer <token>", secretValues: [token] }`.
  Fail-closed (no token, no way to mint one) → caller nudges
  `/api oauth <domain>`. The `tokenEndpointAuthMethod` field selects
  `client_secret_basic` (Authorization header) vs `client_secret_post`
  (form body); `none` sends no client credentials (PKCE auth-code).
- **`core/resolve-op.ts`** — convert the auth-resolution block's
  `guide.auth.kind === "static-key"` check to a `switch (auth.kind)` and add
  the `oauth2` arm; reuse the existing `authOpts` / `secretValues` /
  fail-closed-return path. The Bearer token enters `secretValues` so the
  existing scrub redacts it from bodies/URLs. The `default: never` arm makes
  a future kind a compile error at the resolution seam.
- **`core/helpers.ts`** — convert the `checkAuth` `auth.kind === …` branch
  to a `switch (auth.kind)` and add the `oauth2` arm (it is called inside
  `restGet` and `paginate` *after* `resolveOpForExecution` has already
  resolved the token and handed it in as `authHeaders`; the current `throw`
  for unrealized kinds fires there and kills the request even after
  successful resolution). The `default: never` arm replaces the bare
  throw and makes a future fourth kind a compile error here.
- **`core/api-toggle.ts`** — add the `oauth` subcommand: `/api oauth <domain>`
  triggers client-credentials token fetch (no browser) and stamps the token
  store; `--refresh` forces a refresh; `--status` is metadata-only;
  `--revoke` hits the provider's revocation endpoint if declared. Always-
  available / not focus-guarded (peer of `secrets`/`verify`/`delete`).
- **`core/secrets-command.ts`** — convert the `kind !== "static-key"`
  guards in `declaredSecretNames` and `declaredPrefixHint` to a
  `switch (auth.kind)` and add an `oauth2` arm that reads the variant's
  `secretRefs` map (the `client_secret` entry) for guide-aware assisted
  provisioning. Without this, `/api secrets <domain>` shows "(none)" for an
  oauth2 guide's `client_secret` and falls back to the manual prompt — the
  guide-aware provisioning the cross-cutting decisions promise wouldn't
  fire. The store key stays decoupled from the routing domain via the
  existing `canonicalStoreDomain(guide)`.
- **`authStatusLine`** (`core/auth.ts`) — convert the `auth.kind !==
  "static-key"` early return to a `switch (auth.kind)` and add the `oauth2`
  arm for states: ok / expired-but-refreshable / missing → nudge
  `/api oauth <domain>`. This adds a new `auth.ts` → `oauth-store.ts` import
  direction (the footer must read the token store to report state); keep
  `oauth-store.ts` free of any `auth.ts` import so the edge stays one-way and
  no cycle forms.
- **Tests** — `__tests__/oauth-*.test.ts` (mocked transport): token fetch,
  cache hit, expiry → refresh, fail-closed, Bearer injection, scrub of the
  access token in a 401 body and a surfaced URL.

### Phase 2 — Authorization Code with PKCE (the interactive half)

- **`core/oauth-flow.ts`** (new) — the interactive dance, host-only:
  - Generate `code_verifier` + `code_challenge` (S256).
  - Spin up a loopback `http.createServer` on an ephemeral port, bound
    explicitly to `127.0.0.1` (`listen(port, "127.0.0.1")`) — a bare
    `listen(port)` defaults to `0.0.0.0` on some platforms and would expose
    the callback listener to the network. The `redirectUri` is
    `http://localhost:<port>/callback`.
  - Build the authorize URL (scopes, challenge, state, redirect_uri).
  - Surface the URL to the user — best-effort open-default-browser via
    `ctx.ui`, else print a clickable URL. **Headless**: print the URL and
    prompt for a pasted `code` (the manual fallback that subsumes device-flow
    usability without building device flow).
  - Await the callback (`?code=…` / `?error=…`), with a timeout.
  - Exchange the code at `tokenUrl` (PKCE verifier in the body) → token set.
  - Stamp the token store; close the listener.
- **`/api oauth <domain>`** — when the guide's grant is `authorization_code`,
  the subcommand runs `oauth-flow.ts` instead of the client-credentials
  fetch. Same token store, same `--refresh`/`--status`/`--revoke`.
- **`api-probe`** — extend the inline `auth` block with oauth2 fields for
  probing auth-gated endpoints. This is **non-trivial and does not mirror
  the static-key inline auth story cleanly**: static-key inline auth is
  injection-fields-only (resolve a secret, attach a header), whereas oauth2
  requires either minting a token (a client-credentials POST to `tokenUrl`)
  or reading a pre-provisioned token from the token store. Decide during
  Phase 2 whether probe mints on demand (one extra POST per probe) or
  requires a pre-provisioned token; the injection-fields-only model is not
  enough on its own.
- **`core/verify-command.ts`** — convert the auth precheck (`if
  (guide.auth.kind === "static-key")`) to a `switch (auth.kind)` and add an
  `oauth2` arm that resolves the token store / mintability and fail-fasts
  with a single nudge message before the op loop. Today oauth2 silently
  skips the precheck, so verify proceeds op-by-op and surfaces N identical
  token-missing failures instead of one. The `default: never` arm makes a
  future kind a compile error at the verify seam.
- **`/api verify`** — handle token refresh mid-loop (a long verify run can
  cross an expiry boundary; `resolveAccessToken` already refreshes lazily,
  so this is mostly "make sure verify goes through the same resolver").
- **Tests** — mocked transport + a mocked loopback callback for the
  auth-code exchange; assert PKCE verifier/challenge wiring, state check,
  token-store stamp, headless manual-code path.

### Phase 3 — Axis coverage + caritas recipes

- **Host axis guide** — add the synthetic OAuth2 axis guide chosen in
  Phase 0 to `api-guides/`, with a co-located mocked-transport test that
  exercises token injection + refresh + fail-closed. Update
  `__tests__/axis-coverage.test.ts` matrix (the kept-set count and the
  auth-kind axis: `none` + `static-key` + `oauth2`). Move `oauth2` from
  "Deferred" to "Built-in" in `api-helper-escape-valve.md`'s classification
  table — this is the promotion the doc's "second independent API" rule
  calls for.
- **Caritas recipes** — publish the Phase-0 client-credentials recipe and
  the auth-code-with-PKCE recipe into caritas with live tests
  (`HOST_INTEGRATION=1`) and `verified:` dates. Caritas owns the drift
  disclaimer; host ships only the synthetic axis fixture.

## Cross-cutting decisions (decide once, apply throughout)

- **Schema bump to v1.** Two things land together under one bump:
  (a) the **`AuthConfig` discriminated-union refactor** from the Auth type
  reshape section — a breaking change to the TS type that any `guide.auth`
  reader must adjust to; and (b) the new oauth2 variant. Realizing `oauth2`
  *relaxes* a constraint (a guide that used to fail to parse now parses),
  which under the AGENTS.md bump rule is a non-event on its own — but the
  union refactor is a genuine type break, and since v1 is not yet frozen we
  take the bump deliberately: `GUIDE_SCHEMA_VERSION` goes from `0` to `1`
  as the v1 auth-type vintage. Per the bump rule, `schemaVersion` stays
  **metadata-only** — a stale guide (`< current`) gets the non-blocking `⚠`
  warning in the catalog / detail / disambiguation and a note on
  `api-fetch`; it never gates or fails to load. Existing `kind: none` /
  `kind: static-key` guides parse unchanged under the union (the variants
  are a superset of the old flat shape), so the bump records the vintage
  without forcing a recipe migration.
- **Token store is separate from the secrets store.** Tokens rotate and have
  structure (`expiresAt`, `refreshToken`); raw secrets don't. Two 0600 file
  stores, same `SecretStore`-style interface shape, is simpler than one
  overloaded file.
- **`client_secret` lives in the secrets store**, not the token store —
  it's a raw credential provisioned once via `/api secrets <domain>`,
  exactly like a static key. The oauth2 variant references it through its
  `secretRefs` map (e.g. `{ client_secret: "<store name>" }`), reusing the
  static-key ref-consistency machinery unchanged. Only the minted tokens
  live in the token store.
- **Refresh is lazy and on-demand**, inside `resolveAccessToken` at fetch
  time. No background worker, no expiry timer. The first call after expiry
  pays one extra round trip; every subsequent call is cached. Add a worker
  only if a recipe's short TTL makes that latency hurt.
- **`Authorization: Bearer` is the default injection**; a guide may declare
  `paramStyle: query` (`?access_token=…`) for the few providers that require
  it. Query-injected tokens get the same URL redaction as static-key
  query secrets.
- **Transport stays GET-only.** The OAuth2 token/refresh/revocation POSTs are
  the first non-GET requests host makes — scope them to a small, separate
  helper in `core/oauth-flow.ts` / `core/auth.ts`, **not** a generalization
  of `transport.ts` into a write-capable pipeline. The helper issues POSTs
  via undici's `request()` (or the global `fetch`) directly — do **not**
  shoehorn POSTs through `transport.ts`'s `fetchUrl`, which is GET-only by
  contract. The "general mutations / write gate" deferral stands; OAuth2's
  POSTs are auth plumbing, not user ops.
- **Host-only boundary holds.** `oauth-flow.ts` must not statically import
  `pi-lean-portal`. The loopback listener + user's-own-browser model keeps
  it host-only by construction. `__tests__/host-only-boundary.test.ts` stays
  green.

## Deferred (explicitly out of scope for this plan)

- Device flow (RFC 8628) — manual-code headless fallback covers usability.
- Implicit / password grants — deprecated, never.
- Multiple accounts per domain.
- Scope management UI (scopes are static in the guide).
- Background refresh worker.
- OS-keychain token backend (additive upgrade seam, same as secrets store).
- Token introspection / JWKS validation (the provider validates; we store
  what it returns).
- General write/POST surface beyond OAuth2's own token endpoints.

## Exit criteria

- `kind: oauth2` parses (both grants), loads, and runs through the existing
  `resolveOpForExecution` path; Bearer tokens are injected, scrubbed, and
  refreshed lazily.
- `/api oauth <domain>` provisions tokens (client-credentials: pure HTTP;
  auth-code: loopback + user browser), headless-safe, not focus-guarded.
- A synthetic OAuth2 axis guide + co-located mocked test land in host;
  `axis-coverage.test.ts` matrix updated; escape-valve doc table updated.
- One client-credentials + one auth-code-with-PKCE recipe land in caritas
  with live tests and `verified:` dates.
- `GUIDE_SCHEMA_VERSION` bumped `0` → `1` (the v1 auth-type vintage);
  existing `none`/`static-key` guides parse unchanged under the union;
  host-only boundary test green; `npm run test:ci` green.
