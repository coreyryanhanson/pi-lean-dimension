# Federal Register API — Endpoint Coverage Plan

> Drafted 2026-07-21 against the **official OpenAPI / Swagger spec** at
> <https://www.federalregister.gov/developers/documentation/api/v1>
> (extracted from the live Swagger UI via the browser tool — the page is
> a JS-rendered SPA behind a reCAPTCHA wall that blocks `curl`/`web-fetch`,
> see `../WAF-NOTES.md`). The endpoint list, paths, parameters, and enums
> below are taken **verbatim from the spec**, not inferred from probing.
> Live `curl` probes against `/api/v1/*` confirmed every endpoint returns
> JSON with no auth on 2026-07-21.

## Status quo

`guide.md` declares **1 of 14** documented GET endpoints:

| Implemented | Operation | Spec path |
|-------------|-----------|-----------|
| ✅ | `listDocuments` | `/documents.{format}` (search) |

## Verification (2026-07-21)

The Federal Register API v1 is documented as an OpenAPI spec with **14
GET endpoints** across five tags. No auth required on any. The `.format`
path suffix (`json` or `csv`) is **required by the spec** but optional in
practice (the server defaults to JSON when omitted — confirmed by probe).
The existing guide omits the suffix and sets `accept: json`; this plan
follows the same convention for consistency.

### Complete endpoint list (from the spec)

#### Federal Register Documents (5 endpoints)

| # | Spec path | Summary | In guide? |
|---|-----------|---------|-----------|
| 1 | `GET /documents/{document_number}.{format}` | Fetch a single Federal Register document | ❌ |
| 2 | `GET /documents/{document_numbers}.{format}` | Fetch multiple Federal Register documents (comma-separated document numbers) | ❌ |
| 3 | `GET /documents.{format}` | Search all FR documents published since 1994 | ✅ `listDocuments` |
| 4 | `GET /documents/facets/{facet}` | Fetch counts of matching documents grouped by a facet | ❌ |
| 5 | `GET /issues/{publication_date}.{format}` | Fetch document table of contents based on the print edition | ❌ |

#### Public Inspection Documents (4 endpoints)

| # | Spec path | Summary | In guide? |
|---|-----------|---------|-----------|
| 6 | `GET /public-inspection-documents/{document_number}.{format}` | Fetch a single public inspection document | ❌ |
| 7 | `GET /public-inspection-documents/{document_numbers}.{format}` | Fetch multiple public inspection documents | ❌ |
| 8 | `GET /public-inspection-documents/current.{format}` | Fetch all PI documents currently on public inspection | ❌ |
| 9 | `GET /public-inspection-documents.{format}` | Search all PI documents currently on public inspection | ❌ |

#### Agencies (2 endpoints)

| # | Spec path | Summary | In guide? |
|---|-----------|---------|-----------|
| 10 | `GET /agencies` | Fetch all agency details | ❌ |
| 11 | `GET /agencies/{slug}` | Fetch a particular agency's details | ❌ |

#### Images (1 endpoint)

| # | Spec path | Summary | In guide? |
|---|-----------|---------|-----------|
| 12 | `GET /images/{identifier}` | Fetch available image variants and metadata for a single image identifier | ❌ |

#### Suggested Searches (2 endpoints)

| # | Spec path | Summary | In guide? |
|---|-----------|---------|-----------|
| 13 | `GET /suggested_searches` | Fetch all suggested searches or limit by FR section | ❌ |
| 14 | `GET /suggested_searches/{slug}` | Fetch a particular suggested search | ❌ |

### Key schema enums (from the spec's `components.schemas`)

- **`Format`**: `json`, `csv`
- **`Facet`** (for `/documents/facets/{facet}`): `daily`, `weekly`,
  `monthly`, `quarterly`, `yearly`, `agency`, `topic`, `section`, `type`,
  `subtype`
- **`order`** (for `/documents.{format}`): `relevance`, `newest`,
  `oldest`, `executive_order_number`
- **`conditions[type][]`**: `RULE` (Final Rule), `PRORULE` (Proposed
  Rule), `NOTICE` (Notice), `PRESDOCU` (Presidential Document)

### Response shapes (verified by live probe)

