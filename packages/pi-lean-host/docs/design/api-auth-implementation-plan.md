# pi-lean-host — Authenticated-API Implementation Plan

> Sprint plan for realizing
> [`api-auth-and-cookies.md`](./api-auth-and-cookies.md) (the static-key
> retrieval slice) and shipping the proof recipes in
> [`api-auth-recipe-candidates.md`](./api-auth-recipe-candidates.md).
> Anchors development to the design doc's named seams; divides work into
> three sprints ordered by **leak risk, not feature completeness**.
>
> Status: **plan; implementation not started.** Source of truth for the
> *what/how* is [`api-auth-and-cookies.md`](./api-auth-and-cookies.md);
> this doc adds the *when/order* and acceptance criteria.

## Guiding principles

1. **The blocker is the full vertical slice, not the file.** "A working
   secret store" means *store + code-injects + output-channel audit*
   together. A store without the output-channel audit leaks a key to the
   inference server on the first 401 body echo. That whole slice is the
   prerequisite for safe keyed-guide development, and it lands as one unit
   on the easiest axis (A1, header) before any harder axis is touched.
2. **Risk-order the axes.** A1 (header) leaks via 401 body, response-header
   echo, and cross-domain redirect — tractable, establishes the patterns.
   A2 (query-param) leaks via the URL *and* the params map, the latter
   silent into the session file on every authenticated call — the most
   subtle, most-likely-to-ship-broken path; it layers on top of A1's
   patterns. A3 (authless stateful) has no secrets and no core change.
   Build the security core on A1, harden A2, treat A3 as pure guide work.
3. **One forcing-function guide per sprint.** The injection path is
   untested until a keyed guide exercises it (design doc, Validation
   notes). Each sprint ships its matching recipe as acceptance, not as a
   follow-up: CoinGecko (A1) closes sprint 1, Etherscan (A2) closes
   sprint 2.
4. **The output-channel audit is a first-class deliverable.** It is the
   work most likely to be skipped under deadline (design doc, Risks).
   Every sprint's acceptance criteria includes the audit tests for the
   channels that sprint opens.
5. **`api-probe` auth lands with A2.** Most candidates are
   keyless-probeable for shape; probe auth mainly matters for
   auth-gated endpoints (Etherscan), and it reuses sprint 2's query-param
   output-channel work. Sprint 1's CoinGecko guide is authorable with
   keyless probing today.

## Sprint overview

| Sprint | Theme | Axis proven | Core change | Recipe shipped |
|--------|-------|-------------|-------------|----------------|
| 1 | Secrets store + header-auth vertical slice (the blocker) | A1 | store, schema/parse, injection, output-channel audit (header), cache/SSRF, footer | CoinGecko |
| 2 | Query-param secrets + authoring-loop auth (the security-critical axis) | A2 | `secretQueryRefs`, URL redaction, params-below-map, `hasAuth` extension, `api-probe` auth | Etherscan V2 |
| 3 | Stateful sessions + optional-auth keyed variants (proof expansion) | A3, A1+optional | none (guide-only) | NCBI E-utilities, GitHub keyed, GitLab keyed |

NCBI (A3) is a **pull-forward quick win**: zero leak risk, zero core
change (tokens are just params), expandable into shipped guides at any
time — including as a warm-up before sprint 1 if capacity allows. It is
listed in sprint 3 only because it proves nothing about the store.

## Sprint 1 — Secrets store + header-auth vertical slice

**Goal:** a real keyed header-auth guide can be fetched end-to-end with
the key value guaranteed never to enter agent context. This is the
blocker that unblocks all keyed-guide development.

### In scope

**Store (`core/secrets-store.ts`, new)**

- Swappable store interface; `0600`-file backend at
  `~/.pi/agent/pi-lean-host/secrets/<domain>.json`.
- Flat JSON object keyed by secret name → value (matches the
  `secretName` in `auth.secretRefs`/`auth.secretQueryRefs`).
