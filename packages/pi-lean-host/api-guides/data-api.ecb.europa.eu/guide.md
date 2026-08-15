---
kind: api
domains:
  - ecb.europa.eu
shortName: ECB Data Portal
icon: 💶
apiHost: https://data-api.ecb.europa.eu/service
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
verified: "2026-08-12"
docs: https://data.ecb.europa.eu/help/api/overview
operations:
  - name: getData
    via: restGet
    path: /data/{flowRef}/{key}
    accept: xml
    params:
      flowRef:
        description: >
          The dataflow reference — `AGENCY_ID,FLOW_ID,VERSION` (comma
          separated), or just the flow id (agency `all`, version `latest`).
          E.g. `EXR` (exchange rates) or `ICP` (prices).
      key:
        description: >
          The series key — the value of each Dimension (in DSD order) joined
          with `.`, wildcarding by omission (`D..EUR.SP00.A`) and OR with `+`
          (`D.USD+JPY.EUR.SP00.A`). E.g. `M.USD.EUR.SP00.A` (nightly USD/EUR
          reference rate).
      format:
        description: >
          Response format. Default `genericdata` (SDMX-ML Generic Data XML —
          the prefix-everywhere profile). `structurespecificdata` gives the
          SDMX-ML Structure Specific sibling. (Use the `getDataJson` /
          `getDataCsv` ops for JSON / CSV.)
      startPeriod:
        description: >
          Start of the observation date range (ISO 8601 or SDMX reporting
          period, varies by dataflow frequency): `YYYY`, `YYYY-S1/S2`,
          `YYYY-Q1..Q4`, `YYYY-MM`, `YYYY-W01..W53`, `YYYY-MM-DD`.
      endPeriod:
        description: End of the observation date range (same formats as startPeriod).
      updatedAfter:
        description: >
          Percent-encoded ISO 8601 timestamp; returns only
          added/revised/deleted observations since then (delta retrieval).
      detail:
        description: >
          `full` (default: series+observations+attributes) | `dataonly` (no
          attributes) | `serieskeysonly` (series only) | `nodata`
          (series+attrs, no obs).
        default: full
      firstNObservations:
        description: Max observations per matching series, from the first.
      lastNObservations:
        description: Max observations per matching series, counting back from the most recent.
      includeHistory:
        description: '`false` (default, production only) | `true` (production + all previous versions).'

  - name: getDataJson
    via: restGet
    path: /data/{flowRef}/{key}
    accept: json
    parse:
      format: json
      charset: utf-8
    params:
      flowRef:
        description: The dataflow reference (`AGENCY_ID,FLOW_ID,VERSION` or bare flow id — see `getData`).
      key:
        description: The series key (DSD-ordered dimensions joined with `.` — see `getData`).
      format:
        description: Response format — SDMX-JSON compact. Fixed to `jsondata`.
        default: jsondata
      startPeriod:
        description: Start of the observation date range (see `getData`).
      endPeriod:
        description: End of the observation date range (see `getData`).
      firstNObservations:
        description: Max observations per matching series, from the first.
      lastNObservations:
        description: Max observations per matching series, counting back from the most recent.

  - name: getDataCsv
    via: restGet
    path: /data/{flowRef}/{key}
    accept: text/csv
    parse:
      format: text
      charset: utf-8
    params:
      flowRef:
        description: The dataflow reference (`AGENCY_ID,FLOW_ID,VERSION` or bare flow id — see `getData`).
      key:
        description: The series key (DSD-ordered dimensions joined with `.` — see `getData`).
      format:
        description: Response format — raw CSV. Fixed to `csvdata`.
        default: csvdata
      startPeriod:
        description: Start of the observation date range (see `getData`).
      endPeriod:
        description: End of the observation date range (see `getData`).
      firstNObservations:
        description: Max observations per matching series, from the first.
      lastNObservations:
        description: Max observations per matching series, counting back from the most recent.

  - name: listStructures
    via: restGet
    path: /{resource}
    accept: xml
    params:
      resource:
        description: >
          The structure artefact type to list — `dataflow`, `codelist`,
          `datastructure`, `categoryscheme`, `conceptscheme`, `agencyscheme`,
          `hierarchicalcodelist`, `organisationscheme`, `dataproviderscheme`,
          `dataconsumerscheme`, `organisationunitscheme`, `metadataflow`,
          `reportingtaxonomy`, `provisionagreement`, `structureset`, `process`,
          `categorisation`, `contentconstraint`, `attachmentconstraint`,
          `structure` (not all are currently used). List-all form: omit
          agencyID/resourceID/version.
      detail:
        description: >
          `full` (default) | `allstubs` (all artefacts as stubs) |
          `referencestubs` (referenced artefacts as stubs). A stub = id,
          agency id, version, name.
        default: full
      references:
        description: >
          Include/exclude dependent artefacts: `none` (default) | `parents` |
          `parentsandsiblings` | `children` | `descendants` | `all`; or a
          concrete resource type (e.g. `references=codelist`).
        default: none

  - name: getStructure
    via: restGet
    path: /{resource}/{agencyID}/{resourceID}/{version}
    accept: xml
    params:
      resource:
        description: >
          The structure artefact type — `dataflow`, `codelist`,
          `datastructure`, `categoryscheme`, `conceptscheme`, `agencyscheme`,
          `hierarchicalcodelist`, `organisationscheme`, `provisionagreement`,
          `structureset`, `process`, `categorisation`, `contentconstraint`,
          `attachmentconstraint`, `structure` (see `listStructures`).
      agencyID:
        description: The maintainer id (e.g. `ECB`).
      resourceID:
        description: >
          The artefact id (e.g. `CL_FREQ` codelist, `ECB_EXR1` DSD,
          `EXR` dataflow).
      version:
        description: >
          The artefact version — the full dotted string (e.g. `1.0`; `1`
          returns 404). The docs allow omitting it for latest, but this
          guide's path needs a value — discover it from `listStructures`
          (`@_version`).
      detail:
        description: '`full` (default) | `allstubs` | `referencestubs` (see `listStructures`).'
        default: full
      references:
        description: >
          Include/exclude dependent artefacts: `none` (default) | `parents` |
          `parentsandsiblings` | `children` | `descendants` | `all`; or a
          concrete resource type (e.g. `references=codelist`).
        default: none