- **Search endpoints** (`/documents`, `/public-inspection-documents`):
  `{description, count, total_pages, next_page_url, results[]}` —
  nextLink pagination via `next_page_url`. `per_page` max 1000; can only
  paginate through first 2000 results (use date filters for more).
- **Single-resource endpoints** (`/documents/{n}`, `/agencies/{slug}`,
  `/images/{id}`, `/suggested_searches/{slug}`): bare object, no envelope.
- **`/agencies`**: bare JSON array of 472 agency objects (no envelope, no
  pagination — `per_page` has no effect). Quirk: the only list endpoint
  that returns a bare array instead of `{results[]}`.
- **`/documents/facets/{facet}`**: object keyed by facet value (e.g.
  agency slugs) → counts. Not a paginated list.
- **`/issues/{date}`**: `{agencies[], meta{...}}` — table of contents for
  a print edition date.
- **`/public-inspection-documents/current`**: `{count, results[], ...}` —
  all current PI docs (no `next_page_url` probe-confirmed but likely
  paginated given 91 docs; verify in Phase 0).
- **`/suggested_searches`**: object keyed by FR section slug
  (`money`, `environment`, …) → suggested-search objects.

## Grouping for implementation

### Group A — Single-resource lookups (4 operations, high value)

| # | Operation | `via` | Path | Notes |
|---|-----------|-------|------|-------|
| A1 | `getDocument` | `restGet` | `/documents/{document_number}` | Full metadata for one document. Params: `fields[]` (optional). |
| A2 | `getAgency` | `restGet` | `/agencies/{slug}` | Single agency by slug. Params: `id` (deprecated, optional). |
| A3 | `getImage` | `restGet` | `/images/{identifier}` | Image variants (large/medium/original_size) by identifier. Identifiers come from a document's `images` field (e.g. `ED20JY26.152`). |
| A4 | `getSuggestedSearch` | `restGet` | `/suggested_searches/{slug}` | Single suggested search by slug. |

### Group B — List/metadata endpoints (3 operations)

| # | Operation | `via` | Path | Notes |
|---|-----------|-------|------|-------|
| B1 | `listAgencies` | `restGet` | `/agencies` | **Bare JSON array** (472 items), no `{results[]}` envelope. No params. |
| B2 | `listSuggestedSearches` | `restGet` | `/suggested_searches` | Object keyed by section slug. Params: `conditions[sections]` (optional). |
| B3 | `getDocumentFacets` | `restGet` | `/documents/facets/{facet}` | Counts grouped by facet. Path param `{facet}` (enum). Same `conditions[…]` filter family as search. |

### Group C — Public Inspection Documents (3 operations)

| # | Operation | `via` | Path | Notes |
|---|-----------|-------|------|-------|
| C1 | `listPublicInspectionDocuments` | `paginate` | `/public-inspection-documents` | Search PI docs. `conditions[available_on]` (date) **required** by spec. nextLink pagination. |
| C2 | `getCurrentPublicInspectionDocuments` | `restGet` | `/public-inspection-documents/current` | All PI docs currently on inspection. No required params. |
| C3 | `getPublicInspectionDocument` | `restGet` | `/public-inspection-documents/{document_number}` | Single PI doc by document number. |

### Group D — Issues / table of contents (1 operation)

| # | Operation | `via` | Path | Notes |
|---|-----------|-------|------|-------|
| D1 | `getIssue` | `restGet` | `/issues/{publication_date}` | Print-edition TOC for a date (YYYY-MM-DD). Returns `{agencies[], meta{...}}`. |

### Group E — Multi-document batch fetch (2 operations, low priority)

| # | Operation | `via` | Path | Notes |
|---|-----------|-------|------|-------|
| E1 | `getDocuments` | `restGet` | `/documents/{document_numbers}` | Fetch multiple docs by comma-separated document numbers. |
| E2 | `getPublicInspectionDocuments` | `restGet` | `/public-inspection-documents/{document_numbers}` | Fetch multiple PI docs by comma-separated numbers. |

⚠ **Note on multi-document endpoints:** the `{document_numbers}` path
param is a comma-separated list in a single path segment (e.g.
`/documents/2026-01171,2026-01172`). This is an unusual shape — verify
the guide router handles comma-separated values in a path param without
URL-encoding the comma. If it encodes commas, these may need a tiny
helper or a note to use one document number at a time. Low priority
either way; single-document fetch (Group A) covers the common case.

