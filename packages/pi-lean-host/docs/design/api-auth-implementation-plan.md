# pi-lean-host — Authenticated-API Implementation Plan

> Sprint plan for realizing
> [`api-auth-and-cookies.md`](./api-auth-and-cookies.md) (the static-key
> retrieval slice) and shipping the proof recipes in
> [`api-auth-recipe-candidates.md`](./api-auth-recipe-candidates.md).
> Anchors development to the design doc's named seams; divides work into
> three sprints ordered by **leak risk, not feature completeness**.
>
> Status: **sprint 1 implemented** (secrets store + header-auth vertical slice,
> CoinGecko proof recipe, output-channel audit); **sprint 2 implemented**
> (query-param secrets + authoring-loop auth, Etherscan V2 proof recipe);
> sprint 3 pending. Source of truth for the
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

## Sprint 1 — Secrets store + header-auth vertical slice ✅ (shipped)

**Goal met:** a keyed header-auth guide (CoinGecko) fetches end-to-end with
the key value never entering agent context. Source of truth for the
*what/how* — including the output-channel audit, fail-closed, and SSRF
(a/b/c) guarantees — is [`api-auth-and-cookies.md`](./api-auth-and-cookies.md)
and the code referenced below; the original plan text (in scope / tests /
acceptance criteria) was condensed here on completion.

**Shipped:**

+ `core/secrets-store.ts` — swappable `SecretStore` + `0600` file backend
  at `~/.pi/agent/pi-lean-host/secrets/<domain>.json`; read/write/delete/
  deleteDomain/list; lazy-mkdir-on-write-only; file pruning when a domain
  empties.
+ `core/secrets-command.ts` (`/api secrets`) — list / `<domain>` assisted
  entry (guide-aware, single-prompt or picker) / `<domain> <name>` manual
  entry / `--delete` (single + whole-domain, interactive confirm) /
  `--help`; headless prints file-write instructions and deletes without
  confirm; names-only output, value never emitted.
+ `core/api-guide-types.ts` + `core/parse-api-guide.ts` — `auth.kind:
  static-key` + `secretRefs`/`requires`/`optional`; `validateAuth` rules;
  `oauth2` rejected at parse; `all-guides-parse` widened to accept
  auth-bearing guides.
+ `core/auth.ts` — `resolveSecretHeaders` (store injection, fail-closed on
  `requires` absent, proceed on `optional` absent) + `authStatusLine`
  (5-state metadata footer on `api-guide` + `api-fetch`).
+ `core/transport.ts` + `core/helpers.ts` — `hasAuth`, `secretHeaderNames`
  plumbed through `FetchOptions`, forced guarded redirects on auth,
  `stripSecretHeaders` on cross-domain hops; 401-body scrub +
  response-header-echo scrub in `checkResponseStatus`.
+ Recipe: `api-guides/coingecko.com/` (`x-cg-demo-api-key`, offset
  pagination) + co-located `endpoint-coverage.test.ts`
  (`HOST_INTEGRATION=1`).

**Verified by:** `__tests__/secrets-store.test.ts`, `secrets-command.test.ts`,
`auth.test.ts` (audit + SSRF a/b/c + fail-closed + footer), widened
`all-guides-parse.test.ts`, plus the structural suite.

**Deferred to later sprints:** `secretQueryRefs` + everything it forces and
`api-probe` store-backed auth → **sprint 2**; optional-auth keyed recipes →
**sprint 3**; OS-keychain backend (additive seam).

## Sprint 2 — Query-param secrets + authoring-loop auth ✅ (shipped)

**Goal met:** a keyed query-param guide (Etherscan V2) fetches end-to-end with
both output-channel defenses (URL redaction + params-below-map) in place, and
`api-probe` can probe auth-gated endpoints (inline `auth` injection) and
enumerate provisioned secret names (learn-gated `listSecrets` mode). Shipped:
`secretQueryRefs` schema + parser (incl. the op-`params` collision rule),
`redactSecretParams` at every emit site (result.url, urls[] incl. server
`nextUrl`, HelperError.url), inject-below-params return contract,
`hasQuerySecret` → broadened `hasAuth` (cache-skip + guarded redirects),
api-probe inline-auth / store-miss / body-scrub / list mode + learn gate, and
the Etherscan V2 proof recipe. Verified by `__tests__/query-secrets.test.ts`,
the `secretQueryRefs`-only parity tests in `auth.test.ts`, the api-probe
list-mode tests, and the live Etherscan coverage suite under
`HOST_INTEGRATION=1`.

**Shipped:**

+ `core/api-guide-types.ts` + `core/parse-api-guide.ts` —
  `auth.secretQueryRefs: Record<paramName, secretName>`; `validateAuth`
  rule rejecting a secret param name that collides with any operation's
  `params` map (agent must not be able to supply a secretly-injected
  param); `passthrough` + `secretQueryRefs` parses (defense is runtime).
+ `core/helpers.ts` — `redactSecretParams(url, secretParamNames)` applied
  at every emit site (`result.url`, `PaginateResult.urls` incl.
  server-supplied `nextUrl`, `HelperError.url`) computed upstream of the
  `checkResponseStatus` call so the secret-bearing URL never reaches the
  error object; inject-below-params return contract (`restGet`/`paginate`
  return only agent-supplied params, secret absent from the map entirely);
  passthrough guard in `buildQueryParams` dropping agent-supplied values
  for secret param names.
