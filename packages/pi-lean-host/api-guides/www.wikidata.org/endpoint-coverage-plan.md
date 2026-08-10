# Wikidata API — Endpoint Coverage Plan

> Drafted 2026-07-21 against the live docs at
> <https://www.wikidata.org/wiki/Wikidata:Data_access> (verified by
> `web-fetch` on 2026-07-21). The authoritative endpoint reference for
> the Wikibase Action API modules was the auto-generated
> `action=paraminfo` output from `wikidata.org/w/api.php`; the REST API
> reference was the OpenAPI spec at
> `www.wikidata.org/w/rest.php/wikibase/v1/openapi.json`. Key response
> shapes confirmed by live `curl --compressed` probes on 2026-07-21
> (Q42, P31, P569, search queries). Implements the 8 read-only endpoint
> families the current `guide.md` does not yet cover.

## Status quo

`guide.md` declares **1 of many** documented read-only APIs:

| Implemented | Operation | Path/Params |
|-------------|-----------|-------------|
| ✅ | `getEntity` | `/w/api.php?action=wbgetentities&ids=...` |

The current guide covers **only** the `wbgetentities` Action API module.
Wikidata exposes at least four other read-only access methods:

1. **Wikibase Action API** (`/w/api.php`) — additional read-only `wb*` modules
2. **Wikibase REST API** (`/w/rest.php/wikibase/v1/`) — OpenAPI-based, cleaner responses
3. **Linked Data Interface** (`/wiki/Special:EntityData/{id}.json`) — full entity JSON via content negotiation
4. **SPARQL Query Service** (`query.wikidata.org/sparql`) — complex graph queries

## Verification (live, 2026-07-21)

Lines marked `📄` were verified against the auto-generated API help and
the OpenAPI spec (both fetched and readable). Lines marked `🔍` were
verified with live `curl --compressed` probes.

### Table of documented read-only endpoints

| Method | Path / params | Purpose | In scope? |
|--------|---------------|---------|-----------|
| **Action API — Entity operations** ||||
| GET | `action=wbgetentities&ids=...` | Fetch entity data (labels, descriptions, claims, sitelinks) | ✅ already implemented |
| GET | `action=wbsearchentities&search=...&language=...` | Search entities by label/alias | ✅ **to add** 🔍 |
| GET | `action=wbgetclaims&entity=...` | Get claims (statements) for an entity | ✅ **to add** 🔍 |
| GET | `action=wbavailablebadges` | List available sitelink badge IDs | ❌ (utility, low research value) |
| GET | `action=wbformatvalue&datatype=...&datavalue=...` | Format a data value for display | ❌ (utility, not data retrieval) |
| GET | `action=wbparsevalue&datatype=...&datavalue=...` | Parse a value string into typed data | ❌ (utility, not data retrieval) |
| GET | `action=wbsgetsuggestions&entity=...` | Get property suggestions for an entity | ❌ (edit-aid, low research value) |
| GET | `action=wbcheckconstraints&id=...` | Check constraint violations on an entity | ❌ (heavy, quality-assurance tool) |
| GET | `action=wbcheckconstraintparameters&property=...` | Check constraint parameters | ❌ (heavy, admin tool) |
| **REST API — Items** ||||
| GET | `/v1/entities/items/{item_id}` | Retrieve full Item (labels, descriptions, aliases, sitelinks, statements) | ✅ **to add** 🔍 |
| GET | `/v1/entities/items/{item_id}/labels` | Retrieve Item's labels | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/labels/{language_code}` | Item label in a specific language | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/labels_with_language_fallback/{language_code}` | Item label with language fallback | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/descriptions` | Item's descriptions | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/descriptions/{language_code}` | Item description in a language | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/descriptions_with_language_fallback/{language_code}` | Item description with fallback | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/aliases` | Item's aliases | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/aliases/{language_code}` | Item aliases in a language | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/sitelinks` | Item's sitelinks | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/sitelinks/{site_id}` | Single sitelink | 🔹 covered by getItem |
| GET | `/v1/entities/items/{item_id}/statements` | Statements for an Item (filterable by `property`) | ✅ **to add** 🔍 |
| GET | `/v1/entities/items/{item_id}/statements/{statement_id}` | Single Statement | 🔹 covered by getItemStatements? |
| **REST API — Properties** ||||
| GET | `/v1/entities/properties/{property_id}` | Retrieve full Property (labels, descriptions, aliases, statements) | ✅ **to add** 🔍 |
| GET | `/v1/entities/properties/{property_id}/labels` | Property labels | 🔹 covered by getProperty |
| GET | `/v1/entities/properties/{property_id}/descriptions` | Property descriptions | 🔹 covered by getProperty |
| GET | `/v1/entities/properties/{property_id}/aliases` | Property aliases | 🔹 covered by getProperty |
| GET | `/v1/entities/properties/{property_id}/statements` | Statements for a Property | ✅ **to add** 🔍 |
| GET | `/v1/entities/properties/{property_id}/statements/{statement_id}` | Single Statement from Property | 🔹 covered by getPropertyStatements? |
| **REST API — Search** ||||
| GET | `/v1/search/items?q=...&language=...&limit=&offset=` | Simple Item search by label/alias | ✅ **to add** 🔍 |
| GET | `/v1/search/properties?q=...&language=...&limit=&offset=` | Simple Property search by label/alias | ✅ **to add** 🔍 |
| GET | `/v1/suggest/items?q=...&language=...&limit=&offset=` | Prefix-based Item suggestion | ❌ (duplicates search/items with `suggest` semantics) |
| GET | `/v1/suggest/properties?q=...&language=...&limit=&offset=` | Prefix-based Property suggestion | ❌ (duplicates search/properties) |
| **REST API — Other** ||||
| GET | `/v1/property-data-types` | Map of property data types to value types | ❌ (utility metadata) |
| GET | `/v1/statements/{statement_id}` | Single Statement | 🔹 covered by item/property statements |
| **Linked Data Interface** ||||
| GET | `/wiki/Special:EntityData/{id}.json` | Full entity JSON with content negotiation | ❌ (overlaps with getItem REST API; covered by Action API wbgetentities) |
| **SPARQL Query Service** ||||
| GET | `query.wikidata.org/sparql?query=...` | Execute SPARQL queries | ✅ **to add** (see "Scope notes" below) |