- `readSecret(domain, name)`, `writeSecret(domain, name, value)`,
  `listDomains()`, `listNames(domain)`. Lazy dir creation on write only;
  reads/list never mkdir (read-only `$HOME` safety).
- No env-var middleman (`PI_LEAN_HOST_KEY_*` dropped).

**`/api secrets` subcommand (`core/api-toggle.ts` + new module)**

- No-arg list: store-driven (filenames + object keys), names only, never
  values. `(no secrets stored)` when dir absent.
- `<domain>`: assisted entry — if the registered guide declares exactly
  one secret name, prompt directly; if multiple, show a `ctx.ui.custom()`
  picker with provisioned state. Also the per-domain detail view
  (declared-vs-stored gaps via the auth-status helper).
- `<domain> <name>`: manual entry, escape valve for the chicken-and-egg
  case; name validated against `requires ∪ optional` when a guide is
  registered, free-form otherwise.
- `--delete` modifier: `/api secrets <domain> <name> --delete` drops one
  secret (no confirm — a typed name is deliberate); `/api secrets
  <domain> --delete` drops every secret for the domain (interactive
  `ctx.ui.custom()` confirm when `ctx.hasUI`). Removing the last entry
  unlinks the now-empty file so the domain exits `listDomains()` / the
  no-arg list. `--delete` is reserved and cannot be a secret name.
- All entry via `ctx.ui.input()`; returns metadata-only status line, the
  value never touches a tool result / `pi.sendMessage` / session file.
- Headless: `ctx.hasUI` false → entry prints direct-file-write
  instructions (no prompt); **deletion executes directly, no confirm**
  (same never-hang contract). Neither path prompts or hangs.
- Focus-mode guard: **not applied** (peer of `status`/`helpers`/bare, not
  an actuation — entry nor deletion writes a `{enabled}` entry). Add to
  help block + `AGENTS.md` command list.

**Schema / parser / validator (`core/api-guide-types.ts`, `core/parse-api-guide.ts`)**

- Realize `auth.kind: "static-key"` in `checkAuth` (`core/helpers.ts:315`).
- Add `auth.secretRefs: Record<headerName, secretName>`,
  `auth.requires: string[]`, `auth.optional: string[]`.
- `validateAuth` rules (all fail-closed with `fix:` hints): kind↔field
  consistency (`secretRefs` rejected on `kind: none`; `oauth2` rejected at
  parse with "not yet implemented"); referenced-name consistency (every
  `secretRefs` name in `requires ∪ optional`; a name in **both** is an
  error); `oauth2` type seam stays, unrealized.
- **Widen `__tests__/all-guides-parse.test.ts`** (currently asserts
  `auth.kind === "none"` for every discovered guide). The first
  `static-key` guide (CoinGecko) will break that assertion, so loosen it
  to accept `kind ∈ {none, static-key}` (and, for auth-bearing guides,
  assert the `secretRefs`/`requires`/`optional` shape instead of the
  `none` invariant). Must land in this sprint alongside the CoinGecko
  recipe, not as a follow-up.

**Injection (`core/helpers.ts`, `tools/api-fetch.ts`)**

- `api-fetch` resolves `secretRefs` from the store at fetch time and
  injects headers in code. Agent sees *that* a key is required and
  *whether* present, never *what*.
- `requires` secret absent → fail closed **before the request** with the
  provision-via-`/api secrets` message.
- `optional` secret absent → proceed unauthenticated (no error, no nudge).

**Output-channel audit — header secrets (security-critical)**

- 401 body: scrub known secret values from the `result.body.slice(0, 500)`
  excerpt in `checkResponseStatus` (`core/helpers.ts:361`, slice at
  `:369`), or fail-closed drop the body excerpt for auth-bearing requests.
