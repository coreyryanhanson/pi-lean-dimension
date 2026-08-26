# OAuth2 Flow — High-Level Plan

> Realize the `auth.kind: oauth2` seam that is currently **declared but
> rejected at parse** (see `core/parse-api-guide.ts` `validateAuth`,
> `core/helpers.ts` `checkAuth`, and the "Deferred / out of scope" section of
> [`api-helper-escape-valve.md`](./api-helper-escape-valve.md)).
>
> This is a plan doc, not a spec. It names the seams to touch, the grants to
> realize, the grants to defer, and scopes the browser-research step early.
>
> **Version & release context.** This lands as **one PR of the `0.5.0`
> version bump**, not a standalone release. `0.5.0` is the coordinated
> breaking-schema release: the `GUIDE_SCHEMA_VERSION` `0` → `1` bump here
> rides the same version gate as the lockstep release label change tracked
> in [`guides-decoupling-caritas-remaining-host.md`](./guides-decoupling-caritas-remaining-host.md).
> The two are shipped together; do not treat the schema bump as a separate
> release event. (An earlier review of this doc flagged a "two plans claim
> the same 0→1 bump" conflict and a "bump rule says this is a non-event"
> contradiction — both are resolved by this coordination: `0.5.0` owns the
> bump, the AGENTS.md bump rule is amended below to cover TS-type breaks,
> and the schema-version check is flipped from a warning to a hard gate.)
> Until `0.5.0`, `pi-lean-host` docs carry a development-preview notice;
> `0.4.0` is the last preview release. All prior versions are unofficial,
> so this is the cheapest moment to lay the v1 foundation cleanly.

## Current state (the seams already in place)

The framework was built with OAuth2 in mind — most of the load-bearing seams
already exist, which is why this is mostly additive:

- **Schema seam** — `AuthKind = "none" | "static-key" | "oauth2"` and
  `KNOWN_AUTH_KINDS` already include `"oauth2"`
  (`core/api-guide-types.ts`). `AuthConfig` is a **flat interface today** —
  every auth field (`headers`, `secretRefs`, `headerPrefixes`,
  `secretQueryRefs`, `requires`, `optional`) sits on one bag of optionals
  for *every* kind, and every consumer narrows at runtime via
  `auth.kind === "static-key"` string checks (six core call sites today:
  `helpers.ts`, `resolve-op.ts`, `verify-command.ts`, `auth.ts`,
  `secrets-command.ts`, `parse-api-guide.ts`; plus two `tools/` readers —
  `api-learn.ts`, `api-probe.ts` — that access the flat fields without
  narrowing, for eight total — see the touch list in the reshape section).
  OAuth2 does not slot into
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

1. **The flat shape taxes every new auth kind, forever.** Today's
   `auth.kind === "static-key"` branches (eight consumer sites — see the
   touch list below) each become an `oauth2` branch, then an `mtls`
   branch, a `private_key_jwt` branch, and so on for the plethora of APIs
   this suite is meant to serve. The compiler cannot tell you a branch is
   missing. A discriminated union with `kind` as the discriminant turns
   each consumer into a `switch (auth.kind)` whose `default: never` arm is
   an **exhaustiveness error at compile time** the moment a new variant
   lands.
2. **The plan already has to edit all eight consumer files** for the
   touch-list gaps, so the one-time cost of converting them from `if
   (kind === …)` to `switch (kind)` is marginal over the work already
   scoped. Doing it now is cheaper than doing it later.

> **Touch list (exhaustive — verified against the codebase).** The eight
> sites that read `AuthConfig` fields and must convert to `switch (auth.kind)`:
> `core/helpers.ts` (`checkAuth` + the `extraHeaders` spread in `restGet` and `paginate` reads `auth.headers` without narrowing — breaks under the union), `core/resolve-op.ts`
> (`resolveOpForExecution` auth block), `core/verify-command.ts` (auth
> precheck), `core/auth.ts` (`authStatusLine` + `resolveSecretHeaders` +
> `resolveSecretQueryParams`; note `scrubSecretValues` is **not** a touch
> site — it takes `(text, secretValues?)` and never reads `AuthConfig`),
> `core/secrets-command.ts` (`declaredSecretNames` /
> `declaredPrefixHint`), `core/parse-api-guide.ts` (kind reject +
> `none` field-presence check + `secretQueryRefs` collision check +
> ref-consistency block), **`tools/api-learn.ts`** (`authSummary` reads
> `secretRefs` / `headerPrefixes` / `secretQueryRefs` without narrowing —
> breaks under the union), and **`tools/api-probe.ts`** (`listDomainSecrets`
> reads `requires` / `optional` without a `kind` guard — breaks under the
> union; **`resolveProbeAuth`** at `:237-300` also constructs fake flat
> `AuthConfig` objects to feed `resolveSecretHeaders`/`resolveSecretQueryParams`,
> which break when those functions take the nested `StaticKeyAuth` shape).
> `tools/api-guide.ts` (`renderGuideDetail`) only displays
> `auth.kind` and survives unchanged. The `default: never` exhaustiveness
> guarantee is only load-bearing **after** every site is converted — the
> compiler will not surface sites still on the flat shape, so this list is
> the contract.

