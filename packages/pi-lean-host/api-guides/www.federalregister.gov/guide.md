---
kind: api
schemaVersion: 0
domains:
  - federalregister.gov
shortName: Federal Register
icon: 📰
apiHost: https://www.federalregister.gov
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://www.federalregister.gov/developers
operations:
  - name: listDocuments
    via: paginate
    path: /api/v1/documents
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: next_page_url
    params:
      per_page:
        description: Per-page count.
        default: 2
      "conditions[term]":
        description: Full-text search query (spec name `conditions[term]`).
      "conditions[publication_date][is]":
        description: Exact publication date, YYYY-MM-DD (spec name `conditions[publication_date][is]`).
      "conditions[publication_date][gte]":
        description: Publication date on or after, YYYY-MM-DD (spec name `conditions[publication_date][gte]`).
      "conditions[publication_date][lte]":
        description: Publication date on or before, YYYY-MM-DD (spec name `conditions[publication_date][lte]`).
      "conditions[agencies][]":
        description: Publishing agency slug(s) (spec name `conditions[agencies][]`). Repeatable.
      "conditions[type][]":
        description: >
          Document type(s) (spec name `conditions[type][]`). Repeatable.
          Values: `RULE` (Final Rule), `PRORULE` (Proposed Rule), `NOTICE`
          (Notice), `PRESDOCU` (Presidential Document).
      order:
        description: >
          Sort order (spec name `order`). Values: `relevance`, `newest`,
          `oldest`, `executive_order_number`.
      page:
        description: Page number (1-based) in addition to `next_page_url`.
      "fields[]":
        description: >
          Comma-separated list of attributes to return (spec name `fields[]`).
          Defaults to a reasonable set if omitted.
  # ── Group A — Single-resource lookups ──
  - name: getDocument
    via: restGet
    path: /api/v1/documents/{document_number}
    accept: json
    params:
      "fields[]":
        description: >
          Comma-separated list of attributes to return (spec name `fields[]`).
          Defaults to a reasonable set if omitted.
  - name: getAgency
    via: restGet
    path: /api/v1/agencies/{slug}
    accept: json
    params:
      id:
        description: Agency id (deprecated by the spec, optional).
  - name: getImage
    via: restGet
    path: /api/v1/images/{identifier}
    accept: json
  - name: getSuggestedSearch
    via: restGet
    path: /api/v1/suggested_searches/{slug}
    accept: json
  # ── Group B — List/metadata endpoints ──
  - name: listAgencies
    via: restGet
    path: /api/v1/agencies
    accept: json
  - name: listSuggestedSearches
    via: restGet
    path: /api/v1/suggested_searches
    accept: json
    params:
      "conditions[sections]":
        description: >
          Limit to a FederalRegister.gov section slug (spec name
          `conditions[sections]`).
  - name: getDocumentFacets
    via: restGet
    path: /api/v1/documents/facets/{facet}
    accept: json
    params:
      "conditions[term]":
        description: Full-text search query (spec name `conditions[term]`).
  # ── Group C — Public Inspection Documents ──
  - name: listPublicInspectionDocuments
    via: paginate
    path: /api/v1/public-inspection-documents
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: next_page_url
    params:
      "conditions[available_on]":
        description: >
          Public Inspection issue date, YYYY-MM-DD (spec name
          `conditions[available_on]`; **required** by the spec).
        required: true
      per_page:
        description: Per-page count. Max 1000.
        default: 20
      "conditions[term]":
        description: Full-text search query (spec name `conditions[term]`).
  - name: getCurrentPublicInspectionDocuments
    via: restGet
    path: /api/v1/public-inspection-documents/current
    accept: json
  - name: getPublicInspectionDocument
    via: restGet
    path: /api/v1/public-inspection-documents/{document_number}
    accept: json
  # ── Group D — Issues / table of contents ──
  - name: getIssue
    via: restGet
    path: /api/v1/issues/{publication_date}
    accept: json
  # ── Group E — Multi-document batch fetch ──
  - name: getDocuments
    via: restGet
    path: /api/v1/documents/{document_numbers}
    accept: json
  - name: getPublicInspectionDocuments
    via: restGet
    path: /api/v1/public-inspection-documents/{document_numbers}
    accept: json
---
# Federal Register — Documents API (G3: overloaded pagination signals)

