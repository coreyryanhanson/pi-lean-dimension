# Research: Adversarial schema review — pi-lean-host RESPONSE SHAPES & TRANSFORMS axis

## Summary

The v1 response-shape surface (ResponseShape {format: json|xml|text, charset}, per-op `parse`, `transform: true`, local helper, ETag cache, itemsPath extraction) is mostly sound: I found **no finding where the only natural fix is a breaking YAML-shape or TS-type change**, and the two genuinely inexpressible real-world patterns (dot-containing keys in pagination paths; paginated non-JSON formats) both have clean additive fixes. The critical discovery: `resolveJsonPath` is dot-splitting, which **silently breaks Microsoft Graph / OData v4** (`@odata.nextLink`, `@odata.count`) — the schema should (a) additively bless a quoted-bracket escape syntax NOW and (b) freeze the implicit path/XML contracts (`@_`, `#text`, removeNSPrefix, boxing) as documented schema behavior before guides accrete around them.

Grounding: all file/line claims below are against `core/helpers.ts` (`resolveJsonPath` ~line 247, `parseResponse` ~line 320, `paginate` ~line 560), `core/parse-api-guide.ts` (`validateResponseShape` ~line 497), `core/transport.ts`, `core/api-guide-types.ts`, `tools/api-fetch.ts`.

---

## Findings (ranked: inexpressible-today first, then footguns, then expressible confirmations)

### 1. Dot-containing JSON keys break EVERY path field — Microsoft Graph/OData v4 pagination is provably inexpressible

**Classification: ADDITIVE-FIX (highest priority on this axis; provably inexpressible today, and the additive window must be used before guides accrete).**

