---
kind: api
schemaVersion: 0
domains:
  - datos.gob.es
shortName: datos.gob.es
icon: 🇪🇸
apiHost: https://datos.gob.es
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: nextLink
  itemsPath: result.items
  nextLinkPath: result.next
verified: "2026-08-05"
docs: https://datos.gob.es/en/accessible-apidata
operations:
  - name: listDatasets
    via: paginate
    path: /apidata/catalog/dataset
    accept: json
    pagination:
      style: nextLink
      itemsPath: result.items
      nextLinkPath: result.next
    params:
      _pageSize:
        description: Per-page count (LDA uses the `_pageSize` param).
        default: 2

  # Group A — Dataset search/lookup (7 search filters + 1 single-item lookup)
  - name: getDatasetById
    via: restGet
    path: /apidata/catalog/dataset/{id}
    accept: json

  - name: searchDatasetsByTitle
    via: paginate
    path: /apidata/catalog/dataset/title/{title}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsByPublisher
    via: paginate
    path: /apidata/catalog/dataset/publisher/{id}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsByTheme
    via: paginate
    path: /apidata/catalog/dataset/theme/{id}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsByFormat
    via: paginate
    path: /apidata/catalog/dataset/format/{format}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsByKeyword
    via: paginate
    path: /apidata/catalog/dataset/keyword/{keyword}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsBySpatial
    via: paginate
    path: /apidata/catalog/dataset/spatial/{spatialWord1}/{spatialWord2}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  - name: searchDatasetsModifiedBetween
    via: paginate
    path: /apidata/catalog/dataset/modified/begin/{beginDate}/end/{endDate}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field, e.g. `title` (LDA `_sort` param).

  # Group B — Distribution endpoints (3 ops)
  - name: listDistributions
    via: paginate
    path: /apidata/catalog/distribution
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field (LDA `_sort` param).

  - name: searchDistributionsByDataset
    via: paginate
    path: /apidata/catalog/distribution/dataset/{id}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field (LDA `_sort` param).

  - name: searchDistributionsByFormat
    via: paginate
    path: /apidata/catalog/distribution/format/{format}
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
      _sort:
        description: Optional sort field (LDA `_sort` param).

  # Group C — Lookup tables (3 ops)
  - name: listPublishers
    via: paginate
    path: /apidata/catalog/publisher
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
  - name: listSpatial
    via: paginate
    path: /apidata/catalog/spatial
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
  - name: listThemes
    via: paginate
    path: /apidata/catalog/theme
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2

  # Group D — NTI public-sector taxonomy (2 ops)
  - name: listPublicSectors
    via: paginate
    path: /apidata/nti/public-sector
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
  - name: getPublicSectorById
    via: restGet
    path: /apidata/nti/public-sector/sector/{id}
    accept: json

  # Group E — NTI territory (5 ops)
  - name: listProvinces
    via: paginate
    path: /apidata/nti/territory/Province
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
  - name: getProvinceById
    via: restGet
    path: /apidata/nti/territory/Province/{id}
    accept: json
  - name: listAutonomousRegions
    via: paginate
    path: /apidata/nti/territory/Autonomous-region
    accept: json
    params:
      _pageSize:
        description: Per-page count (max 50).
        default: 2
  - name: getAutonomousRegionById
    via: restGet
    path: /apidata/nti/territory/Autonomous-region/{id}
    accept: json
  - name: getCountrySpain
    via: restGet
    path: /apidata/nti/territory/Country/España
    accept: json
---
# datos.gob.es — CKAN Linked-Data-API (G8: JSON-LD envelope)

The Spanish open-data portal exposes a Linked-Data-API (LDA) catalog with **no
auth**. Spanish public-sector re-use statute (Ley 37/2007) plus CC-BY per
dataset.

The API is a CKAN-style Linked-Data-API (LDA). Every list/search endpoint
shares the same envelope shape — `result.items`, `result.first`, `result.next`
for pagination — and the same query params (`_pageSize` max 50, `_page`
0-based, `_sort`). The envelope is RDF-ish JSON (items are resources with an
`_about` URI predicate), not plain REST records.

## Operations