---
# ECB Data Portal — SDMX 2.1 REST web service (read-only)

Read-only access to the European Central Bank's statistical data via the
SDMX 2.1 RESTful web service at
`https://data-api.ecb.europa.eu/service/` (docs:
<https://data.ecb.europa.eu/help/api/overview>). Fully **unauthenticated**
(no API key) and **read-only by construction** — the service is GET-only
with no write/mutation endpoints. High-value economics axis: exchange
rates (`EXR`), interest rates, money aggregates, prices, and more.

## Operations

### `getData` — SDMX-ML Generic Data (XML, default)

`GET /service/data/{flowRef}/{key}` returns observations for a series key /
dataflow as **SDMX-ML Generic Data** XML. The response is **prefix-everywhere**
(`message:GenericData`, `generic:Series`, `generic:Obs`, `common:Structure`
— a prefix on every element). The framework's `removeNSPrefix` (A2 fix)
strips those prefixes, so the parsed JSON uses clean local names and
`data.GenericData.DataSet.Series` resolves without literal colon-keys
(`message:DataSet…`) — proven live (see the design-doc B4 / A2 record).
Each response holds a single `<DataSet>` with one or more `generic:Series`,
each `SeriesKey` a list of `Attribute`-style `Value` objects
(`@_id`/`@_value` dimension codes) and each `Obs` an `ObsDimension` +
`ObsValue` pair.

**A1 is not exercised here** — the data resource returns a single
`<DataSet>` and the op is a single-shot `restGet` (no paging param), so the
A1 `paginate`-only fix does not apply. A1 is already proven on arXiv
(Sprint 2) + PubMed (Sprint 4).

### `getDataJson` — SDMX-JSON (compact JSON)

Same URL with `format=jsondata` returns compact SDMX-JSON: a `header`, then
`dataSets[].series` keyed by integer index
(`data.dataSets[0].series` → `{ "0:0:0:0:0": { observations: { "0": [value, …] } } }`).
Observations are keyed by index; the full dimension values that each index
stands for are recoverable via a separate structures reference (omitted in
compact form). Convenient when the agent wants JSON without XML parsing.

### `getDataCsv` — CSV (raw passthrough)

Same URL with `format=csvdata` returns **`text/csv`** — one row per
observation with the series key, dimension codes, `TIME_PERIOD`, and
`OBS_VALUE` as named columns (e.g. `EXR.M.USD.EUR.SP00.A,M,USD,EUR,…,2020-01,1.11,…`).
This op declares `parse.format: text` for **raw passthrough** — the body is
returned as a plain string and the agent splits/parses the CSV itself.

> `ponytail:` CSV is still riding the parked `format: text` raw-passthrough
> path here. Promoting it to a first-class built-in `ResponseFormat`
> (structured row/cell parsing) is **deferred** until a guide needs
> structured cell access beyond raw passthrough.

### `listStructures` — list structure artefacts (discovery entry)

`GET /service/{resource}` lists all artefacts of one type as SDMX-ML
`message:Structure`. With the `removeNSPrefix` fix the parsed shape is
prefix-free: `data.Structure.Structures.<Resource>` holds the list (e.g.
`…Structures.Dataflows.Dataflow` for `resource=dataflow`). Each item carries
`@_id`, `@_agencyID`, `@_version`, `Name`, and a `Structure.Ref` pointing at
the underlying datastructure. Use `detail=allstubs` for a compact id list.
This is the **discovery entry point** — list `dataflow` to find the flow ids
worth fetching.

### `getStructure` — a specific structure artefact

`GET /service/{resource}/{agencyID}/{resourceID}/{version}` retrieves one
artefact, e.g. `datastructure/ECB/ECB_EXR1/1.0` returns the EXR data
structure (DSD) defining the ordered dimension list that a valid series
`key` must follow, or `codelist/ECB/CL_FREQ/1.0` the frequency codes.
`version` must be the full dotted string (`1.0` — `1` returns 404);
`references` pulls in dependent artefacts (e.g. `references=codelist`).

## Pagination

None of the ops paginate (per the no-speculative-pagination rule, verified
live 2026-08-12). The data resource has **no paging parameter** — no
offset, no page, no `nextLink`. Volume is bounded instead via
`startPeriod`/`endPeriod` and `firstNObservations`/`lastNObservations`, so
each call is a single-shot `restGet`. Keep queries bounded (small
`startPeriod`–`endPeriod` windows) — a bare `{flowRef}` with an omitted
`key` returns the entire dataflow.

## Structure / metadata family

The service's second URL template
(`/service/{resource}/{agencyID}/{resourceID}/{version}` — 21 artefact
types: `dataflow`, `codelist`, `datastructure`, `categoryscheme`, …) is
also prefix-everywhere SDMX-ML, so the same `removeNSPrefix` proof holds.
It's shipped as two ops (the framework needs explicit path segments, so the
"omit id for list / include for by-id" forms are separate):
`listStructures` (the discovery entry) + `getStructure` (by-id). They close
the discovery loop for the data ops: `listStructures`/`getStructure` find
the flow ids + DSD dimension orders, then `getData*` fetches the observations.

## Rate / usage notes

- No documented rate limit (ECB help pages); still, keep coverage small and
  bounded via `startPeriod`/`endPeriod`.
- ECB's own examples disable SSL verification (`-k`); the harness transport
  verifies normally and works against this host (clean GET confirmed).
- The Data Portal **web app** (`data.ecb.europa.eu` — login/register, data
  cart, favourites) is a separate authenticated UI, not part of this API;
  out of scope.

## Terms

ECB Data Portal API — see <https://data.ecb.europa.eu/help/api/overview>.