The US Federal Register API exposes published federal documents with **no
auth**. US federal government data is public domain.

## Operations

### `listDocuments` — browse federal documents

`GET /api/v1/documents?per_page=…` returns `{description, count, total_pages,
next_page_url, results[]}`. The `params` block also declares the high-value
`conditions[…]` filter family from the spec (full-text `term`, publication
date ranges, agency/type filters, `order`, `page`, `fields[]`) so the agent
knows they exist; the API accepts arbitrary `conditions[…]` keys.

## Additional operations (rollout Batch B)

The 13 operations below were added during the rollout from the
`endpoint-coverage-plan.md` audit (Groups A–E). All are read-only, no auth,
and point at `/api/v1/*` JSON only — never the HTML `/developers` site
(reCAPTCHA wall, see `../WAF-NOTES.md`).

### Group A — Single-resource lookups

- **`getDocument`** — `GET /api/v1/documents/{document_number}`: full
  metadata for one Federal Register document. Optional `fields[]` selects
  attributes.
- **`getAgency`** — `GET /api/v1/agencies/{slug}`: one agency by slug (e.g.
  `consumer-financial-protection-bureau`).
- **`getImage`** — `GET /api/v1/images/{identifier}`: image variants
  (`large`, `medium`, `original_size`) for an image identifier taken from a
  document's `images` field (e.g. `EP03JN26.006`).
- **`getSuggestedSearch`** — `GET /api/v1/suggested_searches/{slug}`: one
  suggested search by its own `slug` (e.g. `dodd-frank-wall-steet-reform`),
  not the section key.

### Group B — List/metadata endpoints

- **`listAgencies`** — `GET /api/v1/agencies`: **bare JSON array** of 472
  agencies (no `{results[]}` envelope, no pagination). `restGet` returns the
  whole array as `data`.
- **`listSuggestedSearches`** — `GET /api/v1/suggested_searches`: object keyed
  by FR section slug (`money`, `environment`, …) → arrays of suggested
  searches. Optional `conditions[sections]` limits to one section.
- **`getDocumentFacets`** — `GET /api/v1/documents/facets/{facet}`: object
  keyed by facet value → counts. `{facet}` enum: `daily`, `weekly`, `monthly`,
  `quarterly`, `yearly`, `agency`, `topic`, `section`, `type`, `subtype`.

### Group C — Public Inspection Documents

- **`listPublicInspectionDocuments`** — `GET /api/v1/public-inspection-documents`
  (nextLink pagination via `next_page_url`). `conditions[available_on]`
  (YYYY-MM-DD) is **required** by the spec.
- **`getCurrentPublicInspectionDocuments`** —
  `GET /api/v1/public-inspection-documents/current`: all PI docs currently on
  inspection in one response (`{count, results[]}`, no pagination — confirmed
  by probe).
- **`getPublicInspectionDocument`** —
  `GET /api/v1/public-inspection-documents/{document_number}`: one PI doc.

### Group D — Issues / table of contents

- **`getIssue`** — `GET /api/v1/issues/{publication_date}`: print-edition TOC
  for a date (YYYY-MM-DD), returned as `{agencies[]}`.

### Group E — Multi-document batch fetch

- **`getDocuments`** — `GET /api/v1/documents/{document_numbers}`: fetch
  multiple docs by comma-separated document numbers in one path segment
  (e.g. `2026-16125,2026-16084`). Returns `{count, results[]}`; missing
  numbers surface under `errors.not_found`.
- **`getPublicInspectionDocuments`** —
  `GET /api/v1/public-inspection-documents/{document_numbers}`: same
  comma-separated batch shape for PI docs.

## How G3 fires

**One response carries three pagination signals at once:**

1. `count` + `total_pages` — count-math style.
2. `next_page_url` — nextLink style (a full URL).
3. A `search_after` cursor embedded inside `next_page_url` — cursor style.

The recipe picks **nextLink** (`nextLinkPath: next_page_url`) and ignores the
others. The escape-valve concern is the opposite of a missing signal: the
helper must stay robust to an **over-specified** response and pick one signal
without choking on the rest. A `paginate` that asserts "exactly one pagination
style" breaks here.

## Terms

US federal government — public domain.
<https://www.federalregister.gov/developers>
