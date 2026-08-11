# API Helper Escape-Valve Policy

> Classifies every quirk class the 15 no-auth bundled recipes surface as
> **built-in** (realized in the reviewed helper set, every recipe gets it) vs
> **local-helper** (per-API, user-authored, ships as an accompanying
> `helper.ts` in the domain subdir). Rationale per decision. The recipe
> spread and the rejected-candidates list at the end of this doc are the
> evidence; no two recipes cover the same helper decision.

## How to read this document

Each section names a quirk class, states its classification
(built-in / local-helper), gives the rationale, and lists the recipes
that exercise it.

## Classification

### 1. Pagination styles

| Style | Classification | Rationale | Recipes exercising it |
|-------|---------------|-----------|----------------------|
| `offset-limit` | **built-in** | Universal baseline — every open-data API offers it. | BOE (boe.es), MusicBrainz (musicbrainz.org), DNB (services.dnb.de), Open Library (openlibrary.org), GBIF (api.gbif.org), GitHub (api.github.com) |
| `nextLink` | **built-in** | Server-supplied next URL is the second most common pattern. One code path (`advancePagination`) with SSRF guard. | LoC (loc.gov), datos.gob.es, Federal Register (<www.federalregister.gov>) |
| `cursor` | **built-in** | Opaque cursor string is common in search APIs. One code path. | Data.gov (resources.data.gov) |
| `page` | **built-in** | Incrementing page number with fixed size; simple variant of offset-limit. | (no recipe uses it yet — code supports it) |
| `resumptionToken` | **built-in** | OAI-PMH opaque single-token cursor: echo the token from each page into a named query param on the next request. Reuses `resolveJsonPath` + the existing per-page param loop. | DNB (services.dnb.de — `oaiListRecords`, `oaiListIdentifiers`) |
| `tokenBag` | **built-in** | Multi-key continuation bag (Wikimedia `continue` dict): read a declared set of response keys and merge them into the next request's query params under the same names. Reuses `resolveJsonPath` per key. | Wikimedia Action API (en.wikipedia.org-action — `listRecentChanges`) |

### 2. Response formats

| Format | Classification | Rationale | Recipes |
|--------|---------------|-----------|---------|
| JSON (`application/json`) | **built-in** | Most common format. `JSON.parse` in `parseResponse`. | All recipes |
| XML (`application/xml`, `text/xml`) | **built-in** | `fast-xml-parser` in `parseResponse`. Requires `responseShape.format: xml` and an XML-capable `accept`. | DNB (services.dnb.de), MusicBrainz XML op (musicbrainz.org), BOE getConsolidada (boe.es) |

**Known gap — single-record XML edge:** When an XML response returns exactly
one record, `fast-xml-parser` yields an object instead of an array.
`resolveJsonPath` then sees a non-array and stops pagination. This is a
`parseResponse` generalization target that remains **local-helper** for now
— no bundled recipe was found where the XML endpoint ever returns a
single-record page with a broad-enough query. If a real API forces this
edge in practice, it should be upgraded to **built-in** with array-normalization
in `parseResponse`.

### 3. Character sets / charset decoding

| Charset | Classification | Rationale | Recipes |
|---------|---------------|-----------|---------|
| UTF-8 | **built-in** | Default in transport. `TextDecoder` with `utf-8` fallback. | All recipes |
| Any IANA charset | **built-in** | `TextDecoder` supports all standard IANA charsets. Transport uses the recipe's `charset` as a fallback when the Content-Type header omits one; an explicit header charset wins. | (no recipe exercises a non-UTF-8 charset — see note) |

**Note:** No bundled recipe was found whose API returns a non-UTF-8 charset
while being no-auth, CI-reachable, and permissively licensed. The `charset`
field in `ResponseShape` exists in the schema and the transport layer
honors it. Any non-UTF-8 API is a **local-helper** (add `responseShape.charset`
to the guide) — the transport will decode it. A non-UTF-8 charset with a
charset name `TextDecoder` doesn't recognise falls back to UTF-8.

### 4. Content negotiation (Accept header)

