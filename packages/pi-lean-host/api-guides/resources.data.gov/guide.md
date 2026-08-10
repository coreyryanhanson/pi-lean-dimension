---
kind: api
domains:
  - resources.data.gov
  - api.gsa.gov
shortName: Data.gov
icon: 🇺🇸
apiHost: https://api.gsa.gov
auth:
  kind: none
  headers:
    X-Api-Key: DEMO_KEY
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-06"
docs: https://resources.data.gov/catalog-api/
operations:
  - name: searchDatasets
    via: paginate
    path: /technology/datagov/v4/search
    accept: json
    pagination:
      style: cursor
      itemsPath: results
      cursorParam: after
      cursorPath: after
    params:
      q:
        description: >
          Free-text search query (e.g. `water`). Omit to browse the catalog.
      per_page:
        description: Per-page count.
        default: 2

  # Group A — Dataset metadata lookups (power the catalog search)
  - name: getKeywords
    via: restGet
    path: /technology/datagov/v4/keywords
    accept: json
    params:
      size:
        description: Max number of keywords to return (1–1000).
        default: 100
      min_count:
        description: Only return keywords with at least this many datasets.
        default: 1
  - name: getOrganizations
    via: restGet
    path: /technology/datagov/v4/organizations
    accept: json
  - name: searchLocations
    via: restGet
    path: /technology/datagov/v4/locations/search
    accept: json
    params:
      q:
        description: Partial location name to autocomplete on (e.g. `Colorado`).
      size:
        description: Max number of location matches to return.

  # Group B — Location geometry
  - name: getLocationGeometry
    via: restGet
    path: /technology/datagov/v4/location/{location_id}
    accept: json

  # Group C — Harvest record inspection
  - name: getHarvestRecord
    via: restGet
    path: /technology/datagov/v4/harvest_record/{record_id}
    accept: json
  - name: getHarvestRecordRaw
    via: restGet
    path: /technology/datagov/v4/harvest_record/{record_id}/raw
    accept: json
  - name: getHarvestRecordTransformed
    via: restGet
    path: /technology/datagov/v4/harvest_record/{record_id}/transformed
    accept: json
---
# resources.data.gov — Data.gov Catalog API

The Data.gov catalog API (hosted at `api.gsa.gov` under the GSA) exposes the
US federal data catalog. US federal data is public domain / CC0-equivalent.

## Operations

### `searchDatasets` — cursor-paginated catalog search

`GET /technology/datagov/v4/search?q=…&per_page=…` returns a page whose
**`after` cursor** lives at the top level (not inside a `pagination`
envelope). The cursor is an opaque base64 string — pass it verbatim as
`after=` on the next request. The item list is **not** a flat `{data: [...]}`:
each result is deeply structured (`_score`, `_sort`, `dcat`, `organization`,
…).

```json
{
  "after": "Wzc4LjI4NDcyLDAsIjc2YmUxOWVi…",
  "sort": "relevance",
  "results": [ { "_score": 78.28, "_sort": [...], "dcat": "...", "organization": { "slug": "nasa" } } ]
}
```

The cursor decodes to `[score, tiebreaker, uuid]` but the client treats it as
opaque. The non-obvious cursor path (top-level `after`) and non-flat items are
the axis-C stress.

### `getKeywords` — most-used keywords

`GET /technology/datagov/v4/keywords?size=…&min_count=…` returns the
most-used keywords in the catalog with dataset counts:

```json
{
  "keywords": [
    { "count": 277320, "keyword": "county or equivalent entity" },
    { "count": 164300, "keyword": "united states" }
  ],
  "min_count": 1, "size": 100, "total": 2
}
```

### `getOrganizations` — publishing organizations

`GET /technology/datagov/v4/organizations` returns the organizations that
publish datasets (no params — a flat list, ~300 orgs):

```json
{
  "organizations": [
    { "id": "fb3131aa-…", "name": "U.S. Census Bureau, …", "slug": "census",
      "organization_type": "Federal Government", "dataset_count": 293640, … }
  ]
}
```

### `searchLocations` — geographic-location autocomplete

`GET /technology/datagov/v4/locations/search?q=…&size=…` autocompletes
geographic locations by partial name. Each match carries a **numeric** `id`
(not a UUID — pass it straight to `getLocationGeometry`):

```json
{ "locations": [ { "display_name": "Colorado", "id": "6" } ], "size": 3, "total": 3 }
```

### `getLocationGeometry` — GeoJSON geometry for a location

`GET /technology/datagov/v4/location/{location_id}` returns the geometry for
a location from `searchLocations`. The response's `geometry` is a
**JSON-encoded string** of a GeoJSON geometry (typically `MultiPolygon`), not
an inline object:

```json
{
  "geometry": "{\"type\":\"MultiPolygon\",…}",
  "id": "6"
}
```

### Harvest records — provenance metadata

`GET /technology/datagov/v4/harvest_record/{record_id}` returns the harvest
metadata for a dataset; the `/raw` and `/transformed` suffixes return the
original source payload (JSON/XML/text) and the DCAT-US-transformed payload
respectively. The `record_id` is a UUID. These are operational/provenance
lookups, lower value than the catalog lookups above.

## Notes

**`auth.headers` seam:** This endpoint requires `X-Api-Key: DEMO_KEY` — a
free, no-signup dev key. The `auth.headers` map injects it into every request
without using the `static-key` auth kind (reserved for real keyed auth in a
future revision). The `AuthConfig.headers` seam covers the DEMO_KEY/header-only
case that isn't keyed auth but isn't pure `kind: none` either.

The recipe's primary evidence remains the cursor-shape axis: `cursorPath:
after` (non-obvious top-level cursor) and non-flat `itemsPath: results`.

## Terms

US federal government — public domain / CC0-equivalent. GSA open-data policy:
<https://api.data.gov/docs/developer-manual/>
