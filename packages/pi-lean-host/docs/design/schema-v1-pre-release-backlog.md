<!-- markdownlint-disable MD025 -- multiple top-level headings are deliberate:
     one H1 per priority tier (P0/P1/P2) for backlog tooling. -->

# Schema v1 Pre-Release Backlog — Adversarial Schema Review

> Status: backlog (not yet scheduled). Source: 4-lane adversarial schema-stress
> review (pagination / auth / operations / response) run against the v1 auth
> reshape, before the schema is published. Full lane reports:
> [`schema-review-lane-reports/`](./schema-review-lane-reports/) (also mirrored
> at `/tmp/oracle-{pagination,auth,operations,response}.md`).
>
> **Why this backlog exists.** The schema is unpublished and at
> `schemaVersion` 1 — per the bump rule (post-v1 section of the root
> `AGENTS.md`), breaking fixes are free NOW and expensive later. This doc is
> the complete findings ledger from that review, priority-ordered. It is
> deliberately broader-scope than the authoring/design docs: each item here
> seeds a downstream doc, where it will be elaborated with full caritas
> recipes and its own sprint planning. This doc only records findings,
> priorities, and the conclusions already reached — it does not schedule
> work or group it into sprints.
>
> **Standing constraints applied to every item** (from the review brief):
> read-only forever (GET-only transport — no fix may propose mutations), one
> parser / two call sites, host-only boundary, 1 local helper per domain.

## Priority model

- **P0 — act before release.** Breaking-shaped fixes, silent-failure footguns,
  and capability gaps whose fix shape should exist before guides accrete.
  The unpublished window is exactly what makes these free.
- **P1 — freeze decisions now (cheap, prevents later breaks).** Doc/commitment
  items: reserved seams, upgrade-shape freezes, contract pinning. Almost no
  code, but each one forecloses a future breaking "natural fix".
- **P2 — additive backlog.** Genuinely expressible-today gaps or footguns with
  clean additive fixes; safe to land anytime, ordered by expected recipe pain.

---

# P0 — Act before release

## P0-1. Pagination blocks silently ignore unknown keys (parse-integrity)

**Classification: the review's one confirmed BREAKING-RISK.**

- **Pattern/trigger:** any authoring session. A guide writing `itemPath:`
  instead of `itemsPath:`, or `cursorPath:` on a `nextLink` op, parses OK and
  **silently single-pages at runtime**.
- **Gap:** `validatePagination()` (parse-api-guide.ts) reads known keys and
  constructs the config without comparing `Object.keys(p)` against a per-style
  allowlist. Auth already got this treatment (`AUTH_ALLOWLISTS` rejects
  unknown keys per kind); pagination did not.