| Mechanism | Classification | Rationale | Recipes |
|-----------|---------------|-----------|---------|
| Accept header (`json`/`xml` shorthand) | **built-in** | `restGet`/`paginate` map `accept: json` → `application/json`, `accept: xml` → `application/xml`. | All recipes |
| Free-form media type string | **built-in** | `AcceptType` is a `string`; any IANA media type passes through verbatim (`json`/`xml` shorthands still map to the full media types). | (escape valve, no recipe needs it yet) |
| Query-param content negotiation (`?fmt=json`) | **local-helper** | When the format selector is a query param (not the Accept header), the guide documents the default value and the caller supplies it via `params`. Not a helper responsibility — it's just a query param with a default. | LoC `fo=json` (loc.gov), MusicBrainz `fmt=json\|xml` (musicbrainz.org) |

### 5. Authentication / header injection

| Auth pattern | Classification | Rationale | Recipes |
|--------------|---------------|-----------|---------|
| `auth.kind: none` | **built-in** | No auth needed. | Most recipes |
| `auth.headers` (extra headers with `kind: none`) | **built-in** | Used for free dev keys like `X-Api-Key: DEMO_KEY` where no registration is needed. Headers are merged into every request by `fetchWithOpts`. | Data.gov (resources.data.gov) |
| Real keyed auth (`static-key`, `oauth2`) | **out of scope** (future keyed-auth track) | Requires secrets store, keyed dispatch. | None |
| `User-Agent` / `Api-User-Agent` etiquette | **local-helper** | The v1 helper contract transforms params, not headers. A transport-level UA policy (like MusicBrainz's requirement or Wikipedia's etiquette) cannot be expressed in a guide. If a real API blocks missing UA, the user sets it in the transport config or adds a custom UA header via `auth.headers`. | MusicBrainz (musicbrainz.org — documented UA requirement), Wikipedia (en.wikipedia.org — `Api-User-Agent` etiquette) |

**Note:** `auth.headers` is a general seam:
any extra headers a recipe needs can be declared there without promoting the
auth kind to `static-key`. This covers the `DEMO_KEY` pattern and any future
pre-shared header without keyed-auth complexity.

### 6. Pagination edge signals

| Signal | Classification | Rationale | Recipes |
|--------|---------------|-----------|---------|
| Empty items array → stop | **built-in** | `paginate` breaks when `pageItems` is empty. | All paginated recipes |
| Non-array items path → stop | **built-in** | `paginate` breaks when `resolveJsonPath` returns a non-array. | All paginated recipes (also catches the single-record XML edge above) |
| `endOfRecords: true` boolean | **local-helper** | Only one recipe needed this (GBIF). Not common enough for a built-in pagination style. Recipe documents the termination signal in the guide prose; no helper needed for the list op. | GBIF (api.gbif.org) |
| `total_pages` / `count` ceiling | **built-in** (server total) / **local-helper** (stop signal) | The framework's `totalCountPath` (any pagination style) surfaces the server's reported total — `count` / `total_count` / `numFound` / `completeListSize` / `search.hits` — as `serverTotal` in the `paginate` result and in the `api-fetch` footer (`server total: N`, `remaining: …`), no helper needed. What stays **local-helper** is using such a field as the *termination* signal instead of an empty-items / next-link break — the paginator still stops on an empty page or absent next cursor, so a guide that wants a count-bounded stop declares the path only for surfacing, not for loop control. | Federal Register (<www.federalregister.gov> — `count`/`total_pages` surfacable via `totalCountPath`), GitHub (`total_count` on `/search/*`), Open Library (`numFound`), GBIF (`count`), LoC (`search.hits`), Archive.org (`response.numFound`), DNB (`@_completeListSize` via OAI resumption token) |
| `Link` header pagination (RFC 5988) | **local-helper** | The only recipe with header-based pagination is GitHub. A helper that parses `Link` headers must inspect the response, which neither helper valve can do: the pre-call `default export` runs before the request and only reshapes params; the post-response `transform` named export (§12) sees the parsed body but not headers. Promoting this to built-in would require a header-aware pagination style. Deferred. | GitHub (api.github.com) |
| Continue-token bag (Wikimedia `continue` dict) | **built-in** (as `tokenBag`) | Two independent recipes (Wikimedia Action API `continue` dict, OAI-PMH `resumptionToken`) share the cursor-like-but-multi-key / opaque-string shape. The `tokenBag` style reads a declared set of response keys and merges them into the next request's params; `resumptionToken` echoes one opaque string into a named param. | Wikimedia Action API (en.wikipedia.org-action), DNB (services.dnb.de) |