## Proposed operations summary

| Group | Ops to add | `via` | Priority | Notes |
|-------|-----------|-------|----------|-------|
| A | 4 | `restGet` | High | Single doc, agency, image, suggested-search lookups |
| B | 3 | `restGet` | Medium | Agencies list (bare-array quirk), suggested searches, document facets |
| C | 3 | `paginate` / `restGet` | Medium | Public inspection docs (search, current, single) |
| D | 1 | `restGet` | Medium | Print-edition issue TOC |
| E | 2 | `restGet` | Low | Multi-document batch fetch (comma-list path param quirk) |
| **Total** | **13** | | | |

## Implementation phases

### Phase 0 — Live shape probes (2 quick probes)

1. **Probe `/agencies` bare-array handling:** confirm the response is a
   bare JSON array (472 items, not `{results[]}`). Decide how the guide
   router extracts items from a bare array — likely `itemsPath: $`
   (root) or "no `itemsPath` = whole body is the list." This determines
   Group B1's YAML.
2. **Probe `/public-inspection-documents/current` pagination:** the
   `current` endpoint returned 91 docs in one probe. Confirm whether it
   paginates (`next_page_url` present?) or returns all in one response.
   This determines whether C2 is `restGet` or `paginate`.

### Phase 1 — Add Group A (Single-resource lookups)

Four operations, all `restGet`, all single-object responses:

```yaml
  - name: getDocument
    via: restGet
    path: /api/v1/documents/{document_number}
    accept: json
    pathParams:
      - document_number
    params:
      fields:
        description: >
          Comma-separated list of attributes to return (spec name:
          `fields[]`). Defaults to a reasonable set if omitted.

  - name: getAgency
    via: restGet
    path: /api/v1/agencies/{slug}
    accept: json
    pathParams:
      - slug

  - name: getImage
    via: restGet
    path: /api/v1/images/{identifier}
    accept: json
    pathParams:
      - identifier

  - name: getSuggestedSearch
    via: restGet
    path: /api/v1/suggested_searches/{slug}
    accept: json
    pathParams:
      - slug
```

### Phase 2 — Add Group B (List/metadata endpoints)

```yaml
  - name: listAgencies
    via: restGet
    path: /api/v1/agencies
    accept: json
    # NOTE: response is a bare JSON array (472 items), not {results[]}.
    # itemsPath TBD in Phase 0 — likely $ (root) or omitted.

  - name: listSuggestedSearches
    via: restGet
    path: /api/v1/suggested_searches
    accept: json
    params:
      conditions_sections:
        description: >
          Limit to a FederalRegister.gov section slug (spec name:
          `conditions[sections]`).

  - name: getDocumentFacets
    via: restGet
    path: /api/v1/documents/facets/{facet}
    accept: json
    pathParams:
      - facet
    params:
      # Same conditions[…] filter family as listDocuments (see Phase 4).
      conditions_term:
        description: Full text search (spec name: `conditions[term]`).
```

### Phase 3 — Add Group C (Public Inspection Documents)

```yaml
  - name: listPublicInspectionDocuments
    via: paginate
    path: /api/v1/public-inspection-documents
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: next_page_url
    params:
      conditions_available_on:
        description: >
          Public Inspection issue date, YYYY-MM-DD (spec name:
          `conditions[available_on]`; **required** by spec).
        required: true
      per_page:
        description: Per-page count. Max 1000.
        default: 20
      conditions_term:
        description: Full text search (spec name: `conditions[term]`).

  - name: getCurrentPublicInspectionDocuments
    via: restGet   # or paginate — confirm in Phase 0
    path: /api/v1/public-inspection-documents/current
    accept: json

  - name: getPublicInspectionDocument
    via: restGet
    path: /api/v1/public-inspection-documents/{document_number}
    accept: json
    pathParams:
      - document_number
```

### Phase 4 — Add Group D (Issues TOC) + extend `listDocuments` params

```yaml
  - name: getIssue
    via: restGet
    path: /api/v1/issues/{publication_date}
    accept: json
    pathParams:
      - publication_date
```