- **Why breaking:** adding the allowlist later is a parse-behavior tightening —
  any guide carrying a stray key (the removed pre-release
  `completeListSizePath` is exactly this drift class, documented in the type
  file itself) goes parse-OK → malformed, which per the bump rule ("changing a
  parse-enforced constraint's meaning") forces a schemaVersion bump.
- **Fix (~20 lines):** mirror `AUTH_ALLOWLISTS` with per-style key sets:
  - `offset-limit` / `page`: style, itemsPath, pageParam, pageSizeParam,
    pageSize, base
  - `nextLink`: + nextLinkPath
  - `cursor`: + cursorParam, cursorPath
  - `resumptionToken`: + tokenParam, tokenPath
  - `tokenBag`: + continuationParams
  - all styles: + totalCountPath (style-agnostic)
  Reject unknown keys with a ParseError, like auth does. Reuse the existing
  pattern — no new mechanism.
- **API examples:** N/A (schema-integrity finding); the trigger class is any
  typo'd guide.
- **Tests:** malformed-guide test per style (unknown key rejected, known keys
  still parse); existing axis guides keep parsing.

## P0-2. Dot-containing JSON keys break every path field (Microsoft Graph/OData v4 inexpressible)

- **Pattern:** OData v4 (Microsoft Graph, SharePoint REST, Dynamics 365, SAP
  OData) paginate via a literal top-level key `@odata.nextLink` and expose
  totals via `@odata.count`
  (`{"value":[…],"@odata.nextLink":"https://graph.microsoft.com/v1.0/users?$skiptoken=…"}`).
  Evidence: <https://learn.microsoft.com/en-us/graph/paging>
- **Gap:** `resolveJsonPath` (helpers.ts) normalizes `[n]` → `.n`, then
  `split(".")`. `@odata.nextLink` → parts `["@odata","nextLink"]` → `undefined`
  → `advancePagination` returns null → **gatherAll silently terminates after
  page 1 with no error**. The existing bracket-quote regex makes it worse:
  `['@odata.nextLink']` is rewritten to `.@odata.nextLink` then dot-split — the
  apparent escape hatch degrades into the same bug. Hits `itemsPath`,
  `nextLinkPath`, `cursorPath`, `tokenPath`, `totalCountPath` for any dotted
  key. No workaround: local helpers are pre-call params-only; `transform` runs
  post-parse and never sees pagination advance.
- **Fix (behavior, no YAML change, no bump):** make quoted bracket segments
  atomic keys in `resolveJsonPath` (capture `['…']` segments, dots included,
  before dot-splitting). Unquoted legacy paths parse identically. Document the
  escape in the authoring docs so caritas Graph recipes are written correctly
  the first time.
- **Tests:** `['@odata.nextLink']` resolves; unquoted `@odata.nextLink` keeps
  failing loudly (no silent partial match).
- **Grouping note:** land with P2-1 (numeric cursor coercion) — same function,
  same test file.

## P0-3. `secretPathRefs` — token-in-path APIs leak secrets today

- **Pattern:** Telegram Bot API keys *every* method through the URL path:
  `https://api.telegram.org/bot<token>/getUpdates` — read-only GETs included.
  Evidence: <https://core.telegram.org/bots/api> ("Making requests").
- **Gap:** `StaticKeyAuth` has exactly two injection surfaces: `secretRefs`
  (headers) and `secretQueryRefs` (query). `Operation.path` tokens are
  inferred agent params filled by `fillPathStrict` from **caller-supplied**
  params; redaction (`redactSecretParams`) covers query params only. The only
  today-expression for Telegram is `path: /bot{token}/getUpdates` with the
  caller passing the token — **the secret enters agent context and the
  transcript, unredacted** (the output-channel audit only tracks
  store-injected header/query values). The schema invites the exact leak the
  design forbids.
- **Fix (new optional field, mirrors `secretQueryRefs` one-for-one):**
  - TS: `StaticKeyAuth.secretPathRefs?: Record<string, SecretRef>`
  - Parser: validate like `secretQueryRefs` + symmetric collision rule — a
    path token named in `secretPathRefs` must NOT be caller-suppliable
    (reject; `fillPathStrict` fills it from the store instead).
  - Executor: fill secret-owned path tokens from the store before
    `fillPathStrict`; add resolved values to `secretValues` so error bodies
    scrub them; redact the token from every surfaced URL.
- **Cost:** ~an afternoon; zero existing-guide breakage. The asymmetry that
  makes it P0: every guide written before this field either can't exist or
  leaks tokens.
- **Tests:** parse collision guard; executor fills from store; URL redaction;
  secret scrub on error bodies.

## P0-4. Stripe-style exhaustion — negative-index cursors + `hasMorePath`

**Conclusion from the review: fix now (capability gap + silent-failure footgun),
even though strictly additive-later.** Stripe has a canonical spec, a testable
shape, and a silent-truncation footgun; HMAC (P1-1) has neither, which is why
these two "inexpressible" findings get opposite treatments.

- **Pattern:** Stripe list endpoints return `{ data: [...], has_more: bool }`
  with **no cursor field anywhere in the envelope**. Documented manual loop:
  "If the value is `true`, get the ID of the last object returned, and make a
  new API call with `starting_after` set."
  Evidence: <https://docs.stripe.com/pagination> (fetched). Same family: Discord
  message pagination (`after=<last message snowflake>`), SQL keyset/seek
  pagination. Related exhaustion variant: Apache Solr `cursorMark` — every
  response carries `nextCursorMark` and exhaustion is signaled by it *equaling
  the cursor you sent* (the field is never absent, so "cursor missing → done"
  never fires and a naive loop refetches the same page forever, bounded only by
  `gatherAllMax`). Evidence:
  <https://solr.apache.org/guide/solr/latest/query-guide/pagination-of-results.html>
- **Gap:** `resolveJsonPath` supports dot-splitting + non-negative indexes
  only — `data[-1].id` does a literal `"-1"` property lookup → `undefined` →
  `advancePagination` returns null → **gatherAll stops after page 1 and
  reports success, as if the list were complete** (silent, confident, wrong).
  Separately, `advancePagination()` defines exhaustion exclusively as "the
  cursor/next/token field is absent, empty, or unresolvable"; there is no
  stop-condition field, so an always-present repeating cursor loops.
- **Fix (two orthogonal pieces):**
  1. Negative-index support in `resolveJsonPath` (`data[-1].id`). Behavior
     relaxation, non-breaking. Note: Stripe's page-past-the-end returns
     `data: []`, so negative-index *alone* gets Stripe working (last page →
     cursor unresolvable → clean stop), at the cost of one extra request.
  2. `pagination.hasMorePath?: string` (style-agnostic, mirrors
     `totalCountPath`): when present and falsy on a page → stop; when absent →
     keep current empty-page/unresolvable-cursor semantics. Covers Solr
     (`hasMorePath` can't express equality-with-sent directly, but the common
     boolean-flag case; ship the smaller field first — `stopWhen:
     "cursorUnchanged"` is the documented upgrade if Solr is ever targeted).
- **Target recipe (what becomes expressible):**

  ```yaml
  pagination:
    style: cursor
    itemsPath: data
    cursorParam: starting_after
    cursorPath: "data[-1].id"
    hasMorePath: has_more
  ```

- **Tests:** `data[-1].id` resolves; `hasMorePath: false` stops;
  `hasMorePath` absent → current semantics unchanged; parser validation of
  `hasMorePath` (mirrors `totalCountPath`).

---

# P1 — Freeze decisions now (doc/commitment items)

## P1-1. Reserved seam — request-derived credentials (HMAC/SigV4/digest): **doc-only, do not build**

**Conclusion from the review (the `tokenKey` precedent).** Request-derived
credentials are provably inexpressible today — but the fix is **not
breaking-shaped**, so the unpublished window buys nothing, and the right action
is a reserved-seam note plus an ordering discipline, not a v1 implementation.

- **Pattern:** Binance SIGNED endpoints — all read-only GETs included — require
  `timestamp` and `signature` **query params** where
  `signature = HMAC-SHA256(secretKey, totalParams)` over the exact query
  string (HMAC, RSA, and Ed25519 key types documented).
  Evidence: <https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/rest-api.md>
  AWS SigV4 signs even plain S3 GETs: `Authorization` is a *derived composite*
  (`Credential=…,SignedHeaders=…,Signature=…`) plus `X-Amz-Date` /
  `X-Amz-Content-Sha256`; the signature is a function of method + path + query
  - headers. Evidence:
  <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html>
  Digest auth (RFC 7616) is the same class one level harder (401
  challenge-response nonce).
- **Gap:** `SecretRef` resolution is verbatim-plus-prefix only
  (`(ref.prefix ?? "") + value` in `auth.ts`); nothing can produce a value
  *computed from* a secret plus request context. The escape valves can't save
  it: the local helper is pre-call **params-only** (never sees secrets, by
  design) and `transform` runs post-parse. Architecturally,
  `resolveOpForExecution` resolves auth (step 3) **before** the executor
  constructs the URL, and `SecretResolution` carries no request context —
  every signature scheme needs the opposite order (final URL first, then
  auth).
- **Why not build now:** new auth `kind` = additive whenever it lands (new enum
  values are non-events under the bump rule), so waiting is free schema-wise.
  Zero bundled recipes need it (crypto/trading/AWS APIs — plausible caritas
  territory, not the current doc-data corpus), and SigV4's canonical-request
  machinery (header sorting, URI-encoding rules, payload hashes) is too
  intricate to spec blind — an untestable, unused implementation would be
  wrong and still have to be redone.
- **The cheap-now action (doc-only):** add a reserved-seam paragraph next to
  the `tokenKey` one in `core/api-guide-types.ts` (and/or the authoring docs):
  > **Reserved seam — request-derived credentials.** HMAC/SigV4/digest-signed
  > GETs will land as a new auth `kind` (or a `derive`-family field on
  > `SecretRef`) and will require auth resolution to see method + final URL;
  > `resolve-op.ts` step 3 must not assume auth is URL-independent. Declared
  > now so the sequencing is never further entrenched.
  Plus one discipline rule: when touching resolve-op, do not entrench
  auth→URL ordering further.
- **Trigger to act for real:** a caritas recipe targets Binance/AWS-class
  signed GETs. At that point, design the kind against the live provider, not
  speculatively.

## P1-2. Link-header pagination — freeze the additive shape now

- **Pattern (highest-frequency gap on the pagination axis):** GitHub REST —
  bare JSON arrays with the next page as `Link: <…?page=2>; rel="next"` in the
  **response headers**; the body never contains a next URL.
  <https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>
  GitLab — same `Link` header; for keyset pagination the header **is the
  only** next-page indicator (nothing in the body), plus `x-next-page` /
  `x-total` header-only metadata. <https://docs.gitlab.com/api/rest/> (fetched).
  Shopify Admin REST — cursor pagination via `Link` header only.
- **Gap:** every extraction field (`nextLinkPath`, `cursorPath`, `tokenPath`,
  `continuationParams`, `totalCountPath`) resolves through `resolveJsonPath`
  against the **parsed body only**; `paginate()` discards `result.headers`
  entirely. Provably inexpressible today.
- **Classification:** additive (`linkHeader` enum value + optional fields =
  non-event), **but** the lazy future fix is exactly the kind that bumps:
  overloading `nextLinkPath` with magic values like `"header:Link"` re-means
  an existing field. Freeze the shape now so that fix never happens.
- **Frozen shape (for the downstream doc):**
  - `PaginationStyle += "linkHeader"`
  - `linkRel?: string` (default `"next"`) — parse the `Link` header, select by
    `rel`, follow the URL through the existing nextLink SSRF-guard path
    (**the guard must key off the new style — the URL is server-supplied from
    a header, equally attacker-controllable**).
  - If totals-in-header is wanted later: `totalCountHeader?: string` (GitLab
    `x-total`; same class as EIA's header-reported row total and Zotero
    `Total-Results`) — additive, orthogonal.
  - Related (from the operations lane): `PaginateResult` exposes no headers at
    all; a header-total API paginated by body params can't surface
    `serverTotal` without exposing headers on `PaginateResult`.
- **Classification: no breakage if frozen now; P1 because the freeze is the
  whole point.**

## P1-3. `requiresAnyOf` multi-group — freeze the upgrade shape + fix the comment

- **Pattern:** at-least-one-of params are real and common (Twitch Helix
  `/helix/users` requires `id` or `login` — encoded in the in-repo twitch
  guide; MediaWiki `titles`/`pageids`/`revids` peers). Multi-*group* needs
  (two independent at-least-one-of groups in one op): no compelling real case
  found among target read APIs after probing.
- **The breaking trap (not the ceiling):** the "natural" fix of changing
  `requiresAnyOf?: string[]` → `requiresAnyOf?: string[] | string[][]` would
  re-mean an existing field and trigger the bump rule. The code comment
  already reserves the safe answer; freeze it as a commitment:
  > Multi-group lands **only** as a new sibling key
  > (`requiresAnyOfGroups?: string[][]`, AND semantics over groups, each group
  > at-least-one-of), never as a union on the existing key.
- **Also fix the misleading doc comment while it's free:** the types file
  calls `requiresAnyOf` members *"mutually exclusive peers"*, but runtime
  semantics are at-least-one-of with all supplied members sent, and real APIs
  combine members (Twitch: `id` AND `login` together is valid — up to 100 of
  each). "Mutually exclusive" is the wrong model and could mislead the future
  multi-group design (e.g. wrongly auto-deriving exactly-one semantics, which
  WOULD be a re-meaning). The `default`-ban on members remains correct.
- **Classification: doc-only now; the delta itself stays reserved, not built**
  (no real case found).

## P1-4. Pin the load-bearing idioms & implicit contracts (doc + contract tests)

Three undocumented behaviors are de-facto schema; a future "improvement" to
any of them retro-breaks every recipe that encodes them. Free to pin now.

1. **XML contracts** (response lane): `@_` attribute prefix, `#text`
   text-node name, and namespace-prefix stripping (`removeNSPrefix: true`)
   are load-bearing — every XML guide's paths encode them (verified live
   against a namespaced arXiv Atom response:
   `itemsPath: "feed.entry"`, `totalCountPath: "feed.totalResults"` work).
   Document in the authoring reference + add a contract test asserting the
   exact parsed shape of a canonical Atom sample. Note (behavior-level, no
   bump): single-entry boxing is asymmetric (`paginate` boxes a lone XML
   record into an array; `restGet` returns the raw object), and
   `parseAttributeValue` value-coercion can mangle zero-padded numeric IDs —
   flip the flags only if a real recipe hits corruption, note in CHANGELOG.
