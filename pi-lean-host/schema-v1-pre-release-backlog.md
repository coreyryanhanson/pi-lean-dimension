<!-- markdownlint-disable MD025 -- multiple top-level headings are deliberate:
     one H1 per priority tier (P1/P2) for backlog tooling. -->

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
> the complete findings ledger from that review, priority-ordered. A second
> adversarial pass (post-v1-reshape code re-audit + live web evidence; reports
> at
> [`schema-review-lane-reports/second-pass/`](./schema-review-lane-reports/second-pass/))
> added P1-6, P2-6, and closures to the verified-fine list. It is
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

- **P1 — freeze decisions now (cheap, prevents later breaks).** Doc/commitment
  items: reserved seams, upgrade-shape freezes, contract pinning. Almost no
  code, but each one forecloses a future breaking "natural fix".
- **P2 — additive backlog.** Genuinely expressible-today gaps or footguns with
  clean additive fixes; safe to land anytime, ordered by expected recipe pain.

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
  Zero current recipes need it. **Re-audit correction (evidence):** the class
  is *not* confined to crypto/trading/AWS — the HathiTrust Data API, squarely
  in the doc-data corpus, signs its read GETs with OAuth 1.0 HMAC-SHA1 query
  signatures (recorded under the trigger below). Still not a build-now: no
  recipe targets it, and signing machinery (SigV4's canonical requests, OAuth 1
  nonce/timestamp/base-string) is too intricate to spec blind — an
  untestable, unused implementation would be wrong and still have to be
  redone.
- **The cheap-now action (doc-only):** add a reserved-seam paragraph next to
  the `tokenKey` one in `core/api-guide-types.ts` (and/or the authoring docs):
  > **Reserved seam — request-derived credentials.** HMAC/SigV4/digest-signed
  > GETs will land as a new auth `kind` (or a `derive`-family field on
  > `SecretRef`) and will require auth resolution to see method + final URL;
  > `resolve-op.ts` step 3 must not assume auth is URL-independent. Declared
  > now so the sequencing is never further entrenched.
  Plus one discipline rule: when touching resolve-op, do not entrench
  auth→URL ordering further.
  **Status (re-audit): not landed** — `core/api-guide-types.ts` contains
  neither the seam paragraph nor the `tokenKey` reserved-seam paragraph it
  sits "next to" (`tokenKey` appears nowhere under `core/`; it lives only in
  AGENTS.md). Add BOTH paragraphs to the types file — AGENTS.md is
  agent-facing; the types file is where author/developer eyes land.
