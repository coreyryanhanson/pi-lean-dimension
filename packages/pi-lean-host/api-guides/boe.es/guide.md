---
kind: api
schemaVersion: 0
domains:
  - boe.es
  - www.boe.es
shortName: BOE
icon: 📜
apiHost: https://www.boe.es
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: offset-limit
  itemsPath: data
  pageParam: offset
  pageSizeParam: limit
  pageSize: 50
verified: "2026-07-19"
docs: https://www.boe.es/datosabiertos/api/api.php
operations:
  - name: listConsolidada
    via: paginate
    path: /datosabiertos/api/legislacion-consolidada
    accept: json
    helper: true
    dateParams:
      from: yyyymmdd
      to: yyyymmdd
    params:
      from:
        description: Start of last-update date range in aaaammdd form (a full day, e.g. 20250101). ISO YYYY-MM-DD is auto-converted by core dateParams.
      to:
        description: End of last-update date range in aaaammdd form (a full day). ISO YYYY-MM-DD is auto-converted by core dateParams.
      query:
        description: >
          Search term or BOE JSON query DSL. A plain string is wrapped as
          texto:<term> (matches the norm's indexed text tokens — sparse for
          broad phrases). For field-specific search pass a JSON OBJECT with
          the full DSL, e.g. {"query":{"query_string":{"query":"titulo:crisis"}}}.
          Fields: texto (full-text tokens), titulo, materia@codigo, fecha_publicacion (via range). Not deep body-text search.

  - name: getConsolidada
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}
    accept: xml
    parse:
      format: xml
      charset: utf-8

  - name: getSumario
    via: restGet
    path: /datosabiertos/api/boe/sumario/{fecha}
    accept: json
    helper: true

  - name: getSumarioBorme
    via: restGet
    path: /datosabiertos/api/borme/sumario/{fecha}
    accept: json
    helper: true

  # Group B — Consolidada sub-resources (6 endpoints)
  - name: getConsolidadaMetadatos
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/metadatos
    accept: json
  - name: getConsolidadaAnalisis
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/analisis
    accept: json
  - name: getConsolidadaMetadataEli
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/metadata-eli
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getConsolidadaTexto
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getConsolidadaTextoIndice
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto/indice
    accept: json
  - name: getConsolidadaTextoBloque
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto/bloque/{id_bloque}
    accept: xml
    parse:
      format: xml
      charset: utf-8

  # Group C — Auxiliary lookup tables (decode @codigo fields in listConsolidada results)
  - name: listMaterias
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/materias
    accept: json
  - name: listAmbitos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/ambitos
    accept: json
  - name: listEstadosConsolidacion
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/estados-consolidacion
    accept: json
  - name: listDepartamentos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/departamentos
    accept: json
  - name: listRangos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/rangos
    accept: json
  - name: listRelacionesAnteriores
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/relaciones-anteriores
    accept: json
  - name: listRelacionesPosteriores
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/relaciones-posteriores
    accept: json
---
# BOE — Agencia Estatal Boletín Oficial del Estado

The BOE (Boletín Oficial del Estado) open-data API provides access to Spanish
legislation and official gazette content. No authentication is required —
all endpoints are public.

## Operations

### `listConsolidada` — Search consolidated legislation

Returns a paginated list of consolidated legal norms matching the given
filters. Use offset/limit pagination to page through results.

**Parameters:** `from`, `to` (date range, aaaammdd format) and/or `query`.
All optional — omit to browse all entries.

`query` accepts a plain search string (the helper wraps it as a
`texto:<term>` full-text query in BOE's JSON DSL). For advanced search,
pass a JSON object with the full DSL — `query_string` (field:value
pairs like `titulo:crisis`, joined with `and`/`or`/parens), `range`
(date bounds), and `sort`. See the BOE API doc
(`datosabiertos/documentos/APIconsolidada.pdf`) for the full field list.

### `getConsolidada` — Get consolidated legislation by ID

Returns the full metadata for a single norm in XML format by its
identificador (e.g. `BOE-A-2021-21346`).

### Consolidada sub-resources — Metadata, analysis, and full text

Six endpoints hang off the same `{id}` path as `getConsolidada` and let
you retrieve specific aspects of a norm instead of the full XML body.

- **`getConsolidadaMetadatos`** (`/metadatos`) — metadata-only view in
  JSON. Use when you only need the norm's header fields (title, dates,
  department, status) without the entire XML body.
- **`getConsolidadaAnalisis`** (`/analisis`) — structural analysis in
  JSON: the norm's tree of articles, sections, and textual modifications.
- **`getConsolidadaMetadataEli`** (`/metadata-eli`) — ELI (European
  Legislation Identifier) scheme metadata. XML-only.
- **`getConsolidadaTexto`** (`/texto`) — the full consolidated text of
  the norm as XML. The heavy payload — prefer sub-resources when you
  only need metadata or a specific block.
