---
kind: api
schemaVersion: 0
domains:
  - gbif.org
shortName: GBIF
icon: 🧬
apiHost: https://api.gbif.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://techdocs.gbif.org/en/openapi/
operations:
  # ── Existing — browse the species checklist ───────────────────────
  - name: listSpecies
    via: paginate
    path: /v1/species
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      totalCountPath: count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      limit:
        description: Per-page count.
        default: 20

  # ── Group A — Species search & match ──────────────────────────────
  - name: searchSpecies
    via: paginate
    path: /v1/species/search
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      totalCountPath: count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      q:
        description: Full-text search query (required).
        required: true
      rank:
        description: Restrict to a taxonomic rank (SPECIES, GENUS, FAMILY, …).
      datasetKey:
        description: Restrict to a checklist dataset UUID.
      limit:
        description: Per-page count.
        default: 20
  - name: suggestSpecies
    via: restGet
    path: /v1/species/suggest
    accept: json
    params:
      q:
        description: Name autocomplete prefix (required).
        required: true
      limit:
        description: Max suggestions returned.
        default: 10
  - name: matchSpecies
    via: restGet
    path: /v2/species/match
    accept: json
    params:
      scientificName:
        description: Scientific name to match (required).
        required: true
      kingdom:
        description: Kingdom to constrain the match.
      phylum:
        description: Phylum to constrain the match.
      class:
        description: Class to constrain the match.
      order:
        description: Order to constrain the match.
      family:
        description: Family to constrain the match.
      genus:
        description: Genus to constrain the match.
      rank:
        description: Rank to constrain the match.
      verbose:
        description: When true, include richer match diagnostics.
  - name: matchSpeciesV1
    via: restGet
    path: /v1/species/match
    accept: json
    params:
      name:
        description: Scientific name to match (required).
        required: true
      rank:
        description: Rank to constrain the match (v1 legacy flat format).
  - name: lookupSpeciesId
    via: restGet
    path: /v2/species/match/id/{identifier}
    accept: json
  - name: lookupSpeciesJoin
    via: restGet
    path: /v2/species/match/joins/{identifier}
    accept: json

  # ── Group B — Species detail sub-resources ────────────────────────
  # All under /v1/species/{usageKey}/… via restGet. Those whose OpenAPI spec
  # declares an endOfRecords PagingResponse (synonyms, children, vernacular
  # names, media, related, distributions, descriptions, speciesProfiles,
  # references, typeSpecimens, identifiers) return a single page — the v1
  # paginator could walk them, but the plan marks them restGet initially.
  # ponytail: paginate these if endOfRecords truncation is observed in practice.
  - name: getSpecies
    via: restGet
    path: /v1/species/{usageKey}
    accept: json
  - name: getSpeciesVernacularNames
    via: restGet
    path: /v1/species/{usageKey}/vernacularNames
    accept: json
  - name: getSpeciesVerbatim
    via: restGet
    path: /v1/species/{usageKey}/verbatim
    accept: json
  - name: getSpeciesTypeSpecimens
    via: restGet
    path: /v1/species/{usageKey}/typeSpecimens
    accept: json
  - name: getSpeciesToc
    via: restGet
    path: /v1/species/{usageKey}/toc
    accept: json
  - name: getSpeciesSynonyms
    via: restGet
    path: /v1/species/{usageKey}/synonyms
    accept: json
  - name: getSpeciesProfiles
    via: restGet
    path: /v1/species/{usageKey}/speciesProfiles
    accept: json
  - name: getSpeciesRelated
    via: restGet
    path: /v1/species/{usageKey}/related
    accept: json
  - name: getSpeciesReferences
    via: restGet
    path: /v1/species/{usageKey}/references
    accept: json
  - name: getSpeciesParents
    via: restGet
    path: /v1/species/{usageKey}/parents
    accept: json
  - name: getSpeciesNameParsed
    via: restGet
    path: /v1/species/{usageKey}/name
    accept: json
  - name: getSpeciesMetrics
    via: restGet
    path: /v1/species/{usageKey}/metrics
    accept: json
  - name: getSpeciesMedia
    via: restGet
    path: /v1/species/{usageKey}/media
    accept: json
  - name: getSpeciesIucnStatus
    via: restGet
    path: /v1/species/{usageKey}/iucnRedListCategory
    accept: json
  - name: getSpeciesIdentifiers
    via: restGet
    path: /v1/species/{usageKey}/identifier
    accept: json
  - name: getSpeciesDistributions
    via: restGet
    path: /v1/species/{usageKey}/distributions
    accept: json
  - name: getSpeciesDescriptions
    via: restGet
    path: /v1/species/{usageKey}/descriptions
    accept: json
  - name: getSpeciesCombinations
    via: restGet
    path: /v1/species/{usageKey}/combinations
    accept: json
  - name: getSpeciesChildren
    via: restGet
    path: /v1/species/{usageKey}/children
    accept: json
  - name: getSpeciesAllChildren
    via: restGet
    path: /v1/species/{usageKey}/childrenAll
    accept: json

  # ── Group C — Root usages & name parser ───────────────────────────
  - name: getSpeciesRootUsages
    via: restGet
    path: /v1/species/root/{datasetKey}
    accept: json
  - name: parseSpeciesName
    via: restGet
    path: /v1/parser/name
    accept: json
    params:
      name:
        description: Scientific name to parse into its parts (required).
        required: true

  # ── Group D — Occurrence reads ────────────────────────────────────
  # Occurrence endpoints mount under /v1 (not /occurrence/…). The three
  # aggregate ops the audit table listed (metrics, distinctCount, inventory)
  # are NOT in the occurrence OpenAPI spec and 400 live — dropped.
  - name: getOccurrence
    via: restGet
    path: /v1/occurrence/{key}
    accept: json
  - name: searchOccurrences
    via: paginate
    path: /v1/occurrence/search
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      totalCountPath: count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      q:
        description: Free-text search over occurrence fields.
      taxonKey:
        description: Restrict to a species/nub usage key.
      country:
        description: Restrict to an ISO 3166-1 alpha-2 country code.
      limit:
        description: Per-page count.
        default: 20
  - name: getOccurrenceVerbatim
    via: restGet
    path: /v1/occurrence/{key}/verbatim
    accept: json
  - name: getOccurrenceFragment
    via: restGet
    path: /v1/occurrence/{key}/fragment
    accept: json
  - name: countOccurrences
    via: restGet
    path: /v1/occurrence/count
    accept: json
    params:
      taxonKey:
        description: Restrict the count to a species/nub usage key.
      country:
        description: Restrict the count to an ISO 3166-1 alpha-2 country code.

  # ── Group E — Literature ──────────────────────────────────────────
  - name: searchLiterature
    via: paginate
    path: /v1/literature/search
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      totalCountPath: count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      q:
        description: Free-text search query.
      limit:
        description: Per-page count.
        default: 20
  - name: getLiterature
    via: restGet
    path: /v1/literature/{uuid}
    accept: json