Also in Phase 4: **extend the existing `listDocuments` `params` block**
with the high-value `conditions[…]` search params documented in the spec.
The current guide only declares `per_page`. The spec documents a rich
filter surface:

- `conditions[term]` — full-text search
- `conditions[publication_date][is]` / `[year]` / `[gte]` / `[lte]` — date filters
- `conditions[effective_date][is]` / `[year]` / `[gte]` / `[lte]` — effective date filters
- `conditions[agencies][]` — publishing agency slugs
- `conditions[type][]` — `RULE`, `PRORULE`, `NOTICE`, `PRESDOCU`
- `conditions[presidential_document_type][]` / `conditions[president][]` — presidential filters
- `conditions[docket_id]` / `conditions[regulation_id_number]` — docket/RIN
- `conditions[sections][]` / `conditions[topics][]` — section/topic filters
- `conditions[significant]` — `0` / `1`
- `conditions[cfr][title]` / `conditions[cfr][part]` — CFR references
- `conditions[near][location]` / `conditions[near][within]` — geo search
- `order` — `relevance`, `newest`, `oldest`, `executive_order_number`
- `page` — page number (in addition to `next_page_url`)
- `fields[]` — attribute selection

Declare the **high-value subset** on `listDocuments` so the agent knows
they exist. The full filter surface is large; adding every
`conditions[…]` key would bloat the recipe. The agent can pass arbitrary
keys through the generic param passthrough if the router supports
Rails-style nested params; otherwise add keys incrementally as use cases
arise.

### Phase 5 (optional, low priority) — Add Group E (Multi-document batch)

Only if the Phase 0 probe confirms the router handles comma-separated
path params. Otherwise skip — single-document fetch (Group A1) covers
the common case, and an agent can issue multiple `getDocument` calls.

## Testing

Follow the boe.es pattern — one file, co-located:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - `listDocuments`: status 200, `results` is non-empty array (existing)
   - `getDocument`: status 200, response has `document_number` + `title`
   - `getAgency`: status 200, response has `name` + `slug`
   - `getImage`: status 200, response has image variant keys (e.g.
     `large`, `medium`). Use a real identifier extracted from a
     document's `images` field (fetch one in a `beforeAll`).
   - `getSuggestedSearch`: status 200, response is non-empty object
   - `listAgencies`: status 200, response is an array with > 400 items
   - `listSuggestedSearches`: status 200, response is non-empty object
   - `getDocumentFacets`: status 200, response is non-empty object
   - `listPublicInspectionDocuments`: status 200, `results` non-empty
     (pass `conditions[available_on]=<today>`)
   - `getCurrentPublicInspectionDocuments`: status 200, non-empty
   - `getPublicInspectionDocument`: status 200, has `document_number`
   - `getIssue`: status 200, response has `agencies` array
   - One assertion per operation — same coverage density as boe.es.

2. **`helper.test.ts`** — Not needed. No helper transforms proposed
   (unless the bare-array or comma-path-param probes in Phase 0 reveal a
   need, in which case add a minimal helper then).

Manual: run `api-guide www.federalregister.gov` from a pi session,
confirm all 14 ops appear with correct param hints.

⚠ **Test routing note:** point tests at `/api/v1/*` only. Do NOT
instantiate tests against the HTML `/developers` page — that hits the
reCAPTCHA wall (see `../WAF-NOTES.md`).

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add Group A (4 ops, Phase 1), Group B (3 ops, Phase 2), Group C (3 ops, Phase 3), `getIssue` (Phase 4). Extend `listDocuments` `params` with high-value `conditions[…]` docs (Phase 4). Optionally Group E (Phase 5). |
| `helper.ts` | Unchanged unless Phase 0 probes reveal a bare-array or comma-path-param need. |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created unless helper added) |
| `spec/` | Not created — the authoritative spec is the live OpenAPI doc at `/developers/documentation/api/v1`, extracted via browser. No PDF to cache. |
| `../WAF-NOTES.md` | Already updated with the `/developers` CAPTCHA note. |

## Out of scope / deliberate omissions