### Scope notes

**SPARQL endpoint** (`query.wikidata.org/sparql?query=...`): A
dedicated SPARQL endpoint would unlock complex queries the Action API
cannot express (e.g., "all museums in Berlin with a population > 1M").
It is a read-only GET returning `application/sparql-results+json`.
However, implementing it requires either a `passthrough` mechanism (the
full SPARQL query is the param, not a closed set of named params) or a
helper that accepts a raw query string. This is **out of scope** for the
current plan — it can be added later as a single operation with
`passthrough: true` following the `openlibrary.org` pattern.

**Probe result:** A minimal `SELECT ?item ?itemLabel WHERE { VALUES
?item { wd:Q42 } SERVICE wikibase:label { bd:serviceParam
wikibase:language "en". } } LIMIT 5` returns one binding with a 200
JSON response — the endpoint is alive and returns standard
SPARQL-results+JSON format.

**Linked Data Interface:** The EntityData endpoint
(`/wiki/Special:EntityData/{id}.json`) overlaps with both the REST
`getItem` and the Action API `getEntity`. Since the REST API provides a
more structured response, we skip the LDI for now.

**REST API sub-resources** (`labels`, `descriptions`, `aliases`,
`sitelinks` in isolation): These are all included in the full
`getItem`/`getProperty` response. Adding individual sub-resource
endpoints would add ~20 operations with little benefit over a single
call that gets everything. We keep `getItem` and `getProperty` as the
primary Item/Property ops.

## Grouping for implementation

### Group A — Action API: Entity Search (`wbsearchentities`)

```
GET /w/api.php?action=wbsearchentities&search={query}&language={lang}&type={type}&limit={n}&continue={offset}
```

- `via: paginate` with `style: offset-limit` — the `continue` parameter
  is an integer offset; `limit` defaults to 7 (max 50).
- Params: `search` (required), `language` (required), `type` (default:
  `item`; also `property`, `lexeme`, `form`, `sense`),
  `strictlanguage` (boolean), `limit`, `continue`.
- Response: `{ search: [{ id, label, description, ... }], search-continue: N }`.
- `itemsPath: search`.
- One operation: `searchEntities`.