### 7. Rate-limit signaling

| Signal | Classification | Rationale | Recipes |
|--------|---------------|-----------|---------|
| HTTP 429 with retry-after | **built-in** | Transport retries with exponential backoff + `Retry-After` support. | (exercised by any rate-limited API) |
| `X-RateLimit-*` headers | **local-helper** | Informational only — the transport doesn't parse them. The agent reads them from response headers. No structural change needed. | GitHub (api.github.com), MusicBrainz (musicbrainz.org) |

### 8. Caching / conditional requests

| Mechanism | Classification | Rationale | Recipes |
|-----------|---------------|-----------|---------|
| `Cache-Control: max-age` TTL | **built-in** | Transport caches with TTL from `max-age`. | All recipes (transport level) |
| ETag / `If-None-Match` → 304 | **built-in** | Transport caches ETags and sends conditional requests. | Wikipedia (en.wikipedia.org — axis D), LoC (loc.gov — incidental) |
| `Expires` header | **built-in** | Transport falls back to `DEFAULT_TTL_MS` when no `Cache-Control` or `max-age` is present. | (edge case, transport-level) |

### 9. Response shape / envelope extraction

| Shape | Classification | Rationale | Recipes |
|-------|---------------|-----------|---------|
| Flat envelope (`{data: [...]}`) | **built-in** | `resolveJsonPath` with `itemsPath` extracts the array. | BOE (boe.es) |
| Nested envelope (`{result: {items: [...]}}`) | **built-in** | Dot-delimited `itemsPath: result.items` works. | datos.gob.es |
| Non-flat items (deeply structured) | **built-in** | Items are passed through as parsed. No flat assumption. | Data.gov (resources.data.gov) |
| GeoJSON `FeatureCollection` | **built-in** | `itemsPath: features` works. Geometry is positional — items are the full feature objects. | USGS (earthquake.usgs.gov) |
| JSON-LD / linked-data | **built-in** | Parsed as regular JSON. `itemsPath` + `nextLinkPath` work on the converted object. | datos.gob.es |
| Language-keyed dict (`entities.{id}.labels.{lang}`) | **local-helper** | Not a list operation. The non-list op fetches a single entity by ID; the helper maps the response structure. | Wikidata (<www.wikidata.org>) |
| Mixed field naming (`numFound` + `num_found` aliased) | **built-in** | `resolveJsonPath` on whichever path the guide declares. The recipe picks one. | Open Library (openlibrary.org) |
| Single-resource / no pagination | **built-in** | `via: restGet` handles single-resource fetches. | Internet Archive (archive.org), Wikidata (<www.wikidata.org>), Wikipedia page summary (en.wikipedia.org) |

### 10. Date/time transforms

| Transform | Classification | Rationale | Recipes |
|-----------|---------------|-----------|---------|
| Declarable date-format normalization (ISO → `yyyymmdd` / `yyyy-mm-dd` / `iso8601`) | **built-in** | A core `dateParams: Record<param, format>` field on `Operation` normalizes dates inside `buildQueryParams` — the single seam both `restGet` and `paginate` route through. Covers the common case (query params whose target format is one of three known shapes). | BOE (boe.es — `from`/`to`), GitHub (`api.github.com` — `since`/`until` when added) |
| Per-API date transform that can't be declared | **local-helper** | Path-param dates (core `dateParams` only touches query params), non-standard formats, and transforms needing context the guide can't express remain in `helper.ts`. BOE's `fecha` path param is the live example. | BOE (boe.es — `toBoeDate` for the `fecha` path param) |
| Any per-API date transform | **local-helper** | By definition per-API. The `helper.ts` alongside the guide implements it. | Any recipe carrying a helper |