- **`/sections`** — NOT in the official OpenAPI spec. An earlier probe
  hit `/api/v1/sections` and got a category tree, but this is a website
  taxonomy endpoint, not a documented API surface. Deliberately omitted
  to avoid shipping an undocumented endpoint that could change without
  notice. (The six section slugs — `money`, `environment`, `world`,
  `science-and-technology`, `business-and-industry`,
  `health-and-public-welfare` — appear as `conditions[sections][]` values
  in the documented search API, which is the supported way to filter by
  section.)
- **`/articles`** — not in the spec at all. An earlier probe found
  `/api/v1/articles` returned the same data as `/documents`, but since
  it's undocumented, it's omitted for the same reason as `/sections`.
- **`csv` format** — the spec documents `csv` as a format option, but
  this plugin is a JSON-consuming research aide. Only `json` is
  declared. An agent needing CSV can pass `format=csv` if the router
  allows overriding `accept`, but no dedicated CSV operation is added.
- **Subscriber / folder / user-alert endpoints** — write/notification
  features, not read-only. Not in the spec.
- **eCFR API** — sibling API on `ecfr.gov`, separate guide if needed.
- **Full `conditions[…]` param family** — declaring every filter key
  would bloat the recipe. Phase 4 declares the high-value subset
  (`term`, date ranges, `agencies`, `type`, `order`, `fields`). The
  agent can pass arbitrary `conditions[…]` keys through the generic
  passthrough if the router supports Rails-style nested params.
- **Multi-document batch (Group E)** — low priority; deferred to Phase 5
  pending the comma-path-param router probe. Single-document fetch
  covers the common case.
- **Bare-array `itemsPath` for `listAgencies`:** left as a Phase 0
  probe decision. No speculative helper.

## Implementation notes

Rollout Batch B (#6) implemented 2026-08-06. All 14 ops shipped (13 new +
existing `listDocuments`), live gate green (`HOST_INTEGRATION=1` 15/15), bare
CI green. Deviations from the frozen plan:

- **Rails-style `conditions[…]` params use literal bracket keys.** The plan
  drafted `conditions_available_on` / `conditions_sections` / `conditions_term`
  names, but the pipeline sends the **declared param name verbatim** as the
  query key (URLSearchParams-encoded). The FR API ignores underscore names
  (verified: `conditions_available_on=…` did not filter, returned a wrong
  result set), while `conditions%5Bavailable_on%5D=…` (what a literal
  `conditions[available_on]` key produces) works. `guide.md` therefore declares
  the literal spec keys — `conditions[available_on]`, `conditions[term]`,
  `conditions[agencies][]`, `conditions[type][]`, `conditions[publication_date][gte]`,
  etc. — so the correct query reaches the wire. This also means each
  `conditions[…]` filter is its own declared param.
- **Group E shipped** (plan marked it Phase 5 optional pending the
  comma-path-param probe). Probe confirmed the router does **not** URL-encode
  the comma inside a path token: `/documents/2026-16125,2026-16084.json`
  returns `{count, results[]}`, and missing numbers surface under
  `errors.not_found` (200, not 404). Both batch ops were added.
- **`getCurrentPublicInspectionDocuments` is `restGet`, not `paginate`.**
  Phase 0 probe: `/public-inspection-documents/current` has **no**
  `next_page_url` and returns all 157 current docs in one response.
- **`getImage` variants are objects, not URL strings.** The plan's test draft
  assumed `large`/`medium`/`original_size` held a URL string; the live
  `/images/{identifier}` response returns variant **objects**
  `{content_type, height, identifier, sha, size, url, width}`. Test asserts
  each variant is an object carrying a `url` string.
- **`getIssue` returns `{agencies[]}` only** — the plan's `meta{...}` top-level
  field was not observed in the live response (2024-01-02 probe). Test asserts
  the `agencies` array only.
- **Single suggested search uses the object's own `slug`, not a section key.**
  `/suggested_searches/{slug}` resolves the search's `slug` field (e.g.
  `dodd-frank-wall-steet-reform`); section keys (e.g. `money`) 404. Test uses a
  real slug.
- **PI-search test date is discovered at runtime**, not a fixed `<today>`:
  the plan's `conditions[available_on]=<today>` is empty on weekends/pre-posting
  mornings. The test walks back up to 14 days to the most recent date with
  PI docs (direct fetch against the clean `/api/v1/*` JSON — no WAF issue).