### Group B — Action API: Claims Retrieval (`wbgetclaims`)

```
GET /w/api.php?action=wbgetclaims&entity={entity_id}&property={property_id}&rank={rank}
```

- `via: restGet` — single-resource lookup. The API returns all claims
  for the entity in one response (potentially large, but it's a single
  GET — no pagination mechanism).
- Params: `entity` (required), `property` (optional — filter to one
  property), `claim` (optional — specific claim ID), `rank`
  (optional — `deprecated`, `normal`, `preferred`).
- Response: `{ claims: { P1: [...], P2: [...] } }`.
- One operation: `getClaims`.

### Group C — REST API: Item Retrieval

```
GET /w/rest.php/wikibase/v1/entities/items/{item_id}
```

- `via: restGet` — single-resource lookup.
- Path param: `item_id` (e.g., `Q42`).
- Response includes: `id`, `type`, `labels`, `descriptions`,
  `aliases`, `sitelinks`, `statements`.
- 🔍 **Live-probed (Q42):** Returns `{id: "Q42", type: "item",
  labels: {en: "Douglas Adams", ar: "دوغلاس آدمز", ...},  
  descriptions: {en: "British science fiction writer…", ...},
  aliases: {en: ["Douglas Noel Adams", ...], ...},
  sitelinks: {enwiki: {title: "Douglas Adams", ...}, ...} (132
  sitelinks), statements: {P31: [...], P21: [...], P569: [...],
  ...} (308 property groups)}`.
- ⚠️ REST API uses **flat string maps** for labels and descriptions
  (`{"en": "value"}`), unlike the Action API which wraps them in
  `{"en": {"value": ..., "language": "en"}}`. This is the native
  REST format — no helper needed.
- One operation: `getItemREST` (distinct name from the existing
  `getEntity` Action API operation).

### Group D — REST API: Item Statements

```
GET /w/rest.php/wikibase/v1/entities/items/{item_id}/statements?property={property_id}
```

- `via: restGet` — single-resource lookup (statements are part of the
  item, not paginated separately).
- Path param: `item_id`.
- Query param: `property` (optional — filter to one property ID).
- 🔍 **Live-probed (Q42):** Returns a dict `{P569: [...], P31: [...],
  ...}` — same flat `property_id → array` shape as `wbgetclaims`.
  Filtering via `?property=P569` returns only that property's claims.
- One operation: `getItemStatements`.

Note: Returns the same data as `getItemREST`'s `.statements` field,
but without the rest of the entity payload — lighter for
statement-focused research.

### Group E — REST API: Property Retrieval

```
GET /w/rest.php/wikibase/v1/entities/properties/{property_id}
```

- `via: restGet`.
- Path param: `property_id` (e.g., `P31`).
- Response includes: `id`, `type`, `data_type`, `labels`,
  `descriptions`, `aliases`, `statements`.
- 🔍 **Live-probed (P31):** Returns `{id: "P31", type: "property",
  data_type: "wikibase-item", labels: {en: "instance of", ...}
  (237 labels), descriptions: {en: "type to which this subject
  belongs…", ...}, statements: {…} (19 property groups)}`.
- One operation: `getPropertyREST`.

### Group F — REST API: Property Statements

```
GET /w/rest.php/wikibase/v1/entities/properties/{property_id}/statements?property={property_id}
```

- `via: restGet`.
- Path param: `property_id`.
- Query param: `property` (optional filter).
- One operation: `getPropertyStatements`.

### Group G — REST API: Search

```
GET /w/rest.php/wikibase/v1/search/items?q={query}&language={lang}&limit={n}&offset={n}
GET /w/rest.php/wikibase/v1/search/properties?q={query}&language={lang}&limit={n}&offset={n}
```

- `via: paginate` with `style: offset-limit` — both accept `limit` and
  `offset` query params. Default `limit` is 20 (max 100 based on the
  spec; the actual max may differ — probe before setting `pageSize`).
- `itemsPath: results`.
- Two operations: `searchItemsREST`, `searchPropertiesREST`.
- 🔍 **Live-probed:** Search "Douglas Adams" returns 3 results with
  `{id: "Q42", "display-label": {"language": "mul", "value":
  "Douglas Adams"}, "description": {"language": "en", "value":
  "British science fiction writer…"}}`. Property search "population"
  with `offset=2` returns the third and fourth results.