### `listDatasets` — browse the catalog (JSON-LD envelope)

`GET /apidata/catalog/dataset.json?_pageSize=2` returns a Linked-Data-API
envelope — RDF-ish JSON, not plain REST:

```json
{
  "format": "linked-data-api",
  "version": "1.0",
  "result": {
    "first": "…/dataset.json?_page=0",
    "next": "http://datos.gob.es/apidata/catalog/dataset.json?_page=1",
    "items": [ { "_about": "http://…/dataset/…", "definition": "…" } ]
  }
}
```

`nextLinkPath: result.next`, `itemsPath: result.items`. Items are RDF resources
(`_about` URL predicate, `definition` linked-data field).

### Dataset search — `searchDatasetsBy{Title,Publisher,Theme,Format,Keyword,Spatial}` + `searchDatasetsModifiedBetween`

All under `/apidata/catalog/dataset/`. The path segment after `/dataset/` is
the filter criterion (title substring, publisher id, theme id, format token,
keyword, two spatial words, or an ISO modification-date window). All share
`listDatasets`' exact LDA envelope and nextLink pagination.

Path params (values are the last path segment of the corresponding resource
URL, or a docs-example token):

- `{id}` — dataset / publisher / theme identifier, e.g. `E05068001`,
  `hacienda`.
- `{title}` — title substring, e.g. `empleo` (partial matches allowed).
- `{format}` — format token (`csv`, `json`, `xml`, …) — a plain token, NOT a
  MIME type (`text/csv` → HTTP 400).
- `{keyword}` — tag, e.g. `salud`.
- `{spatialWord1}`/`{spatialWord2}` — geographic-scope words, e.g.
  `Autonomia`/`Pais-Vasco`.
- `{beginDate}`/`{endDate}` — ISO 8601 modification-window bounds, e.g.
  `2024-01-01` … `2024-12-31` (native format, no date transform needed).

### `getDatasetById` — single dataset

`GET /apidata/catalog/dataset/{id}` returns the same LDA envelope with one
item. The `id` is the last path segment of a dataset catalogue URL (e.g.
`e05068001-mapas-estrategicos-de-ruido`).

### Distributions — `listDistributions`, `searchDistributionsByDataset`, `searchDistributionsByFormat`

Distribution records (download URLs + formats) live under
`/apidata/catalog/distribution/` and share the same envelope. Search by parent
dataset id or by format token. Useful for finding download URLs and file
formats for a dataset.

### Lookup tables — `listPublishers`, `listSpatial`, `listThemes`

Controlled vocabularies under `/apidata/catalog/`, same LDA envelope. Note:
`listSpatial` is currently broken server-side: the endpoint 500s with `{E211}
Base URI is null, but there are relative URIs to resolve: <miteco-hvd>` — an
LDA serializer failure on a single corrupt vocabulary item on page 0 (its RDF
carries a relative URI with no base). Every format/param variant fails on page
0; `?_page=1` works. This is a datos.gob.es data bug, not a WAF block — the
endpoint is kept because it is documented, but it may fail live until the
portal fixes the `<miteco-hvd>` entry.

### NTI taxonomy — `listPublicSectors`, `getPublicSectorById` + territory

Annexes IV/V of the Spanish NTI (Technical Interoperability Regulation):
public-sector sectors and territory (province / autonomous-region / country).
The list endpoints return the same LDA envelope (paginated). The sector
single-resource lookup needs the mid-path `sector/` segment —
`/apidata/nti/public-sector/sector/{id}` — the docs' bare
`/public-sector/{id}` form returns 404. `getCountrySpain` is a fixed single
resource (`Country/España`).

## How G8 fires

The envelope itself is RDF-shaped: "the next page" is an `_about`/`next` URL,
and items are linked-data resources, not plain JSON records. Distinct from the
plain nextLink recipe (C2 LoC) because the *envelope structure* — not just the
next-page field — is the linked-data quirk. `itemsPath` and `parseResponse`
must tolerate predicate-keyed objects.

## Terms

Spanish public-sector re-use (Ley 37/2007) + CC-BY per dataset.
<https://datos.gob.es/en/accessible-apidata>