1. **PATTERN**: OData v4 services (Microsoft Graph — one of the largest API surfaces on earth — plus SharePoint REST, Dynamics 365, SAP OData) paginate via a literal top-level key `@odata.nextLink` and expose totals via `@odata.count` (`{"@odata.context":"…","value":[…],"@odata.nextLink":"https://graph.microsoft.com/v1.0/users?$skiptoken=…"}`). Guide authoring would require `nextLinkPath: "@odata.nextLink"` / `totalCountPath: "@odata.count"`.
2. **GAP**: `resolveJsonPath` (helpers.ts) normalizes with `path.replace(/\[(\d+)\]/g, ".$1")` then `normalised.split(".")`. `@odata.nextLink` → parts `["@odata","nextLink"]` → looks up `data["@odata"]` → `undefined`. The bracket-quote regex `\[['"](.*?)['"]\]` makes it worse, not better: `['@odata.nextLink']` is rewritten to `.@odata.nextLink` and then dot-split — the escape hatch silently degrades into the same bug. `advancePagination("nextLink")` gets `undefined` → returns `null` → **gatherAll silently terminates after page 1 with no error**. Same failure hits `itemsPath`, `cursorPath`, `tokenPath`, `totalCountPath` for any dotted key. No workaround exists: the local helper is pre-call params only, and `transform` runs post-parse (it never sees pagination advance, which reads raw page data).
3. **PROPOSED DELTA (non-breaking per the bump rule)**: make `resolveJsonPath` treat quoted bracket segments as atomic keys — after the existing normalizations, re-tokenize with a regex that captures `['…']` segments (including dots) before dot-splitting. Old unbracketed paths parse identically; YAML unchanged; add one unit test proving `['@odata.nextLink']` resolves and `@odata.nextLink` (unquoted) keeps failing loudly. Then document the escape in the guide-authoring docs so caritas recipes for Graph are written correctly the first time.
4. **CONFIDENCE: HIGH.** Code inspection proves the miss; the API pattern is canonical. [Microsoft Graph paging](https://learn.microsoft.com/en-us/graph/paging) ("returns an `@odata.nextLink` property in the response"); OData v4 protocol `@odata.count`/`@odata.nextLink` instance annotations.

### 2. Paginated non-JSON responses (CSV / any flat-text paging) cannot be expressed at all

**Classification: ADDITIVE-FIX (medium priority).**

1. **PATTERN**: Socrata SODA — thousands of open-government datasets — serves the same resource as JSON or CSV (`Accept: text/csv` or `resource/xyz.csv`), paginated with `$limit`/`$offset` (SODA 2.x). CSV export is a first-class consumer format in the SODA docs. Similar: any line-oriented export endpoint fetched with paging params.
2. **GAP**: `format: text` returns the body as a raw string (helpers.ts `parseResponse`), and `paginate` then calls `resolveJsonPath(data, itemsPath)` on a *string* → `undefined` → immediate silent break with **0 items and no error**. There is no CSV/TSV delimiter or ndjson awareness anywhere in the schema (`VALID_FORMAT = json|xml|text` in parse-api-guide.ts; `ResponseFormat` in api-guide-types.ts).
3. **PROPOSED DELTA (additive)**: add `format: "csv"` (and optionally `"ndjson"`) to `ResponseFormat` with body-is-the-array semantics (CSV: header row → `Record<string,string>[]`; ndjson: one JSON object per line). No existing guide is affected; no field is re-meaned. Note that Socrata CSV with `$limit/$offset` then works as a plain `offset-limit` op with no `itemsPath`-worth-anything problem (items are the top-level array; `$`/empty path already resolves to the body itself — see finding 9).
4. **CONFIDENCE: HIGH** for the inexpressibility (code-proven); the pattern is common in gov data. [Socrata CSV format](https://dev.socrata.com/docs/formats/csv) (CSV is a standard SODA response format; paging via `$limit`/`$offset`).

### 3. 200-with-error-envelope APIs: silent 0-items in `paginate`, no declared error path

**Classification: ADDITIVE-FIX.**

1. **PATTERN**: APIs that report errors inside a 200 body: OAI-PMH providers return HTTP 200 with `<OAI-PMH><error code="noRecordsMatch">…</error></OAI-PMH>`; Google-style envelopes (`status: "ZERO_RESULTS"`); Flickr (`stat: "fail"`); Crossref-style wrappers where "empty" and "malformed" look identical once itemsPath misses.
2. **GAP**: `checkResponseStatus` only inspects the HTTP status (helpers.ts), and `paginate` treats an unresolvable `itemsPath` exactly like an exhausted feed (`break` → success with 0 items, `urls.length === 1`). There is no schema field to declare "presence of `error.code` (or `status != ok`) means error" and no way to distinguish "genuinely empty result" from "itemsPath typo / error envelope". The agent *can* see the envelope via a `restGet` op, but a `gatherAll` paginate run reports success-empty, which is a lie for the OAI-PMH error case.
3. **PROPOSED DELTA (additive)**: optional per-pagination/op `errorPath` (path whose *presence* fails the page with a structured error) and/or an `emptyIsError: true` flag that turns a first-page zero-item result into a warning instead of a clean termination. New optional fields; zero impact on existing guides.
4. **CONFIDENCE: MEDIUM-HIGH.** OAI-PMH error-conditions-in-200 is normative: [OAI-PMH 2.0 §3.6](https://www.openarchives.org/OAI/2.0/openarchivesprotocol.htm).

### 4. The ETag cache is invisible to the agent in a mildly harmful way (transport behavior, not guide schema)

**Classification: ADDITIVE-FIX (tool surface, not schema; no breaking risk).**

1. **PATTERN**: The schema has no freshness story: `api-fetch`'s tool params (tools/api-fetch.ts) expose only `domain/operation/params/gatherAll` — there is **no `fresh` param**, and `RestGetResult` doesn't carry the transport's `cached` flag, so `fetchUrl`'s careful `cached: true` bookkeeping is dropped at the result boundary.
2. **GAP/FOOTGUN**: `transport.ts` caches every 2xx for `Cache-Control: max-age` **or a 60s `DEFAULT_TTL_MS` fallback — even when the server sent no cache headers at all** — and revalidates with `If-None-Match`. Auth-bearing requests opt out, but plain public GETs silently serve ≤60s-stale bodies that render identically to live ones. For a research-agent tool re-checking a volatile endpoint, the agent cannot tell cached from live and cannot force freshness.
3. **PROPOSED DELTA (additive)**: (a) optional `fresh?: boolean` on api-fetch → `ResolveOpOptions.fresh` → executors (the plumbing already exists end-to-end, it's just never set from the tool layer); (b) surface `cached: true` as a footer note on results; (c) consider caching only when the server sent explicit cache headers (absence of Cache-Control → no-store is the conservative read-only-client default).
4. **CONFIDENCE: HIGH** on behavior (direct code reading); the *harm* is real but bounded at 60s.

### 5. XML: the mode works for real feeds, but three implicit contracts are load-bearing and undocumented

**Classification: EXPRESSIBLE-TODAY (pin the contract now — free), with behavior-level footguns noted.**

Verified against a live arXiv Atom response (`http://export.arxiv.org/api/query?search_query=all:electron&max_results=1` — namespaced Atom + `opensearch:totalResults` attr `totalResults="185684"`) and the configured `XMLParser` (helpers.ts):

1. **Namespaces**: `removeNSPrefix: true` strips prefixes, so `itemsPath: "feed.entry"` and `totalCountPath: "feed.totalResults"` work across Atom/OAI-PMH/Sitemap. **Contract to pin:** `@_` attribute prefix, `#text` text-node name, and prefix-stripping are de-facto schema behavior — every XML guide's paths encode them. A future "better XML mode" (preserveOrder, namespace-aware keys, different prefixes) would retro-break every XML recipe. **Free now:** document `@_`/`#text`/NS-stripping in the guide-authoring reference and add a contract test asserting the exact parsed shape of a canonical Atom sample. [fast-xml-parser options](https://github.com/NaturalIntelligence/fast-xml-parser/blob/master/docs/v4%2C%20v5/2.XMLparseOptions.md).
2. **Single-entry boxing asymmetry**: `paginate` boxes a lone XML record into an array (explicit arXiv/PubMed accommodation), but `restGet` returns the raw parsed object — the *same endpoint* yields `entry` (object) via restGet and `[entry]` via paginate. An agent tolerates it; caritas authors should not rely on either. Documentation note, not schema.
3. **Value coercion**: `parseAttributeValue: true` (+ FXP's default `parseTagValue`) turns `id="007"` into `7` and can mangle date-like/zero-padded attribute values. No current axis guide is harmed; turning coercion off later changes parsed output (numbers→strings) but never makes a guide fail to *parse* — behavior-level, no schema bump. If a real recipe hits corruption, flip the flags and note it in CHANGELOG.

**CONFIDENCE: HIGH** — live-fetched Atom proves the shape; OAI-PMH's `resumptionToken` self-closing → `""` → clean terminate also verified by code path.

### 6. JSON envelope responses (meta + items): fully expressible; the transform escape valve multiplexes per-op

**Classification: EXPRESSIBLE-TODAY. Not a finding — recorded to close the axis question.**

- Whole-envelope access: `restGet` returns the entire parsed body — OpenAlex `{meta, results}` / Crossref `{status, message: {total-results, items}}` are returned intact. [Live OpenAlex fetch](https://api.openalex.org/works?per-page=1) confirms the envelope.
- Deep items nesting: `itemsPath` is a plain dot path, so `hits.hits` (Elasticsearch), `message.items` (Crossref — live-verified), `query.recentchanges` (MediaWiki — proven in the shipped wikimedia-action guide), and `rows` (BigQuery tabledata.list) all resolve. Two-level nesting is not a limit; the real limit is finding 1's dot-in-key case.
- Per-op transform dispatch: one transform export per domain (v1 contract) is *not* a bottleneck — `transformFn(data, ctx)` receives `ctx.operation`, so a single `transform` export can branch per op. Same for `helper: true` (callHelper receives op.name).
- Content negotiation (`?alt=json|csv`, Accept-driven): two sibling ops with per-op `parse` overrides express it; the transport cache keys on Accept (transport.ts `cacheKey`), so negotiated variants don't collide.

### 7. Per-page shape drift, envelope-vs-items in paginate, response-spill: non-findings

**Classification: EXPRESSIBLE-TODAY (recorded to close the axis).**

- **Shape differs per page** (first page has extra envelope fields): searched for a concrete public API that changes envelope structure between first and later pages and found none in the target corpus (OpenAlex, Crossref, Graph, Stripe, BigQuery all keep the envelope constant). The executor's behavior on later-page path misses (`resolveJsonPath` → undefined → style's advance returns null → stop) degrades gracefully. No schema change warranted; revisit only if a real provider surfaces.
- **Agent wants meta + items from a paginate op**: `totalCountPath` covers the common need (`serverTotal`); anything richer → declare a parallel `restGet` op. Additive upgrade (`envelopePages`-style flag) exists if ever needed; not now.
- **Truncation/spill**: response-spill (8 files/session, evict-oldest, `cleanupAllSpill` on shutdown) and the 10MB transport ceiling are adequate for read-only research use.
- **Gzip**: the transport sends no `Accept-Encoding`, and undici `request` is used without a decompression interceptor — servers conforming to HTTP return identity. Only a server that force-gzips regardless would corrupt; no major target API does. No action.

### 8. NDJSON / line-delimited responses

**Classification: ADDITIVE-FIX (low priority, weak evidence).**

1. **PATTERN**: `application/x-ndjson` responses (mostly streaming/push endpoints — Twitter/X filtered stream is a persistent stream, not a request/response GET; BigQuery's REST read path is envelope JSON, not ndjson).
2. **GAP**: today `format: text` returns the raw string — the agent can split it itself in a restGet context; paginate is impossible (same as finding 2). I could not find a common *plain-GET, page-based* public API that returns ndjson, so this is only worth folding into the `format` enum when a real recipe needs it (see delta in finding 2). Evidence: [NDJSON media type registration](https://jsonl.co/guide/ndjson-complete-guide).

### 9. Top-level-array JSON bodies (Socrata `/resource/xyz.json`, Trello lists): expressible via a `$` idiom — document it

**Classification: EXPRESSIBLE-TODAY (footgun-adjacent).**

`resolveJsonPath` with an empty-part path returns the body itself, and the parser requires `itemsPath` to be a non-empty string — so `itemsPath: "$"` (or `"."`) is the working idiom for "body IS the array". This is load-bearing and undiscoverable; **free fix**: one line in the authoring docs (and a test) so authors don't guess. [Socrata JSON format](https://dev.socrata.com/docs/formats/json) ("the response will be a JSON array, where each element is a result").

---

## Sources

**Kept:**
- Microsoft Graph paging (https://learn.microsoft.com/en-us/graph/paging) — proves `@odata.nextLink` dotted-key pagination, the basis of finding 1.
- `resolveJsonPath` / `parseResponse` / `paginate` in `core/helpers.ts`; `validateResponseShape` in `core/parse-api-guide.ts`; `core/transport.ts`; `tools/api-fetch.ts` — primary evidence for every GAP claim (read in full).
- Socrata CSV format (https://dev.socrata.com/docs/formats/csv) + JSON format (https://dev.socrata.com/docs/formats/json) — top-level-array JSON and CSV response formats on a major gov-data platform (finding 2, 9).
- OAI-PMH 2.0 spec (https://www.openarchives.org/OAI/2.0/openarchivesprotocol.htm) — 200-with-`<error>` responses and empty-`resumptionToken` semantics (findings 3, 5).
- Live arXiv Atom fetch (http://export.arxiv.org/api/query?search_query=all:electron&max_results=1) — namespaced Atom with namespaced totalResults, verifying XML-mode capability claims (finding 5).
- fast-xml-parser options doc (https://github.com/NaturalIntelligence/fast-xml-parser/blob/master/docs/v4%2C%20v5/2.XMLparseOptions.md) — pins `@_`/`removeNSPrefix` contract semantics (finding 5).
- OpenAlex paging (https://help.openalex.org/api/paging/) + live `api.openalex.org/works?per-page=1` fetch — stable `{meta, results}`/`{meta, group_by}` envelopes, `next_cursor` (findings 6, 7).
- Live Crossref fetch (https://api.crossref.org/works?rows=1) — nested `message.items` / `message.total-results` envelope proof (finding 6).
- BigQuery tabledata.list (https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list) — deep `rows[].f[].v` nesting + JSON envelope (finding 6).

**Dropped:**
- Twitter/X filtered-stream docs (streaming push protocol — not a request/response GET; out of scope for a GET-only transport; only fed the low-confidence ndjson note).
- Socrata SODA3 `/query` POST docs (https://dev.socrata.com/docs/queries/) — POST-only query API, out of bounds under GET-only transport.
- JSON:API spec (https://jsonapi.org/format/1.1/) — envelope handled by finding 6's reasoning; no additional gap beyond it.
- Stack Overflow / blog posts on fast-xml-parser array pitfalls — superseded by direct code inspection of the configured parser.
- GitHub pagination docs (Link-header based) — GitHub's envelope has no dotted keys; adds nothing beyond findings 6/9.

## Gaps

- **No live OData v4 probe was executed** (Microsoft Graph needs auth for most listing endpoints); finding 1 rests on the documented `@odata.nextLink` shape plus code-proven path resolution. A 10-minute live check against any public OData endpoint (e.g. an SAP Gateway demo service) would close it empirically.
- **strnum edge behavior** of fast-xml-parser (`parseAttributeValue`/`parseTagValue` on zero-padded numeric strings like `"01234"`) was reasoned about, not empirically pinned. If any real recipe carries numeric-string IDs in XML attributes, run a one-off FXP probe before trusting values.
- I did not exhaustively survey every OAI-PMH provider's dialect (some emit `completeListSize` as an attribute vs. element) — finding 5's contract-pinning recommendation covers the variance cheaply.

## Supervisor coordination

No decision or approval was needed; research completed without blocking. Full report returned above and persisted to `/tmp/oracle-response.md`.