2. **Top-level-array idiom:** `itemsPath: "$"` is the working idiom for "body
   IS the array" (Socrata `/resource/xyz.json`, GitHub bare-array endpoints)
   — the parser requires a non-empty string, and empty-part resolution
   returns the body. Load-bearing and undiscoverable; one line in the
   authoring docs + a test so authors don't guess.
   <https://dev.socrata.com/docs/formats/json>
3. **`requiresAnyOf` comment correction** — folded into P1-3 above.

## P1-5. Reserved-seam watch items (recognized-trigger discipline, `tokenKey` precedent)

Doc-only notes so a future bug report of the named shape is *recognized* as
the trigger instead of re-litigated:

- **`tokenBag` response-key ≠ request-param name** (would reshape
  `continuationParams: string[]` → map — a breaking reshape). Searched for a
  live example (Asana and MediaWiki use same names) and found none — recorded
  so a future bug report of that shape triggers the additive redesign.
- **Per-op auth (`Operation.auth?`)**: guide-level grain is correct for v1
  (mixed-auth domains like Google/GitHub are served by multi-recipe sibling
  guides + `optional` refs — both verified in code). If per-op auth ever
  lands, it's a pure additive field; **do not** re-purpose `auth` into a
  map-of-profiles (`auths: {name: …}`) — that *would* be the breaking
  rewrite. Keep the field name singular-and-overridable in mind.