+ `core/transport.ts` + `core/helpers.ts` — `hasQuerySecret` flag;
  `hasAuth` = header-secrets ∨ query-secrets; cache-skip and forced
  guarded redirects key on `hasAuth`, giving `secretQueryRefs`-only guides
  parity with header-secret guides (the gap that motivated the broader
  flag).
+ `tools/api-fetch.ts` — call sites updated to the new params semantics
  (agent-supplied params map emitted into `details.request.params`;
  secret key never present).
+ `tools/api-probe.ts` — optional inline `auth` param (injection fields
  only) + optional `domain`; store-backed injection (value never in
  transcript); store-miss fetches unauthenticated with a miss note rather
  than failing closed (stale `auth:none` text suppressed on a miss);
  probe-local 401/403 body scrub of known secret values from `r.raw`
  (covers the `checkResponseStatus`-bypassing path); learn-gated
  `listSecrets: true` mode returning `{ domain, provisioned, declared? }`
  via `listNames(domain)` (names only, declared populated when a guide is
  registered for the domain); refused under `/api on` with a one-line
  "learn mode only" note.
+ Recipe: `api-guides/etherscan.io/` (routing domain `etherscan.io`, API
  host `api.etherscan.io`) — `apikey` query secret via `secretQueryRefs`,
  `chainid`, `auth.requires: [apikey]`, offset pagination; expanded to a
  comprehensive 45-op read-only free-tier surface across every module
  (account, blocks, contracts, gas, Geth proxy set, logs, tx status,
  stats, API usage), with PRO-gated ops excluded rather than
  declared-but-broken (why: `api-auth-recipe-candidates.md`, Etherscan
  scope note) + co-located `endpoint-coverage.test.ts`
  (`HOST_INTEGRATION=1`, 21 live tests, 450ms throttle for the 3/s tier).

**Verified by:** `__tests__/query-secrets.test.ts` (mocked-transport audit:
URL redaction at every emit site incl. the error path and server
`nextUrl`, params-below-map, passthrough guard, parser collision rule),
the `secretQueryRefs`-only parity tests in `auth.test.ts` (cache-skip +
302→internal SSRF block via forced guarded redirects),
`api-probe.test.ts` (inline-auth injection / miss-note / URL redaction /
list mode + declared-vs-provisioned gap / learn gate), plus the widened
`all-guides-parse.test.ts` and the structural suite.

**Deferred to later sprints:** optional-auth keyed recipes (GitHub/GitLab
PAT variants) + `auth.optional` footer-state parity and the NCBI optional
`api_key` → **sprint 3**; path-injected secrets (`secretPathRefs`) —
harder redaction story, deferred (design doc edge case).

## Sprint 3 — Stateful sessions + optional-auth keyed variants

**Goal:** prove the opaque-token session pattern (A3, no core change) and
exercise `auth.optional` end-to-end with the two keyed variants. This
sprint is **guide-only** — no core change — and can be parallelized across
the three recipes once sprints 1–2 land.

### In scope

**NCBI E-utilities guide (A3) — new `api-guides/eutils.ncbi.nlm.nih.gov/`**

+ Replaces/extends the shipped no-auth guide. Documents the two-step
  `usehistory=y` flow: `esearch` returns `WebEnv`/`query_key`, then
  `esummary`/`efetch` pass them back as params. Tokens are public (not
  secrets) → no store, no core change. XML format.
+ Optional `api_key` (raises rate limits) modeled as `auth.optional` +
  `secretQueryRefs` (reuses sprint 2). The `epost` op (uploads an
  arbitrary UID set — a mutation) is **excluded**.
+ Co-located tests.

**GitHub keyed variant (A1 + optional) — new multi-recipe dir**

+ New directory alongside the shipped `api.github.com` no-auth guide
  (the `archive.org` + `archive.org-wayback` pattern). `Authorization:
  Bearer` PAT, `auth.optional` (60/hr unauth → 5000/hr authed),
  `secretRefs`, a bounded subset of auth-gated read-only ops (issues,
  PRs, file contents, CI status).
+ Co-located tests.

**GitLab keyed variant (A1 + optional) — new multi-recipe dir**

+ New directory alongside the shipped `gitlab.com` no-auth guide.
  `Authorization: Bearer` PAT with `read_api` scope, `auth.optional`
  (10/min unauth → 60/min authed), `secretRefs`, a bounded subset of
  `read_api`-gated read-only ops.
+ Co-located tests.

### Tests (acceptance proof)

+ Each new guide parses cleanly (`all-guides-parse`); endpoint coverage
  under `HOST_INTEGRATION=1`.
+ Optional-auth footer states exercised: unauthenticated fetch shows
  `auth: optional (not provisioned)`; provisioned fetch shows
  `auth: ok (optional)`.
+ NCBI: the two-step `usehistory` flow round-trips `WebEnv`/`query_key`
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

+ OAuth2 (all flows) — `auth.kind: "oauth2"` seam stays, unrealized.
+ General mutations / write gate — transport stays GET-only.
+ Cookie-login (jar + `api-login`) — deferred (design doc R5).
+ OS-keychain at-rest (`@napi-rs/keyring`) — additive store backend.
+ Path-injected secrets (`secretPathRefs`).

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