- Response-header echo: scrub/filter any response header whose value
  matches a known secret in `details.headers` (restGet branch only,
  `tools/api-fetch.ts:243`); or drop `details.headers` entirely for
  auth-bearing `restGet`. (Paginate has no `details.headers` emit — not a
  concern.)

**Cache / SSRF / redirect rules (`core/transport.ts`, `core/helpers.ts`)**

- Introduce `hasAuth` (broader than `hasAuthHeaders`): true when any
  non-`accept` header is present. Used for cache-skip and
  redirect-forcing. (Query-param extension lands in sprint 2.)
- Force `getWithGuardedRedirects` in `fetchUrl` whenever `hasAuth` — the
  one-liner from §Cache / SSRF / redirect rules. No behavior change for
  keyless requests.
- Host-match gate inside the guarded loop: drop store-injected
  `secretRefs` headers + `Authorization` on cross-domain redirect hops;
  literal `auth.headers` stay. Plumb `secretHeaderNames: Set<string>` via
  a new optional `FetchOptions` field.
- Update `guardRedirects` doc comment.

**Auth status footer (shared helper)**

- One helper, used by both `api-guide` and `api-fetch`. Five states: no
  auth / auth-ok / nudge-provision (required absent) / auth-ok-optional /
  optional-not-provisioned. Metadata only, never the value.

**Production validation: CoinGecko guide (A1)**

- New `api-guides/api.coingecko.com/` recipe: header `x-cg-demo-api-key`,
  `auth.kind: static-key`, `auth.secretRefs`, `auth.requires: [apiKey]`,
  offset pagination (`per_page`/`page`). Demo plan, 100/min, zero cost.
- Co-located `endpoint-coverage.test.ts` (`HOST_INTEGRATION=1` gated).

### Tests (acceptance proof)

- Store: read/write/resolve, `0600` perms, lazy-mkdir-on-write-only,
  names-only listing, missing file/dir handling; `--delete` single-name
  (no confirm, prunes + unlinks last-entry file), whole-domain (confirm
  when interactive, direct when headless), missing-name/domain fail-closed
  no-mutation, empty-domain no-op-not-error, status/confirm never echoes
  the value.
- Parser/validator: every `validateAuth` rule above; `oauth2` rejected at
  parse; `static-key` realized.
- Output-channel audit (header): no secret value in a 401 body slice, no
  secret value in `details.headers` for an auth-bearing `restGet`.
- Fail-closed vs proceed: `requires` absent → pre-request error with the
  provision message; `optional` absent → unauthenticated fetch succeeds.
- SSRF verification (a/b/c): (a) malicious `nextUrl` blocked by existing
  `nextLink` guard; (b) auth-bearing `restGet` 302→internal blocked by
  forced guarded path; (c) auth-bearing `restGet` 302→public cross-domain
  → store-injected headers stripped, literal `auth.headers` may forward.
- Footer: five states via the shared helper on both `api-guide` and
  `api-fetch`.
- CoinGecko: parses cleanly (`all-guides-parse`, after the test widening
  above); endpoint coverage under `HOST_INTEGRATION=1`.

### Acceptance criteria

1. A user can run `/api secrets api.coingecko.com` (assisted), enter the
   demo key, and `api-fetch` against the CoinGecko guide returns market
   data with the key injected from the store — the key value never appears
   in any tool result, session file, or emitted URL/header.
2. With the key absent, `api-fetch` fails closed before the request with
   the `/api secrets` provision message; the footer nudges the same.
3. A mocked 401 body echoing the auth header value does not reach agent
   context (test 1 of output-channel audit passes).
4. A mocked response header echoing the auth header value does not reach
   `details.headers` (test 2 passes).
5. The three SSRF cases (a/b/c) pass.
6. Headless invocation of `/api secrets` prints file-write instructions
   for entry and executes deletions directly (no confirm) for `--delete`,
   and does not hang either way.