### 11. Query DSL / parameter transforms

| Transform | Classification | Rationale | Recipes |
|-----------|---------------|-----------|---------|
| Plain string → JSON query DSL | **local-helper** | Per-API. BOE requires `{"query":{"query_string":{"query":"texto:<term>"}}}`. The helper wraps it. | BOE (boe.es — `toBoeQuery` in helper.ts) |
| Any per-API param transform | **local-helper** | By definition per-API. The helper contract handles this. | Any recipe carrying a helper |

### 12. Local helper contract

| Aspect | Classification | Rationale |
|--------|---------------|-----------|
| Signature `(params, ctx) => params` | **built-in** | The contract is defined and stable. |
| Pre-call transform only | **built-in** | The helper runs before URL construction. It cannot inspect response headers or body. |
| Async support | **built-in** | `callHelper` awaits the result; helpers may be sync or async. |
| One helper per guide | **built-in** | A guide subdir contains at most one `helper.ts` (a domain may have multiple guide subdirs). |
| Post-response transform (named `transform` export) | **built-in** | A gated per-operation `transform: true` field lets a guide's `helper.ts` export a named `transform(data, ctx)` that shapes the parsed response after `restGet`/`paginate` and before the result is returned. Graceful by contract: a throw is caught per-call — the agent gets a warning and the raw untransformed data, never a disabled op (`paginate` routes failed items to a `failedItems` group; no item dropped). Cannot inspect response headers, only the parsed body. Separate from the pre-call `default export`; the pre-call-only contract above is unchanged. |

**Out of scope:** Per-parameter helper binding, shared/cross-domain helpers.
(Response-aware post-call transforms were previously listed here; they have
been promoted to built-in via the gated `transform` valve — see the table
row above.)

## Summary: built-in vs local-helper

| Class | Count | Built-in | Local-helper |
|-------|-------|----------|-------------|
| Pagination styles | 7 | offset-limit, nextLink, cursor, page, resumptionToken, tokenBag | header (Link) |
| Response formats | 2 | JSON, XML | (none — single-record XML edge pending) |
| Charsets | 3 | UTF-8, auto, any IANA | (none) |
| Content negotiation | 3 | Accept header shorthands, free-form media types | Query-param content negotiation (just defaults) |
| Auth | 3 | none, none+headers, real keyed (future) | User-Agent policy |
| Pagination signals | 5 | empty/non-array stop, continue-token bag (tokenBag), server-total surfacing (`totalCountPath`) | endOfRecords bool, total_pages as stop signal, Link header |
| Rate-limit | 2 | 429 retry | X-RateLimit-* headers (informational) |
| Caching | 3 | Cache-Control TTL, ETag/304, Expires | (none) |
| Response shapes | 8 | flat, nested, non-flat items, GeoJSON, JSON-LD, single-resource, mixed naming | Language-keyed dict |
| Data transforms | 3 | declarable date normalization (dateParams) | per-API date transforms (path params, non-standard), query DSL wraps |
| Helper contract | 5 | sig (params,ctx)=>params, pre-call, async, one-per-guide, post-response transform (gated) | per-param binding |

**Total:** ~35 quirk classes classified. 32 built-in, 6 local-helper.

## When to upgrade a local-helper quirk to built-in

A quirk classified **local-helper** should be considered for promotion to
**built-in** when:

1. A second independent API exhibits the same quirk — e.g. a second API
   needing header-based pagination.
2. The fix is a small, well-understood change to a single function
   (e.g. adding a `paginate` style, adding array-normalization in
   `parseResponse`).