- **Optional path segments** (variable path depth without op duplication
  would reshape `pathParams: string[]` → object list): additive escape
  `optionalPathParams?: string[]` if a real case ever appears; none found.
- **Per-op `host?` override** (regional hosts): additive; multi-recipe domains
  cover the clean split today. Mixed version prefixes are already expressible
  via op `path` (EIA v1/v2, Graph v1.0/beta — `path` may carry the prefix).

---

# P2 — Additive backlog (safe anytime, ordered by expected recipe pain)

## P2-1. Numeric cursor coercion (silent "last page" footgun)

- **Pattern:** APIs returning numeric continuation values (integer
  `next_cursor`, numeric page token); XML elements whose parsed form is an
  object (OAI-PMH final `<resumptionToken/>` with attributes only).
- **Gap:** all three value branches in `advancePagination` require
  `typeof === "string"` and otherwise return null — indistinguishable from
  genuine exhaustion. A numeric cursor yields a **silently truncated result
  reported as a complete list** — the worst failure mode for an
  agent-facing executor. `tokenBag` already coerces `String(v)`, so the
  codebase disagrees with itself.
- **Fix:** coerce numbers to strings like `tokenBag`; keep `""`/missing as
  exhaustion. Behavior, not schema — no bump. One `axis-units` test asserting
  numeric cursors advance.