7. `/api secrets <domain> --delete` (interactive) confirms before
   removing all secrets for the domain; `/api secrets <domain> <name>
   --delete` removes one without confirm; both unlink the file when it
   empties and never echo the value.
8. No existing `kind: none` guide breaks (`all-guides-parse` — widened
   to accept `static-key` guides — + full portal structural suite green).

### Out of scope (this sprint)

- `auth.secretQueryRefs` and everything it forces (sprint 2).
- `api-probe` store-backed auth (sprint 2).
- The optional-auth keyed variants as shipped recipes (sprint 3); the
  *mechanism* (`auth.optional` proceed-unauthenticated + footer) ships
  here, the *proof recipes* ship in sprint 3.
- OS-keychain backend (deferred — additive seam).

## Sprint 2 — Query-param secrets + authoring-loop auth

**Goal:** query-param secrets ship with **both** output-channel defenses,
and the authoring loop (`api-probe`) can probe auth-gated endpoints
without pasting a key into the transcript.

### In scope

**Schema / parser — `secretQueryRefs`**

- Add `auth.secretQueryRefs: Record<paramName, secretName>`.
- `validateAuth` rule: a secret param name that also appears in any
  operation's `params` map is a parse error (agent must not be able to
  supply a secretly-injected param).
- `passthrough` + `secretQueryRefs` is **allowed**; the defense is
  runtime, in `buildQueryParams`'s passthrough branch, which skips
  `secretQueryRefs` keys (code-injected, not agent-settable).

**Output-channel audit — query-param secrets (two channels, two defenses)**

- *Channel 1 (URL):* `redactSecretParams(url, secretParamNames)` redacts
  at the capture point so the real URL never passes the fetch layer.
  Covers every emit site: `formatRequestLine`, `details.request.url`,
  `renderResult`, `formatHelperError`, `PaginateResult.urls` — including
  server-supplied `nextUrl` (redact at the `urls.push` site).
  **Redact *before* the error path, not only in the return value.**
  `restGet`/`paginate` pass the raw URL into `checkResponseStatus`
  (`core/helpers.ts:382`, `:630`), where it is stored on `HelperError.url`
  and later rendered by `formatHelperError` → `formatRequestLine`. Compute
  the redacted URL upstream of the `checkResponseStatus` call so the
  secret-bearing URL never reaches the error object.
- *Channel 2 (params):* inject the secret **below** the returned params
  map, never into it. Return-contract change: `restGet`/`paginate`
  `params` becomes "agent-supplied params." `api-fetch` emits
  `details.request.params` from the pre-injection map. The secret key is
  absent from the returned map entirely (not present-but-redacted).
- `api-fetch` call sites (`tools/api-fetch.ts:242`, `:292`) updated to
  the new `params` semantics.

**`hasAuth` extension**

- `opts.hasQuerySecret: boolean` set by `helpers.ts` when
  `secretQueryRefs` injected any params. `hasAuth` = header-secrets ∨
  query-secrets. Cache-skip and redirect-forcing key on `hasAuth`, so a
  `secretQueryRefs`-only guide is covered (the gap that motivated the
  broader flag).

**`api-probe` store-backed auth (`tools/api-probe.ts`)**

- Optional `auth?: { secretRefs?, secretQueryRefs? }` param (injection
  fields only, no `kind`/`requires`/`optional`) + optional `domain`
  param (defaults to `apiHost` hostname).
- Resolve `secretName → value` from the store; inject. Value never enters
  transcript — only header/param names and secret names do.
- Store-miss path: **fetch anyway with the missing header/param omitted**,
  report the miss in the note (do not fail closed — probe is a
  human-in-the-loop authoring tool). Distinguish in `fetchOne`'s status
  note: no `auth` block → existing `auth:none` wording; `auth` block but
  miss → `secret "<name>" not found in store for domain "<domain>"` (the
  stale `auth:none` text must not fire).