This is a **breaking change** — to the TS type *and* the YAML auth-block
shape (the nested-`secretRefs` reshape below changes how every static-key
guide authors its secrets). Since v1 is not yet frozen and `0.5.0` is the
coordinated breaking release, we **bump `GUIDE_SCHEMA_VERSION` from `0` to
`1`** alongside it, flip the schema-version check from a non-blocking
warning to a **hard gate** (see the revised cross-cutting decisions), and
re-stamp every caritas guide's frontmatter to `schemaVersion: 1`. This is
taken deliberately, while it is still cheap.

### Target shape

Replace the flat `AuthConfig` interface with a discriminated union on
`kind`. Each variant carries only the fields legal for its kind:

```ts
interface NoneAuth { kind: "none"; headers?: Record<string, string> }

// A single secret reference — self-contained. Availability is a property
// of THIS ref (default: required, fail-closed when absent), not a separate
// roster. prefix folds the old top-level headerPrefixes inline. This makes
// the three old consistency checks (ref→declared, declared→ref, prefix→ref)
// structurally impossible to violate, so the parser deletes them.
interface SecretRef {
  secret: string;          // store name
  prefix?: string;         // e.g. "Bearer " — applied at resolution time
  optional?: boolean;      // default false (absent → fail-closed)
}

interface StaticKeyAuth {
  kind: "static-key";
  headers?: Record<string, string>;                 // literal headers (X-Api-Key: DEMO_KEY)
  secretRefs?: Record<string, SecretRef>;           // header name → ref
  secretQueryRefs?: Record<string, SecretRef>;      // query param name → ref
}

interface OAuth2Auth {
  kind: "oauth2";
  grant: "client_credentials" | "authorization_code";
  tokenUrl: string;
  clientId: string;
  // Reuses the same nested SecretRef shape as static-key. For oauth2 the
  // map key is a FORM FIELD NAME (e.g. "client_secret"), not a header name —
  // validateOAuth2 documents this. Future-proofs for private_key_jwt / mTLS
  // which need more than one secret ref (signing key + cert).
  secretRefs?: Record<string, SecretRef>;
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

### YAML authoring shape (before → after)

The nested refactor is the real cleanup. Today one logical fact ("this
header needs this secret, and it's optional") is split across three
fields — `secretRefs` (where), `optional` (availability), and the secret
name duplicated between them — bolted together by ~85 lines of parser
consistency checks (`parse-api-guide.ts` `checkRefs` / `checkDeclared` /
the `headerPrefixes`-must-target-a-secretRef check). The nested shape
makes each ref self-contained and deletes all three checks.

```yaml
# static-key (the shipped github guide, public-API-with-optional-key-for-rate-limits)
auth:                              auth:
  kind: static-key                   kind: static-key
  secretRefs:                        secretRefs:
    Authorization: api_key             Authorization:
  optional:                              secret: api_key
    - api_key                            optional: true     # default: required (fail-closed)
```

```yaml
# oauth2 client_credentials
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://api.example.com/oauth/token
  clientId: my_client_id
  secretRefs:
    client_secret:
      secret: client_secret
  scopes: [read]
  paramStyle: bearer-header
  tokenEndpointAuthMethod: client_secret_post