---
# GBIF — Species + Occurrence + Literature API

The GBIF (Global Biodiversity Information Facility) API exposes biodiversity
checklists, occurrence records, and literature with **no auth** (CC-BY 4.0 /
CC0 data). The recipe covers the three highest-value read-only sections:
Species (search + match + detail), Occurrence (search + single record), and
Literature (search + single record).

## Operations

### `listSpecies` — browse the species checklist

`GET /v1/species?limit=20` returns `{offset, limit, endOfRecords, results[]}`.
UUID `datasetKey`s identify checklists.

### Species search & match

- `searchSpecies` — full-text name-usage search, paged (`offset`/`limit`).
- `suggestSpecies` — name autocomplete; returns a bare suggestions array.
- `matchSpecies` (v2) — fuzzy match → `{usage, classification[], diagnostics
  {matchType, confidence}}`.
- `matchSpeciesV1` (v1) — legacy flat match → `{usageKey, matchType, …}`.
- `lookupSpeciesId` / `lookupSpeciesJoin` — external-ID lookup/join → an
  array of matches (`[]` when the identifier isn't indexed by GBIF's backbone).

### Species detail sub-resources

All under `GET /v1/species/{usageKey}/…`. Most return an
`{offset, limit, endOfRecords, results[]}` paging wrapper (a single page is
returned — see the `ponytail:` note in the frontmatter); `verbatim` needs a
source-dataset record (not all usage keys have one); `toc`, `name`, `metrics`,
`iucnRedListCategory` return objects; `parents`, `childrenAll`, `combinations`
return bare arrays.

### Root usages & parser

- `getSpeciesRootUsages` — root name usages of a checklist dataset.
- `parseSpeciesName` — parse a scientific name into its component parts.

### Occurrence reads

- `getOccurrence` / `getOccurrenceVerbatim` / `getOccurrenceFragment` — a
  single record by GBIF key (verbatim/fragment return the raw source record).
- `searchOccurrences` — paged (`offset`/`limit`, max 300/page; the API caps
  offset + limit at 100,000).
- `countOccurrences` — aggregate count for search filters; returns a bare
  number.

### Literature

- `searchLiterature` — paged (`offset`/`limit`).
- `getLiterature` — a single item by UUID.

## ⚠ Schema note — boolean pagination termination

`searchSpecies` / `searchOccurrences` / `searchLiterature` and the list-shaped
species sub-resources declare `endOfRecords: false|true` — a boolean, not a
cursor or next URL. The v1 `offset-limit` style decides exhaustion by "empty
page", so it cannot short-circuit on the boolean. Correct but imprecise; a
"keep going while bool" mode is the escape-valve generalization this recipe
evidences.

## Terms

GBIF data is CC-BY 4.0 (checklists/occurrences) and CC0 (some literature).
API: <https://www.gbif.org/developer/summary>