- Output-channel reuse: same `redactSecretParams`, same
  inject-below-params, at the probe's `fetchUrl` call site. Set
  `hasAuth`/force guarded redirects when `auth` non-empty. Probe already
  passes `fresh: true` (no cache concern).
- **Body-scrub for auth-bearing probes.** `api-probe.ts:211` slices
  `res.body.slice(0, 800)` into `r.raw` and emits it directly; the probe
  has its own 401/403 branch at `:218` and **bypasses `checkResponseStatus`**,
  so sprint 1's 401-body scrub does not cover it. Add a probe-local scrub
  of known secret values from `r.raw` (or fail-closed body drop) for
  auth-bearing probes — otherwise a 401 body echoing the auth header
  value leaks the secret into agent context.

**`api-probe` secret-name discovery (learn-only — the bootstrap gap)**

- Problem: during authoring in `/api learn`, the agent has no
  programmatic way to discover which secret names are already provisioned
  for a domain. `/api secrets <domain>` is a **user-typed slash command**
  (pi runs extension commands before agent processing; the agent never
  invokes them), and the four registered tools surface no stored names.
  This is a real chicken-and-egg gap: a user pre-stashes a key via the
  manual-entry escape valve (`/api secrets <domain> <name>`) under a name
  of their choosing, the agent invents its own `secretName` while
  authoring, probes with the store miss-note, and never learns the right
  name is sitting in the store.