- Both return `{ results: [{ id, "display-label", description, match }] }`.

## Implementation phases

### Phase 1 — Group A + Group B (Action API, 2 ops)

Add `searchEntities` and `getClaims` to `guide.md`. These are the
highest-value additions because they unlock finding entities by name
(`searchEntities`) and reading the actual property data
(`getClaims`) — the core research use cases the current `getEntity`
alone cannot serve.

### Phase 2 — Group C + Group E (REST Item + Property, 2 ops)

Add `getItemREST` and `getPropertyREST`. These provide cleaner JSON
responses than the Action API equivalents and serve as the modern
interface for entity retrieval.

### Phase 3 — Group D + Group F (REST Statement sub-resources, 2 ops)

Add `getItemStatements` and `getPropertyStatements`. Lightweight
statement-only fetches without the full entity payload.

### Phase 4 — Group G (REST Search, 2 ops)

Add `searchItemsREST` and `searchPropertiesREST`. REST API search
returns a cleaner format than `wbsearchentities` (though both are
useful; the Action API search is kept for parity with the existing
Action API operations).

## Testing

Follow the boe.es pattern — tests are **co-located** with the guide:

- `endpoint-coverage.test.ts` — `HOST_INTEGRATION=1`-gated live
  coverage: executes every new operation against the live endpoint,
  asserts each response has the expected shape (status 200 + non-empty
  body). One assertion per operation.
- No `helper.test.ts` needed — no helper code is required for any of
  these operations.

Framework-level regression: `packages/pi-lean-host/__tests__/parse-api-guide.test.ts`
should confirm the guide parses with the new op count (total = 8 new +
1 existing = 9). This is a nice-to-have; the co-located coverage test
already proves the guide parses.

## Files touched

| File | Change |
|------|--------|
| `api-guides/www.wikidata.org/guide.md` | Add 8 new operations across Groups A–G |
| `api-guides/www.wikidata.org/endpoint-coverage.test.ts` | **Create** — live coverage test for all operations |
| (no helper.ts changes) | None of these ops need a transform |

## Out of scope / deliberate omissions

- **SPARQL endpoint** — high value but needs `passthrough` flag or a
  dedicated helper. Deferred to a future sprint.
- **`wbavailablebadges`** — utility metadata, not research data.
- **`wbformatvalue` / `wbparsevalue`** — value formatting utilities, not
  data retrieval.
- **`wbsgetsuggestions`** — edit-aid for property suggestions.
- **`wbcheckconstraints` / `wbcheckconstraintparameters`** — heavy QA
  tooling, not a research read endpoint.
- **REST sub-resource granular endpoints** (individual labels,
  descriptions, aliases, sitelinks) — all covered by `getItemREST` /
  `getPropertyREST` full responses.
- **Linked Data Interface** — overlaps with both REST and Action APIs.
- **`query+pageterms` / `query+wbentityusage`** — MediaWiki query
  submodules that are Wikipedia-page-oriented, not Wikidata-first.
- **`query+wikibase` meta** — returns server config, not data.

## Implementation notes

Shipped 2026-08-06 (C11 of the rollout). All 8 planned operations added to
`guide.md` (9 total incl. existing `getEntity`); `endpoint-coverage.test.ts`
created with one assertion per op (11 live assertions incl. baseline + the
two `property`-filter checks). Bare CI green (11 skipped), live
`HOST_INTEGRATION=1` green (11/11), `npm run test:ci` green (921 passed).

**Deviations:** none from the frozen plan. Two implementation details worth
recording:

- **`searchEntities` `pageParam` is `continue`** — the Action API's integer
  offset param is named `continue` (not `offset`), so the `offset-limit`
  pagination block uses `pageParam: continue` with `pageSizeParam: limit`.
  Live probe confirmed `continue=0`/`continue=N` advance correctly.
- **Path params not re-declared** — `{item_id}` / `{property_id}` are inferred
  from the path tokens (parser rule, same as prior guides); they do not appear
  in `params`. REST sub-resources (labels/descriptions/sitelinks) remain
  covered by `getItemREST` / `getPropertyREST` per the plan's scope notes.

**SPARQL** remains deferred exactly as the plan states (needs a single
`passthrough: true` op; out of scope for this rollout).