3. The local-helper workaround is fragile (e.g. the helper must inspect
   response headers, which the current contract doesn't allow).

The breakable boundary ("the hypothesis surface — break freely to
generalize") applies: if a new API forces a generalization, break the
helper rather than papering over it.

## Recipes and their axes (reference)

The 15-recipe spread (baseline + 4 axis recipes + 10 generalization-pool
recipes). Axis recipes (A–D) fire the *named* helper decisions; pool
recipes (P1–P10) surface the structural quirks the axis framework doesn't
name (diversity dimensions G1–G12). G11 (rate-limit headers) is a bonus on
GitHub and MusicBrainz; G12 (UA requirement) on MusicBrainz. Each owns a
distinct helper decision — no two overlap.

| Domain | Axis/role | Dim | Country / lang | Key quirk |
|--------|-----------|-----|----------------|-----------|
| boe.es | baseline | — | ES / es | offset-limit, JSON, UTF-8, helper.ts |
| loc.gov | A: nextLink | — | US / en | nextLink pagination, query-param format |
| services.dnb.de | B: XML | — | DE / de | XML response, offset-limit |
| resources.data.gov | C: cursor | — | US / en | cursor pagination, non-flat items, auth.headers (DEMO_KEY) |
| en.wikipedia.org | D: ETag | — | US / intl / en | ETag/conditional-GET (304 verified), no pagination |
| api.github.com | P1: header pagination | G1 + G11 | US / en | Link header (RFC 5988), X-RateLimit-*, no auth (60/hr) |
| api.gbif.org | P2: boolean hasMore | G2 | DK / en | endOfRecords termination |
| <www.federalregister.gov> | P3: overloaded signals | G3 | US / en | count + total_pages + next_page_url (cursor in URL) |
| en.wikipedia.org-action | P4: continue-token bag | G4 | US / intl / en | continue dict (bag of continuation params) |
| musicbrainz.org | P5: query-param content-neg | G5 + G11 + G12 | CH / en | fmt=json\|xml, UA requirement (anon → 403) |
| <www.wikidata.org> | P6: non-Latin scripts | G6 | DE / intl / multilingual | CJK + Arabic + Cyrillic, language-keyed dict |
| earthquake.usgs.gov | P7: GeoJSON | G7 | US / en | FeatureCollection, positional geometry |
| datos.gob.es | P8: JSON-LD | G8 | ES / es | linked-data envelope (`_about`/`definition`) |
| openlibrary.org | P9: mixed naming | G9 | US / en | numFound + num_found aliased |
| archive.org | P10: non-list | G10 | US / en | single-resource fetch, no pagination, mixed scalar typing |

**Spread:** 5 countries (ES, US, DE, DK, CH) + a multilingual (CJK/Arabic/
Cyrillic) response; 3 languages (es, en, de) plus any Wikimedia edition.
UTF-8 only across the set — no no-auth permissively-licensed non-UTF-8 API
was found; the `parseResponse` charset path is still exercised because every
response carries a `Content-Type` charset the transport decodes.

## Rejected candidates

The spread was chosen against these alternatives — kept on record so the
"no two recipes cover the same helper decision" claim and the dropped-axis
decisions (e.g. Axis D only fires with an ETag) are auditable.

| Candidate | Reason |
|-----------|--------|
| data.europa.eu hub-search | offset-limit (same axis as BOE) |
| data.gov.uk CKAN | offset-limit (same axis as BOE) |
| NYC Open Data (Socrata) | offset-limit (same axis as BOE) |
| ECB SDMX API | complex path construction, 404 on test |
| BnF SRU | endpoint unreachable / timeout |
| LoC SRU | Cloudflare challenge — not CI-reachable |
| INE Spain | 404 on tested endpoint |
| INEGI Mexico | returns HTML, not structured API |
| NOAA weather.gov (`api.weather.gov`) | no ETag (only `cache-control`) — Axis D doesn't fire |
| ip-api.com | no ETag — Axis D doesn't fire |
| USGS earthquake feed (`…/all_day.geojson`) | no ETag (only `cache-control`) — Axis D doesn't fire |
| UK Parliament API (`api.parliament.uk`) | HTTP 500 on probed endpoint |
| REST Countries (`restcountries.com`) | 301 to CDN; legacy endpoint, unstable host |
| OpenSky Network (`opensky-network.org/api/states`) | 404 — `/states` removed; core API moved to OAuth2 (keyed) |
| Open-Meteo (`api.open-meteo.com`) | flat non-list object only — no dim beyond G10 (already owned) |