- Fix (one tool, two modes): add an optional `listSecrets: true` param
  to `api-probe`, gated to learn mode (`learnToolsEnabled`). When set, the
  probe short-circuits the fetch and returns the provisioned secret names
  for `domain` (defaulting to `apiHost`'s hostname) via `listNames(domain)`
  — names only, never values, reusing the store's existing names-only
  contract. No new tool, no new plumbing: `api-probe` already takes the
  `domain` param (this sprint) and already does store reads for its auth
  injection.
- Return shape: a `secrets` block on `ProbeResult` —
  `{ domain, provisioned: string[], declared?: string[] }`. `declared` is
  populated when a guide is already registered for the domain (from
  `auth.requires ∪ auth.optional`), letting the agent see
  provisioned-vs-declared gaps in one call. Absent a registered guide,
  `declared` is omitted and only `provisioned` is returned. The fetch
  fields (`url`/`status`/`shape`/`draft`/`raw`) are empty in list mode.
- Learn gate is hard: `/api on` (non-learn) calls with `listSecrets:
  true` are refused with a one-line "learn mode only" note. In normal use
  the agent has no business enumerating the secrets store — discovery is
  an authoring act, provisioning is a human act.
- Output-channel reuse: list mode emits no URL, no params, no body — so
  this sprint's `redactSecretParams` / inject-below-params / probe-local
  body-scrub channels do not apply. The only emit is the names array,
  which is names-only by the store contract.

**Production validation: Etherscan V2 guide (A2)**

- New `api-guides/api.etherscan.io/` recipe: query param `apikey=`,
  `chainid`, `auth.kind: static-key`, `auth.secretQueryRefs`, `auth.requires:
  [apikey]`, offset pagination (`page`/`offset`). Free 3/s, 100k/day.
- This is the security-critical axis — it forces both output-channel
  defenses. Co-located tests.

### Tests (acceptance proof)

- URL channel: redacted `?key=***` at every emit site incl.
  server-supplied `nextUrl`; a non-secret param stays intact.
- Params channel: `result.params` / `details.request.params` **never
  contains the secret value** for a `secretQueryRefs` guide — the key is
  absent from the returned map (the proof that the return-contract change
  holds; without it the leak is silent).
- `passthrough` guard: an agent-supplied value for a secret param name on
  a `passthrough` op is dropped before the query string.
- `secretQueryRefs`-only parity: (i) authenticated response not cached
  (`hasAuth` skips, `hasAuthHeaders` would not); (ii) 302→internal
  blocked by forced guarded path.
- Parser: `secretQueryRefs`↔`params` collision is a parse error;
  `passthrough` + `secretQueryRefs` parses.
- `api-probe`: inline `auth` injects from store; miss reported in note,
  not failed closed; stale `auth:none` text does not fire on a miss; URL
  redacted; **auth-bearing probe's `r.raw` 401-body slice contains no
  secret value** (probe-local body scrub, not the bypassed
  `checkResponseStatus` path).
- `api-probe` list mode: `listSecrets: true` in learn mode returns
  `provisioned` names for the domain (names only, no values); with a
  registered guide, `declared` is populated and a provisioned-vs-declared
  gap is visible in one call; the fetch fields are empty.
- `api-probe` list-mode learn gate: `listSecrets: true` under `/api on`
  (non-learn) is refused with the "learn mode only" note and does not
  touch the store.
- Error-path URL redaction: a `HelperError` from `restGet`/`paginate`
  carries the redacted URL on `err.url` (proves the redact-before-
  `checkResponseStatus` ordering), so `formatHelperError` renders
  `?key=***`, never the raw value.
- Etherscan: parses cleanly; endpoint coverage under `HOST_INTEGRATION=1`.

### Acceptance criteria

1. A user provisions the Etherscan key via `/api secrets api.etherscan.io`
   and `api-fetch` returns data with `?apikey=***` in every surfaced URL
   and no `apikey` entry in `details.request.params` — the real key never
   surfaces.
2. A server-supplied `nextUrl` containing `?apikey=<real>` is redacted
   before it enters `PaginateResult.urls`.
3. An agent that supplies `apikey` as a param on a `passthrough` op cannot
   override or race the injection (value dropped).
4. A `secretQueryRefs`-only guide is not cached and is SSRF-guarded
   (parity with header-secret guides).
5. `api-probe` with an inline `auth` block fetches an auth-gated endpoint
   with the key injected from the store; on a store miss it reports the
   miss and fetches unauthenticated rather than failing or emitting the
   stale `auth:none` hint.
6. In `/api learn`, `api-probe` with `listSecrets: true` surfaces the
   provisioned secret names for a domain (and the declared names when a
   guide is registered) without fetching — closing the bootstrap gap
   where a user pre-stashed a key under a name the agent didn't pick.
   Under `/api on` the same call is refused with the "learn mode only"
   note.
7. Full structural suite + `all-guides-parse` green.

### Out of scope (this sprint)

- Path-injected secrets (`secretPathRefs`) — harder redaction story,
  deferred (design doc edge case).
- The optional-auth keyed variants as shipped recipes (sprint 3).

## Sprint 3 — Stateful sessions + optional-auth keyed variants

**Goal:** prove the opaque-token session pattern (A3, no core change) and
exercise `auth.optional` end-to-end with the two keyed variants. This
sprint is **guide-only** — no core change — and can be parallelized across
the three recipes once sprints 1–2 land.

### In scope

**NCBI E-utilities guide (A3) — new `api-guides/eutils.ncbi.nlm.nih.gov/`**

- Replaces/extends the shipped no-auth guide. Documents the two-step
  `usehistory=y` flow: `esearch` returns `WebEnv`/`query_key`, then
  `esummary`/`efetch` pass them back as params. Tokens are public (not
  secrets) → no store, no core change. XML format.
- Optional `api_key` (raises rate limits) modeled as `auth.optional` +
  `secretQueryRefs` (reuses sprint 2). The `epost` op (uploads an
  arbitrary UID set — a mutation) is **excluded**.
- Co-located tests.

**GitHub keyed variant (A1 + optional) — new multi-recipe dir**

- New directory alongside the shipped `api.github.com` no-auth guide
  (the `archive.org` + `archive.org-wayback` pattern). `Authorization:
  Bearer` PAT, `auth.optional` (60/hr unauth → 5000/hr authed),
  `secretRefs`, a bounded subset of auth-gated read-only ops (issues,
  PRs, file contents, CI status).
- Co-located tests.

**GitLab keyed variant (A1 + optional) — new multi-recipe dir**

- New directory alongside the shipped `gitlab.com` no-auth guide.
  `Authorization: Bearer` PAT with `read_api` scope, `auth.optional`
  (10/min unauth → 60/min authed), `secretRefs`, a bounded subset of
  `read_api`-gated read-only ops.
- Co-located tests.

### Tests (acceptance proof)

- Each new guide parses cleanly (`all-guides-parse`); endpoint coverage
  under `HOST_INTEGRATION=1`.
- Optional-auth footer states exercised: unauthenticated fetch shows
  `auth: optional (not provisioned)`; provisioned fetch shows
  `auth: ok (optional)`.
- NCBI: the two-step `usehistory` flow round-trips `WebEnv`/`query_key`
  as ordinary params (proves the "already supported" claim — no special
  handling).

### Acceptance criteria

1. NCBI `esearch` + `esummary` two-step flow works through `api-fetch`
   with no core change beyond sprints 1–2; the optional `api_key` raises
   rate limits when provisioned and the flow works unauthenticated when
   not.
2. GitHub/GitLab keyed variants fetch auth-gated ops with a PAT from the
   store; without the PAT they fall back to the unauthenticated rate with
   the `optional (not provisioned)` footer.
3. `api-guide` on each multi-recipe domain shows the disambiguation menu
   (no-auth vs keyed) and accepts the `guide` selector.
4. `all-guides-parse` + structural suite green.

### Out of scope (this sprint / this slice)

- OAuth2 (all flows) — `auth.kind: "oauth2"` seam stays, unrealized.
- General mutations / write gate — transport stays GET-only.
- Cookie-login (jar + `api-login`) — deferred (design doc R5).
- OS-keychain at-rest (`@napi-rs/keyring`) — additive store backend.
- Path-injected secrets (`secretPathRefs`).

## Cross-sprint concerns

**The output-channel audit is the spine.** It is called out in each
sprint's tests because it is the work most likely to be skipped under
deadline (design doc, Risks). The audit is cumulative: sprint 1 covers
header-secrets channels (401 body, response-header echo), sprint 2 adds
the query-param channels (URL, params map). Do not ship a sprint without
its audit tests; a green structural suite with a missing audit test is a
shipped leak.

**No `scopes` field.** The transport is GET-only; read-only is a plugin
invariant enforced structurally. The roadmap's `scopes: ["read"]` plan is
retired (design doc, §Read-only & scopes). Do not reintroduce it.

**`hasAuth` is per-request, not per-guide.** The cache-skip and
redirect-forcing gates key on whether *this call* injected a secret, so
an `auth.optional` guide fetched unauthenticated is correctly cached
under the bare URL; the moment a token is provisioned the next call skips
the cache. Do not cache the guide-level "has optional auth" flag (design
doc footer note).

**Testing tiers.** Store, parser, output-channel, SSRF, and footer tests
are structural (no network) — live in `__tests__/`. Recipe
endpoint-coverage tests are `HOST_INTEGRATION=1`-gated and co-located
under `api-guides/<domain>/` (the `boe.es` pattern). The output-channel
audit tests use mocked transport (the existing `axis-units` /
`transport` fixture pattern), not live endpoints.

**The bootstrap gap is closed by `api-probe`, not by a new tool.** The
agent's only programmatic path to the secrets store is `api-probe`'s
learn-gated list mode — `/api secrets` is user-typed only (pi runs
extension commands before agent processing; the agent never invokes
them). Do not add a second secrets-discovery tool; one tool, two modes
is the lazy shape.

**Doc updates to land with the work:** `packages/pi-lean-host/AGENTS.md`
command list (`/api secrets`), the `auth` schema fields, and the
threat-model summary. Cross-reference this plan from
`api-auth-and-cookies.md` on completion.