- **`getConsolidadaTextoIndice`** (`/texto/indice`) — table of contents
  / index of the consolidated text in JSON: lists every block with its
  `id_bloque`, title, and hierarchy level. Use this to discover which
  block IDs are available before calling `getConsolidadaTextoBloque`.
- **`getConsolidadaTextoBloque`** (`/texto/bloque/{id_bloque}`) — a
  single text block by its `id_bloque` (obtained from the índice).
  Returns the block's XML. Use when you know which article or paragraph
  you need and want to avoid fetching the full text.

All share `getConsolidada`'s `{id}` path param (e.g.
`BOE-A-2021-21346`). Accept format varies per endpoint: the three JSON
endpoints are easier to consume for quick metadata/analysis lookups;
the three XML endpoints (metadata-eli, texto, texto/bloque) return the
canonical XML form.

### `getSumario` — Get BOE diary summary

Returns the full table of contents for a specific day's BOE edition.

**Path parameter:** `fecha` — the edition date in `aaaammdd` format. A
**full day is required** (e.g. `20250101`); month-level values like
`2025-01` or `202512` are rejected with `400 El parámetro fecha no
cumple el formato`. The helper converts `YYYY-MM-DD` → `aaaammdd`
automatically, but only for complete dates — pass a full day.

### `getSumarioBorme` — Get BORME diary summary

The BORME (Boletín Oficial del Registro Mercantil) is the Spanish
mercantile-registry gazette — company incorporations, appointments,
dissolutions, and other commercial registry filings. The endpoint shares
the same contract as `getSumario`: a full day in `aaaammdd` format,
`accept: json`, single path param `fecha`. Not every day is a BORME
publication day — non-publication dates return `404`.

**Path parameter:** `fecha` — the edition date in `aaaammdd` format. Same
requirements as `getSumario`. The helper converts `YYYY-MM-DD` →
`aaaammdd` automatically.

### Auxiliary tables — Decode `@codigo` fields in `listConsolidada` results

Seven flat-list endpoints return the controlled-vocabulary tables that
decode the `@codigo`-suffixed metadata fields in `listConsolidada`
results (e.g. `materia@codigo`, `departamento@codigo`,
`rango@codigo`, `estado_consolidacion@codigo`). Each returns a list
of `{codigo, texto}` pairs. No parameters, no pagination — simple
`GET` lookups.

- **Materias** — subject-matter tags assigned to each norm.
- **Ámbitos** — territorial scope (estatal vs. autonómica).
- **Estados de consolidación** — `F` (finalizado/up-to-date) or `D`
  (desactualizado/superseded).
- **Departamentos** — issuing bodies (ministerios, Cortes, CCAA…).
- **Rangos** — legal rank (ley, real decreto, orden…).
- **Relaciones anteriores** — relationship types for norms cited *by*
  this norm (deroga, modifica, etc.).
- **Relaciones posteriores** — relationship types for norms that
  cite *this* norm (SE DEROGA, SE AÑADE, etc.).

## Date format

All BOE date parameters use `aaaammdd` format — an 8-digit **full day**
(e.g. `20250101` for 1 Jan 2025). Month-level values (`202512`,
`2025-12`) are rejected. The `listConsolidada` operation declares
`dateParams: { from: "yyyymmdd", to: "yyyymmdd" }` so core parameter
serialization converts ISO dates (`YYYY-MM-DD`) to `aaaammdd`
automatically. The `getSumario` and `getSumarioBorme` operations use
`helper: true` (the accompanying `helper.ts`) to convert `fecha`
(a path param, which core `dateParams` can't reach) and wrap
`listConsolidada`'s `query` into BOE's JSON DSL.

## Query semantics

`listConsolidada`'s `query` searches **indexed fields, not deep body
text**. The plain-term form wraps as `texto:<term>`, which matches the
norm's indexed text tokens — useful for distinctive terms but sparse
for broad political concepts (e.g. "regularización masiva" may return
0 hits because the phrase isn't indexed as such). For field-specific
search, pass a JSON DSL object with `query_string.query` using a field
prefix:

- `texto:<term>` — indexed full-text tokens of the norm.
- `titulo:<term>` — title field only.
- `materia@codigo:<code>` — subject-matter code.
- `fecha_publicacion` — use the `range` block for date bounds.

Join terms with `and`/`or` and parens. See the BOE API doc
(`datosabiertos/documentos/APIconsolidada.pdf`) for the full field list.
For exhaustive topical search across the gazette (not just consolidated
legislation), use the `sumario` / diary endpoints instead of
`listConsolidada`.

## Pagination

`listConsolidada` uses offset-limit pagination with `offset` (0-indexed) and
`limit` (max results, default 50). Pass `gatherAll: true` to `api-fetch` to
accumulate all matching results up to the guide's configured ceiling.

## Terms

Data is provided under the BOE's re-use conditions. See
<https://www.boe.es/informacion/aviso_legal/index.php#reutilizacion>