- **Trigger to act for real:** a caritas recipe targets a signed GET. First
  recorded in-class candidate (re-audit): the **HathiTrust Data API** —
  OAuth 1.0 HMAC-SHA1-signed read GETs (`getmeta`, `getstructure`,
  `getpageocr`, …), spec at
  <https://www.hathitrust.org/documents/hathitrust-data-api-v2_20150526.pdf>
  (v0.9 revision line: "Updated to reflect OAuth 1.0 signed URL
  requirements"), corroborated by the widely-used wrapper
  <https://github.com/rlmv/hathitrust-api/blob/master/hathitrust_api/data_api.py>.
  Binance/AWS-class signed GETs remain the other trigger family. At that
  point, design the kind against the live provider, not speculatively.

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
  **Status (re-audit): the fix is still outstanding in three code locations** —
  `core/api-guide-types.ts:325` (the field's doc comment) and two parser
  messages (`core/parse-api-guide.ts:1564` and `:1620`, the latter inside a
  user-visible `fix:` string). The additive escape itself IS already reserved
  in code (`api-guide-types.ts`: "a multi-group `requiresAnyOfGroups` upgrade
  is purely additive").
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
4. **`transform`'s per-item semantics on `paginate`** (added by the re-audit):
   `transform: true` on `via: paginate` is per-item by documented contract
   (both executors; the escape-valve doc). Whole-envelope transforms — an
   OpenAlex-style `{meta, results}` page where `meta` is what a transform
   author wants alongside per-item shaping — land as a NEW field
   (`transformPage?: boolean`), never by changing what `transform` receives
   on paginate ops: that is a behavior-level re-meaning of an existing field
   that every paginating guide with a transform can never take back cheaply.

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

## P1-6. Reserved seam — local-helper return contract (magic-wrapper trap)

- **Pattern:** the escape-valve doc anticipates helper upgrades ("break
  freely to generalize"); the foreseeable one is a helper that also needs to
  set **request headers** (per-op `Accept-Version`, required X-headers) or
  tweak the **path** pre-call. No single named API required — the freeze
  exists so the fix shape stays additive whenever the first one arrives.
- **Gap:** `HelperFn` returns the params record itself (`local-helpers.ts`;
  the escape-valve doc pins `(params, ctx) => params`). The lazy future fix —
  treating a returned object that happens to contain reserved wrapper keys
  (`{ params, headers, path }`) as a structured result — **re-means a
  legitimate params record** whose query params are literally named
  `params`, `headers`, or `path`. Same magic-value class as the
  `nextLinkPath: "header:Link"` overload P1-2 exists to prevent.
- **Classification: P1 freeze, doc-only.** No code, no schema field — a
  commitment, same class as P1-3.
- **Frozen shape:** reserved-seam note in `local-helpers.ts` next to the
  contract block + the escape-valve doc: *"The default export's return stays
  the params record. Richer pre-call control (headers, path rewrite) lands
  as a NEW named export (e.g. `buildRequest`) or a new op field — never by
  overloading the default export's return shape with reserved wrapper
  keys."*
- **Confidence:** high on the trap mechanics (contract read directly); the
  first demand's timing is unknowable — which is exactly why it's a freeze,
  not a build.

---

# P2 — Additive backlog (safe anytime, ordered by expected recipe pain)

## P2-1. Paginated non-JSON formats (`csv` / `ndjson` in `ResponseFormat`)

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

## P2-2. `dateParams` extensions (epoch, epoch-millis, yyyy/mm/dd)

- **Pattern:** StackExchange dates are unix epoch seconds
  (`fromdate=1293840000`, <https://api.stackexchange.com/docs/dates>); PubMed
  E-utilities `mindate/maxdate` accept `YYYY/MM/DD` (live-verified) —
  <https://eutilities.github.io/site/Reference_Guide/a_reference/>
- **Gap:** `DateParamFormat = "iso8601" | "yyyymmdd" | "yyyy-mm-dd"`; epoch
  integers pass through unchanged only by accident of the regex failing.
- **Fix:** add `"epoch"`, `"epoch-millis"`, `"yyyy/mm/dd"` — enum extension =
  non-event. Convenience only (the agent can always pre-format).

## P2-3. Deep-paging guardrail (`pagination.maxOffset`)

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

## P2-4. `SecretRef.derive?: "base64"` (basic-auth provisioning friction)

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

## P2-5. OAuth2 grant coverage (device_code, ROPC, JWT assertions) — deferred

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

## P2-6. `listStyle` enum gaps — `semicolon` and `pipe`

- **Pattern:** StackExchange `tagged` is semicolon-delimited with no comma
  fallback (live-checked: `tagged=java,python` → `total: 0`) —
  <https://api.stackexchange.com/docs/questions>. Stronger adjacent case:
  MediaWiki Action API list params are **pipe**-exclusive
  (`siprop=general|namespaces|…`, no comma form) — and MediaWiki/Wikidata is
  squarely in the corpus (`wikidata-search` axis fixture) —
  <https://en.wikipedia.org/w/api.php?action=help&modules=query+siteinfo>.
- **Gap:** `LIST_STYLES = [comma, repeat, bracket]`; the prior operations
  lane proposed `semicolon` and it silently didn't land in the
  implementation.
- **Classification:** additive convenience (agents can pre-join `;`/`|`;
  undeclared values pass through raw) — enum extension is a non-event.
- **Fix shape:** add the enum values when a recipe needs them.

## P2-7. Verified fine — cleared, no action (recorded to close the review)

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
- **OAuth2 Bearer + second credential on one endpoint (Etsy-shaped):** Etsy
  v3 requires `x-api-key: <keystring>:<secret>` AND `Authorization: Bearer`
  simultaneously on scoped read GETs — expressible today via oauth2
  `secretRefs` (the store holds the composite; the scrub still works).
  <https://developers.etsy.com/documentation/essentials/authentication/>
  No prominent read API was found requiring Bearer **plus a query-param or
  path-token** credential (Amadeus refuted — key/secret are exchanged once
  for the token, nothing rides the calls:
  <https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/API-Keys/authorization/>).
  If one ever appears, the fix is adding `secretQueryRefs` /
  `secretPathRefs` / literal `headers` to the `OAuth2Auth` allowlist — an
  allowlist addition, a non-event, not a SecretRef reshape. Recorded so it
  isn't re-derived.
- **Out-of-bounds (noted, dropped):** POST-based pagination (GitHub GraphQL),
  cookie-jar sessions (deferred by design), params in HTTP headers on GET
  (EIA's URL form works), cursor echo in a request *header* (additive
  `cursorLocation` only if a real recipe demands it), `+` vs `%20` encoding
  (no documented read-API breakage; `encoding?: "percent"` escape exists),
  in-schema numeric min/max validation (forever behavioral; description hints
  cover it).

---

# Completed — removed from the backlog

- **Closed-schema pass** — `OP_ALLOWLIST` / `GUIDE_ALLOWLIST` /
  `RESPONSE_SHAPE_ALLOWLIST` in `core/parse-api-guide.ts` reject unknown keys
  on op blocks, frontmatter, and `responseShape`; dead `dateParams` path-token
  declarations and `secretQueryRefs` ↔ pagination-wire-name collisions are
  parse errors too.
- **Pagination allowlists** — `PAGINATION_ALLOWLISTS` in
  `core/parse-api-guide.ts` rejects unknown pagination keys per style.
- **Dot-containing JSON keys** — quoted bracket segments (`['@odata.nextLink']`)
  are atomic keys in `resolveJsonPath`.
- **Path-secret auth** — `secretPathRefs` (`core/auth.ts`): store-filled path
  tokens, redacted URLs, cache/auth gating; `telegram-bot` axis guide.
- **Negative-index cursors + `hasMorePath`** — `data[-1].id` resolves;
  `hasMorePath` stop-condition; `stripe` axis guide.
- **Numeric cursor coercion** — `advancePagination` coerces numeric
  cursors instead of treating them as exhaustion.
- **Multi-value query params** — `listStyle` (`comma` / `repeat` /
  `bracket`) on `QueryParamSpec`.
- **200-with-error envelopes** — op-level `errorPath` via the shared
  `checkErrorEnvelope` in both executors; `dnb` axis guide.
- **ETag cache visibility** — `fresh` param on `api-fetch`, `cached`
  footer note, explicit-server-grant-only caching in `core/transport.ts`.

---

## Downstream doc note

Each P1/P2 item above is written to be self-seeding for a downstream doc:
it carries the pattern, gap, fix shape, tests, and API evidence needed to
elaborate it (with full caritas recipes and per-doc sprints) without
re-reading the lane reports. Items that must land together are paired inline
(P2-4's conclusion feeds P1-1's seam). The verified-fine list (P2-7) and
out-of-bounds drops belong in the authoring-reference doc, not a fix doc.