- **Pair with P0-2** (same function, same test file).

## P2-2. Multi-value query params (`listStyle`) + array-value footgun

- **Pattern (three real serializations):**
  - comma-joined: Bugzilla `GET /rest/bug?id=12434,43421`; GitHub search
    `labels`; arXiv `id_list` —
    <https://bugzilla.readthedocs.io/en/latest/api/core/v1/bug.html>
  - semicolon-joined: StackExchange `GET /questions?tagged=c;java` ("the
    `tagged` parameter with a semi-colon delimited list of tags") —
    <https://api.stackexchange.com/docs/questions>
  - repeated/bracket: EIA v2 `?data[]=price&data[]=revenue` (equivalent
    indexed form `data[0]=price&data[1]=revenue` shown in docs) —
    <https://www.eia.gov/opendata/documentation.php>
    Twitch Helix `/helix/users` `id`/`login` are "repeatable, up to 100" —
    the in-repo twitch guide documents it while the schema cannot send two.
- **Gap:** `buildQueryParams()` returns `Record<string, string>` serialized
  via `new URLSearchParams(query)` — one value per key, ever. A
  repeated-key-only API is unreachable (no workaround: `passthrough` and the
  local helper both forward the same single-valued record). **Footgun:** an
  agent passing an array value gets it JSON.stringify'd — `tag=["a","b"]` on
  the wire — silently wrong, no error.
- **Fix:** `listStyle?: "comma" | "repeat" | "bracket" | "semicolon"` on
  `QueryParamSpec` (new optional field + enum values = non-event), and decide
  the array-value semantics now while zero published guides encode
  `["a","b"]`: serialize scalar-arrays per `listStyle` (default comma) or
  reject arrays on non-`listStyle` params. Most documented GET APIs offer a
  comma/indexed fallback, so recipes ship today — this is a
  daily-convenience gap, not a daily blocker; the array footgun is the part
  worth deciding early.
- **Mitigation found expressible today:** bracket param *names* as literal
  YAML keys with single values (`facets[stateid][]: CO`) are legal — keys are
  free-form strings; only multi-value is blocked.

## P2-3. 200-with-error-envelope APIs (`errorPath` / `emptyIsError`)

- **Pattern:** OAI-PMH providers return HTTP 200 with
  `<OAI-PMH><error code="noRecordsMatch">…</error></OAI-PMH>` (normative,
  <https://www.openarchives.org/OAI/2.0/openarchivesprotocol.htm> §3.6);
  Google-style `status: "ZERO_RESULTS"`; Flickr `stat: "fail"`.
- **Gap:** `checkResponseStatus` inspects only the HTTP status, and `paginate`
  treats an unresolvable `itemsPath` exactly like an exhausted feed →
  **success with 0 items**. No way to distinguish "genuinely empty" from
  "itemsPath typo / error envelope" in a gatherAll run.
- **Fix (additive):** optional per-pagination/op `errorPath` (presence of the
  path fails the page with a structured error) and/or `emptyIsError: true`
  (first-page zero-item result becomes a warning instead of a clean
  termination). New optional fields; zero impact on existing guides.
- **Rationale for priority:** closes the "confidently wrong" lie — the worst
  failure mode an agent-facing executor can ship.

## P2-4. ETag cache visibility (tool surface, not schema)

- **Behavior (code-verified):** `transport.ts` caches every 2xx for
  `Cache-Control: max-age` **or a 60s default-TTL fallback — even when the
  server sent no cache headers at all** — and revalidates with
  `If-None-Match`. Auth-bearing requests opt out; plain public GETs silently
  serve ≤60s-stale bodies that render identically to live ones.
  `api-fetch` exposes no `fresh` param and `RestGetResult` drops the
  transport's `cached` flag at the result boundary.
- **Fix (additive, no schema):** (a) optional `fresh?: boolean` on api-fetch →
  `ResolveOpOptions.fresh` → executors (plumbing already exists end-to-end,
  just never set from the tool layer); (b) surface `cached: true` as a footer
  note; (c) consider caching only on explicit server cache headers
  (absence of `Cache-Control` → no-store is the conservative read-only-client
  default).
- **Harm bounded at 60s**, hence P2.

## P2-5. Paginated non-JSON formats (`csv` / `ndjson` in `ResponseFormat`)

- **Pattern:** Socrata SODA — thousands of open-government datasets — serves
  the same resource as JSON or CSV, paginated with `$limit`/`$offset`; CSV
  export is a first-class consumer format.
  <https://dev.socrata.com/docs/formats/csv>
- **Gap:** `format: text` returns the body as a raw string and `paginate`
  then calls `resolveJsonPath(data, itemsPath)` on a *string* → `undefined` →
  **0 items, no error**. No CSV/TSV/ndjson awareness anywhere.
- **Fix (additive):** `format: "csv"` (header row → `Record<string,string>[]`)
  and optionally `"ndjson"` (one JSON object per line), with
  body-is-the-array semantics (pairs with the `itemsPath: "$"` idiom, P1-4).
  NDJSON evidence is weak for plain-GET page-based APIs (mostly streaming
  endpoints) — fold in only when a real recipe needs it.

## P2-6. `dateParams` extensions (epoch, epoch-millis, yyyy/mm/dd)

- **Pattern:** StackExchange dates are unix epoch seconds
  (`fromdate=1293840000`, <https://api.stackexchange.com/docs/dates>); PubMed
  E-utilities `mindate/maxdate` accept `YYYY/MM/DD` (live-verified) —
  <https://eutilities.github.io/site/Reference_Guide/a_reference/>
- **Gap:** `DateParamFormat = "iso8601" | "yyyymmdd" | "yyyy-mm-dd"`; epoch
  integers pass through unchanged only by accident of the regex failing.
- **Fix:** add `"epoch"`, `"epoch-millis"`, `"yyyy/mm/dd"` — enum extension =
  non-event. Convenience only (the agent can always pre-format); bundle with
  P2-2's serializer work if convenient.

## P2-7. Deep-paging guardrail (`pagination.maxOffset`)

- **Pattern:** GitLab caps offset pagination (50k on gitlab.com) and errors
  once exceeded (<https://docs.gitlab.com/api/rest/>,
  <https://docs.gitlab.com/administration/instance_limits/>); Elasticsearch/
  OpenSearch-backed APIs reject `from + size > 10,000`.
- **Gap:** `offset-limit` has no max-offset guard; a `gatherAll` walk past the
  cap aborts the whole gather with a thrown `HelperError` (no partial items)
  instead of stopping cleanly.
- **Fix (additive):** `pagination.maxOffset?: number` — stop when the next
  offset would exceed it, set a ceiling-hit flag. Cheap anytime; only huge
  collections hit it.

## P2-8. `SecretRef.derive?: "base64"` (basic-auth provisioning friction)

- **Pattern:** Jira Cloud `Authorization: Basic base64("useremail:api_token")`
  (<https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/>);
  Azure DevOps `Basic` base64(":"+PAT)
  (<https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate>).
- **Verdict from the review: EXPRESSIBLE-TODAY, not a schema gap.** The store
  is an opaque per-name string — the user provisions the **pre-encoded
  composite** as one entry and the guide declares
  `Authorization: { secret: basic_credential, prefix: "Basic " }`; the audit
  still works (the stored base64 string is what gets scrubbed). Document the
  encoding in prose; `/api secrets` assisted-entry prompts on the declared
  name. **Do not add `derive` now** — only if provisioning friction ever
  measurably hurts. Included here so the conclusion is tracked, not lost.
- **Special-attention verdict (recorded):** `SecretRef { secret, prefix }`
  survives every verbatim header scheme (Bearer, Basic-with-pre-encoded-value,
  `Client-Id` merges, query params). It fails only for per-request derivation
  — a different failure class served by P1-1's future auth kind, **not** by
  re-shaping SecretRef. Do not re-open SecretRef.

## P2-9. OAuth2 grant coverage (device_code, ROPC, JWT assertions) — deferred

- **Patterns:** Google device flow
  (<https://developers.google.com/identity/protocols/oauth2/limited-input-device>);
  ROPC (RFC 6749 §4.3 — already anticipated by the reserved `tokenKey` seam);
  `client_secret_jwt` / `private_key_jwt` assertions (RFC 7523, Salesforce/
  Okta-class token endpoints).
- **Verdict:** all additive — new enum values are non-events;
  `oauth2GrantIssue`/`validateOAuth2Auth` are single-statement seams. One
  recorded sub-gap: `paramStyle: query` hardcodes the param name
  `access_token` (RFC 6750 §2.3-compliant); a provider demanding a different
  query name needs an additive `paramName?: string`. No v1 action — zero
  current recipes need them. JWT assertions additionally ride P1-1's
  derived-credential class.

## P2-10. Verified fine — cleared, no action (recorded to close the review)

Included so later reviewers don't re-litigate:

- **Envelope metadata outside `itemsPath`** (`{data, meta.next_cursor}`):
  `cursorPath` resolves independently of `itemsPath` — expressible.
- **Conditional/hybrid pagination** (GitHub: `Link` header absent on last
  page): absent/unresolvable next → null → stop. Expressible (modulo P1-2's
  header gap).
- **OAI-PMH resumptionToken** as bare XML element:
  `tokenPath: "resumptionToken.#text"`; final `<resumptionToken/>` → `""` →
  clean stop; `totalCountPath: "resumptionToken.@_completeListSize"`.
- **Path templating vs real URL grammar:** composite slash-IDs
  (`encodeURIComponent` → `%2F` is exactly what GitLab/npm need), comma path
  lists, nested resources — all correct today. Caveat for the authoring
  docs: `%2F` is rejected by some reverse proxies (nginx default) — authors
  should prefer explicit two-token paths there. RFC 6570 modifiers
  (`{+var}`) unsupported; no target read-API needs them.
- **Per-op version prefixes:** expressible via op `path` (`/v2/…`).
- **Param aliases** (API accepts old+new names): declare both in `params`.
- **JSON envelope responses / deep nesting:** `restGet` returns the whole
  envelope (OpenAlex `{meta, results}`, Crossref `message.items` — live-
  verified); `itemsPath` handles `hits.hits`-depth nesting; per-op transform
  dispatch multiplexes one export per domain via `ctx.operation`.
- **Per-page shape drift:** no target API found that changes envelope shape
  between pages; later-page path misses degrade gracefully (stop). Revisit
  only if a real provider surfaces.
- **Content negotiation:** two sibling ops with per-op `parse` overrides;
  transport cache keys on Accept.
- **Refresh-token rotation:** handled — old refresh token carried forward
  when the response omits it (RFC 6749 §6), rotated tokens written back,
  per-slot lock prevents concurrent double-spend
  (<https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>).
  A per-token `refresh_url` would be an additive token-store field, not an
  `AuthConfig` change.
- **Gzip:** transport sends no `Accept-Encoding`; conforming servers return
  identity. No action.
- **Response-spill/truncation:** adequate for read-only research use.
- **Agent wants meta + items from a paginate op:** `totalCountPath` covers
  the common need; richer → parallel `restGet` op.
- **Out-of-bounds (noted, dropped):** POST-based pagination (GitHub GraphQL),
  cookie-jar sessions (deferred by design), params in HTTP headers on GET
  (EIA's URL form works), cursor echo in a request *header* (additive
  `cursorLocation` only if a real recipe demands it), `+` vs `%20` encoding
  (no documented read-API breakage; `encoding?: "percent"` escape exists),
  in-schema numeric min/max validation (forever behavioral; description hints
  cover it).

---

## Downstream doc note

Each P0/P1/P2 item above is written to be self-seeding for a downstream doc:
it carries the pattern, gap, fix shape, tests, and API evidence needed to
elaborate it (with full caritas recipes and per-doc sprints) without
re-reading the lane reports. Items that must land together are paired inline
(P0-2 + P2-1 share a function and test file; P2-2's array-semantics decision
spans two items; P2-8's conclusion feeds P1-1's seam). The verified-fine list
(P2-10) and out-of-bounds drops belong in the authoring-reference doc, not a
fix doc.