```

The public-with-optional-key use case (API is public, user may provision a
key for better rate limits) survives unchanged in semantics: `optional: true`
on the ref, `resolveSecretHeaders` proceeds unauthenticated when the store
misses an optional secret — the same path it uses today, reading
`refs[h].optional` instead of `optional.includes(name)`.

Three shape decisions baked in:

- **`secretRefs` is a nested `Record<string, SecretRef>`, not a flat
  `Record<string, string>` + `requires`/`optional`/`headerPrefixes`.** This
  is the cleanup that actually improves the foundation (not just the TS
  type). It collapses three fields into one self-contained entry per secret,
  deletes ~85 lines of parser consistency enforcement (`checkRefs` /
  `checkDeclared` / the `headerPrefixes`-must-target-a-secretRef check at
  `parse-api-guide.ts:747-823`), and makes the three violations it guarded
  against structurally impossible. `core/auth.ts:56` (`resolveSecretHeaders`)
  folds the prefix application inline (`(ref.prefix ?? "") + value`),
  deleting the separate `headerPrefixes` lookup. Caritas static-key guides
  need an auth-block **rewrite** (not just a restamp) — accepted, this is
  the right moment. The same nested shape is reused on the oauth2 variant
  (future-proofs for `private_key_jwt` / mTLS, which need >1 secret ref);
  there the map key is a form-field name, not a header name.
- **`tokenEndpointAuthMethod` is declared.** RFC 6749 §2.3.1 / RFC 7591:
  clients authenticate at the token endpoint via `client_secret_basic`,
  `client_secret_post`, `private_key_jwt`, `none`, etc. Hardcoding one (the
  original plan implicitly assumed `client_secret_post`) bites on the second
  provider that requires basic, or rejects basic. Declaring the method now
  is cheap and is exactly the kind of assumption that does not generalize
  across the plethora of APIs.
- **Per-variant field allowlists replace the global `KNOWN_AUTH_KEYS`.**
  Today `KNOWN_AUTH_KEYS` is a single global set, so a `headerPrefixes` or
  `secretQueryRefs` key on an oauth2 block (or a `tokenUrl` on a static-key
  block) passes the allowlist and only gets caught — maybe — downstream.
  For v1 the parser moves to per-variant allowlists keyed by `kind`: each
  variant rejects fields not legal for it. Strictly cleaner, strictly
  louder, and the natural shape of the union. (This also retires the old
  `none`-kind field-presence check as a special case — it becomes the
  `NoneAuth` allowlist.)

### Mechanical impact on the eight consumers

Each `auth.kind === "static-key"` site becomes a `switch (auth.kind)` with
a `default: never` exhaustiveness arm. Seven of the eight convert in
Phase 1 — the oauth2 branch is added inside the refactor in `helpers.ts`,
`resolve-op.ts`, `auth.ts`, `secrets-command.ts`, `tools/api-learn.ts`,
`tools/api-probe.ts`, plus `parse-api-guide.ts` (whose kind-narrowing sites
— the `oauth2` reject and the `secretQueryRefs` collision check — become
`switch` arms rather than a consumer "oauth2 branch"). The eighth,
`verify-command.ts`, converts in **Phase 2** when its oauth2 precheck arm
lands; until then it stays on `if (kind === "static-key")`, which still
compiles under the union (narrowing by discriminant inside the `if` is
sound) — it just isn't exhaustive yet. The exhaustiveness check then
guarantees no *ninth* site is missed once all eight are on `switch` — but
only because the eight-site touch list above is the contract; the compiler
will not surface sites still on the flat shape.

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
  the **Auth type reshape** section, including the nested `SecretRef` shape
  (`{ secret, prefix?, optional? }`). Drop the top-level `requires` /
  `optional` / `headerPrefixes` fields from both `StaticKeyAuth` and
  `OAuth2Auth` — they are now per-ref. Bump `GUIDE_SCHEMA_VERSION` from `0`
  to `1`. The oauth2 variant carries `tokenUrl`, `clientId`, `secretRefs`,
  `scopes?`, `paramStyle?`, `tokenEndpointAuthMethod?`, and the auth-code-only
  `authorizeUrl` / `redirectUri` / `pkce` / `revokeUrl?`.
- **`core/parse-api-guide.ts`** — un-reject `oauth2`; add `validateOAuth2`
  with invariants: client-credentials ⇒ a `client_secret` entry in
  `secretRefs` + `authorizeUrl`/`redirectUri`/`pkce` absent; auth-code ⇒
  `pkce: true` + `authorizeUrl` + `redirectUri`, `client_secret` optional
  in `secretRefs` (PKCE apps have no secret — see the auth-code-optional
  decision in cross-cutting). Every `secretRefs` value's `secret` targets a
  name the secrets store would accept (same rule as static-key). Three
  parser-internal changes the existing static-key path hides:
  - **Per-variant field allowlists** replace the single global
    `KNOWN_AUTH_KEYS` set (see the third baked-in decision). Each variant
    rejects fields not legal for it; the old `none`-kind field-presence
    check becomes the `NoneAuth` allowlist. Without this, a `tokenUrl` on a
    static-key block or a `headerPrefixes` on an oauth2 block slips past the
    global allowlist.
  - **Delete the ref-consistency block** (`checkRefs` / `checkDeclared` /
    the `headerPrefixes`-must-target-a-secretRef check, `parse-api-guide.ts:747-823`).
    The nested `SecretRef` makes all three violations structurally
    impossible: there is no `requires`/`optional` list to diverge from the
    refs, and `prefix` lives on the ref it applies to.
  - **Convert the kind-narrowing sites in this file** (the `oauth2` reject,
    the `secretQueryRefs` collision check) to `switch (auth.kind)` arms as
    part of the union refactor; the `default: never` arm makes the
    exhaustiveness guarantee load-bearing here too.
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
  **`resolveAccessToken` must read the token store fresh on every call**
  (not cache in a closure) so a refresh on op N is visible to op N+1 during
  a long `/api verify` run — mirrors how the static-key path reads the
  store fresh per call. **Serialize refreshes per domain** with a
  `Map<string, Promise>` lock keyed by `canonicalStoreDomain(guide)` (see
  cross-cutting decisions) to prevent parallel `api-fetch` calls racing a
  refresh and double-spending a rotated refresh token. **Apply an
  `expiresAt - 60_000` skew buffer** so the refresh fires before real expiry
  instead of on the call that 401s. Also fold the prefix application into
  `resolveSecretHeaders` inline (`(ref.prefix ?? "") + value`), deleting
  the separate `headerPrefixes` lookup.
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
  provisioning. `declaredPrefixHint` now reads `ref.prefix` off the nested
  `SecretRef` instead of the deleted top-level `headerPrefixes` map. Without
  this, `/api secrets <domain>` shows "(none)" for an oauth2 guide's
  `client_secret` and falls back to the manual prompt — the guide-aware
  provisioning the cross-cutting decisions promise wouldn't fire. The store
  key stays decoupled from the routing domain via the existing
  `canonicalStoreDomain(guide)`.
- **`authStatusLine`** (`core/auth.ts`) — convert the `auth.kind !==
  "static-key"` early return to a `switch (auth.kind)` and add the `oauth2`
  arm for states: ok / expired-but-refreshable / missing → nudge
  `/api oauth <domain>`. This adds a new `auth.ts` → `oauth-store.ts` import
  direction (the footer must read the token store to report state); keep
  `oauth-store.ts` free of any `auth.ts` import so the edge stays one-way and
  no cycle forms.
- **`tools/api-learn.ts`** — `authSummary` (`:180-191`) reads `auth.secretRefs` /
  `auth.headerPrefixes` / `auth.secretQueryRefs` directly on the flat
  `AuthConfig` without narrowing. Under the union those fields only exist on
  `StaticKeyAuth`, so these accesses become TS errors. Convert to a
  `switch (auth.kind)` (or narrow per field) and render the nested
  `SecretRef` shape (`secret` + optional `prefix`/`optional`). This is the
  seventh consumer site the original plan's "six call sites" claim missed.
- **`tools/api-probe.ts`** — `listDomainSecrets` (`:1034-1035`) reads
  `guide.auth.requires` / `guide.auth.optional` without a `kind` guard; under
  the union those fields don't exist on `NoneAuth`, so this is a TS error.
  Convert to a `switch (auth.kind)` arm that reads the nested `secretRefs`
  (and `secretQueryRefs`) instead of the deleted top-level lists. This is
  the eighth consumer site. (The Phase 2 inline-oauth2-probe decision is
  separate; this Phase 1 fix is just keeping the union refactor compiling.)
- **Tests** — `__tests__/oauth-*.test.ts` (mocked transport): token fetch,
  cache hit, expiry → refresh, fail-closed, Bearer injection, scrub of the
  access token in a 401 body and a surfaced URL. **Plus update existing
  tests for the breaking changes:** `__tests__/helpers.test.ts:1515` (asserts
  `checkAuth` throws for oauth2 — invert once realized), `__tests__/parse-api-guide.test.ts`
  (the `secretRefs`-flat + `requires`/`optional`/`headerPrefixes` fixtures
  move to the nested shape; add per-variant-allowlist rejection cases), and
  the six test files that carry `headerPrefixes` fixtures
  (`parse-api-guide` / `secrets-command` / `api-probe` / `auth` / `verify-command` / `tools`)
  fold `prefix` into the nested `SecretRef`.

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
  enough on its own. (Note: Phase 1 already touches `api-probe.ts` for the
  `listDomainSecrets` union fix — that is independent of this Phase 2
  inline-auth decision.)
- **`core/verify-command.ts`** — convert the auth precheck (`if
  (guide.auth.kind === "static-key")`) to a `switch (auth.kind)` and add an
  `oauth2` arm that resolves the token store / mintability and fail-fasts
  with a single nudge message before the op loop. Today oauth2 silently
  skips the precheck, so verify proceeds op-by-op and surfaces N identical
  token-missing failures instead of one. The `default: never` arm makes a
  future kind a compile error at the verify seam.
- **`/api verify`** — handle token refresh mid-loop (a long verify run can
  cross an expiry boundary). `resolveAccessToken` already refreshes lazily
  and reads the store fresh per call (see cross-cutting), so verify going
  through the same resolver picks up the refresh on op N+1 automatically —
  no verify-specific cache.
- **Tests** — mocked transport + a mocked loopback callback for the
  auth-code exchange; assert PKCE verifier/challenge wiring, state check,
  token-store stamp, headless manual-code path.

### Phase 3 — Axis coverage + caritas recipes

- **Host axis guide** — add the synthetic OAuth2 axis guide chosen in
  Phase 0 to `api-guides/`, with a co-located mocked-transport test that
  exercises token injection + refresh + fail-closed. Update
  `__tests__/axis-coverage.test.ts` matrix (the kept-set count and the
  auth-kind axis: `none` + `static-key` + `oauth2`) and
  `__tests__/all-guides-parse.test.ts:56` (asserts
  `expect(["none", "static-key"]).toContain(...)` — extend to `oauth2`).
  Move `oauth2` from "Deferred" to "Built-in" in `api-helper-escape-valve.md`'s
  classification table — this is the promotion the doc's "second independent
  API" rule calls for.
- **Caritas recipes** — publish the Phase-0 client-credentials recipe and
  the auth-code-with-PKCE recipe into caritas with live tests
  (`HOST_INTEGRATION=1`) and `verified:` dates. Caritas owns the drift
  disclaimer; host ships only the synthetic axis fixture. **Every caritas
  guide also gets `schemaVersion: 1` stamped** (hard-gate flip below) and
  any static-key guide gets its auth block rewritten to the nested
  `SecretRef` shape — this is a one-time `0.5.0` migration, not ongoing
  drift.

## Cross-cutting decisions (decide once, apply throughout)

- **Schema bump to v1, shipped under `0.5.0`, and the version check
  becomes a hard gate.** Three things land together under one bump:
  (a) the **`AuthConfig` discriminated-union refactor**; (b) the **nested
  `SecretRef` reshape** (a breaking change to the YAML auth-block shape —
  every static-key guide's `secretRefs`/`requires`/`optional`/`headerPrefixes`
  collapses to nested entries); and (c) the new oauth2 variant. This is one
  PR of the coordinated `0.5.0` release; the bump rides the same gate as the
  lockstep label change tracked in
  `guides-decoupling-caritas-remaining-host.md`. **AGENTS.md bump-rule
  amendment (part of this PR):** the existing rule says "do not bump unless a
  guide that used to parse now fails to parse; relaxing a constraint is a
  non-event" — that rule is written in terms of *parse behavior* only. Add
  an explicit bump trigger for **breaking TS-type or YAML-shape changes to
  `AuthConfig`** even when parse behavior relaxes. Concretely `GUIDE_SCHEMA_VERSION`
  goes `0` → `1` as the v1 auth-type vintage. **Hard-gate flip:** `isStaleSchema`
  (`parse-api-guide.ts:1779`) changes from a non-blocking `⚠` warning into a
  **hard load refusal** — a guide whose `schemaVersion` is `< current` fails
  to parse. This is the "fail loudly" policy: we do not keep deprecated
  reading code to support old-schema guides. Every caritas guide is
  re-stamped to `schemaVersion: 1` (one frontmatter line per guide); static-key
  guides additionally get the nested auth-block rewrite. The
  `schema-version.test.ts` "never a gate" assertions invert to "is a gate".
  Update the AGENTS.md `schemaVersion` section to match (it currently says
  "never a gate").
- **Token store is separate from the secrets store.** Tokens rotate and have
  structure (`expiresAt`, `refreshToken`); raw secrets don't. Two 0600 file
  stores, same `SecretStore`-style interface shape, is simpler than one
  overloaded file.
- **`client_secret` lives in the secrets store**, not the token store —
  it's a raw credential provisioned once via `/api secrets <domain>`,
  exactly like a static key. The oauth2 variant references it through its
  `secretRefs` map (e.g. `client_secret: { secret: client_secret }`),
  reusing the same nested `SecretRef` shape as static-key. Only the minted
  tokens live in the token store.
- **Auth-code `client_secret` is optional with no ref entry.** A PKCE
  auth-code app has no client secret, so its guide simply omits the
  `client_secret` entry from `secretRefs` (and omits it from any list — there
  is no `optional` list anymore). This sidesteps the old `checkDeclared`
  rule that rejected an `optional` name not referenced by any ref: there is
  no list to diverge from. `validateOAuth2` enforces `grant: authorization_code`
  ⇒ `pkce: true` + `authorizeUrl` + `redirectUri`; `client_secret` in
  `secretRefs` is allowed but not required.
- **Refresh is lazy and on-demand**, inside `resolveAccessToken` at fetch
  time. No background worker, no expiry timer. The first call after expiry
  pays one extra round trip; every subsequent call is cached. `resolveAccessToken`
  reads the token store fresh on every call (no closure cache) so a refresh
  on op N is visible to op N+1 during a long `/api verify` run. Add a worker
  only if a recipe's short TTL makes that latency hurt. **Two risks the lazy
  path must guard against:** (a) **Refresh-token rotation races** — some
  providers issue a fresh refresh token on each refresh; two parallel
  `api-fetch` calls that both see an expired token can race, double-spend
  the old refresh token, and corrupt the token store. The static-key path
  never had this (secrets don't rotate at runtime) and `SecretStore` has no
  concurrency primitive. Guard the read-check-refresh-write sequence with a
  **per-domain in-process `Map<string, Promise>` lock** keyed by
  `canonicalStoreDomain(guide)` so concurrent calls for the same domain
  serialize on the same refresh. (b) **Clock skew on `expiresAt`** — a token
  accepted as fresh by the client can be rejected by the server right at the
  expiry boundary; the lazy refresh only catches it on the *next* call.
  Apply a small **skew buffer** (refresh when `now >= expiresAt - 60_000`,
  i.e. one round trip before real expiry) so the refresh fires early
  instead of on the call that 401s.
- **`Authorization: Bearer` is the default injection**; a guide may declare
  `paramStyle: query` (`?access_token=…`) for the few providers that require
  it. **Query-injected tokens feed the existing URL-redaction path:** the
  oauth2 arm in `resolve-op.ts` adds the token param name (`access_token`,
  per RFC 6750 §2.3, or the guide-configured name) to the `secretQueryParamNames`
  set in `AuthOpts`, so `redactSecretParams` (`transport.ts`) redacts it on
  every surfaced URL (`result.url`, `PaginateResult.urls`, `HelperError.url`).
  Without this the access token leaks into surfaced URLs — a real redaction
  gap, not cosmetic.
- **Per-variant field allowlists.** Replaces the global `KNOWN_AUTH_KEYS`
  set with per-variant allowlists keyed by `kind` (see the third baked-in
  decision). Each variant rejects fields not legal for it; this is stricter
  than the global set and is the natural shape of the union.
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
  `axis-coverage.test.ts` and `all-guides-parse.test.ts` matrices updated;
  escape-valve doc table updated.
- One client-credentials + one auth-code-with-PKCE recipe land in caritas
  with live tests and `verified:` dates; every caritas guide stamped
  `schemaVersion: 1` and static-key guides rewritten to nested `SecretRef`.
- `GUIDE_SCHEMA_VERSION` bumped `0` → `1` under `0.5.0`; `isStaleSchema`
  flipped to a hard gate; AGENTS.md bump rule + `schemaVersion` section
  amended; all eight consumer sites on `switch (auth.kind)`; per-variant
  field allowlists in place; ref-consistency block deleted; host-only
  boundary test green; `npm run test:ci` green.
