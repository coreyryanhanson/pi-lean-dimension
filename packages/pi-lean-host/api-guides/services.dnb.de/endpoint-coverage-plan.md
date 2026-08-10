# DNB (services.dnb.de) API — Endpoint Coverage Plan

> Drafted 2026-07-25 against the [SRU documentation page](https://www.dnb.de/EN/Professionell/Metadatendienste/Datenbezug/SRU/sru_node.html),
> [OAI documentation page](https://www.dnb.de/EN/Professionell/Metadatendienste/Datenbezug/OAI/oai_node.html),
> and [Linked Data Service page](https://www.dnb.de/EN/Professionell/Metadatendienste/Datenbezug/LDS/lds_node.html)
> (all verified by `web-fetch` on 2026-07-25). Implements the read-only
> endpoints the current `guide.md` does not yet cover.

## Status quo

`guide.md` declares **1 of 8** documented read-only endpoints that are in scope for `services.dnb.de`:

| Operation | Path | Protocol |
|-----------|------|----------|
| `searchZdb` | `/sru/zdb` | SRU |

The guide covers only the ZDB serials catalogue via SRU. The same SRU
interface serves **three more catalogues** (DNB main catalogue, German
Music Archive, GND authorities) and the DNB also exposes **OAI-PMH**
(6 verbs) and **Entity Facts** (1 lookup) — all read-only research
interfaces.

## Verification (2026-07-25)

Fetched the three documentation pages above. Below is the full endpoint
inventory with ✅/❌ per row.

### A. SRU catalogues (`services.dnb.de` — already covered, expand)

| # | Operation | Path | In scope | Reason if dropped |
|---|-----------|------|----------|-------------------|
| 1 | `searchZdb` | `GET /sru/zdb` | ✅ existing | Already in `guide.md` |
| 2 | `searchDnb` | `GET /sru/dnb` | ✅ **new** | DNB main catalogue (bibliographic data, no GND) |
| 3 | `searchDma` | `GET /sru/dnb.dma` | ✅ **new** | German Music Archive catalogue |
| 4 | `searchAuthorities` | `GET /sru/authorities` | ✅ **new** | GND Integrated Authority File |

**Shape identical to existing `searchZdb`** — all four use the same SRU
protocol, same params (`version`, `operation`, `query`, `recordSchema`,
`maximumRecords`, `startRecord`), same response format (XML), same
pagination (`offset-limit` via `startRecord`/`maximumRecords`), same
`itemsPath`. Only the path differs.

### B. OAI-PMH (`services.dnb.de` — entirely missing)

Base URL: `https://services.dnb.de/oai/repository`

The OAI-PMH interface has 6 verbs. All are read-only (metadata harvesting).

| # | Verb | Path | In scope | Reason if dropped |
|---|------|------|----------|-------------------|
| 5 | `Identify` | `GET /oai/repository?verb=Identify` | ✅ **new** | Repository metadata (name, admin email, protocols) |
| 6 | `ListSets` | `GET /oai/repository?verb=ListSets` | ✅ **new** | Enumerate available catalogues/sets |
| 7 | `ListMetadataFormats` | `GET /oai/repository?verb=ListMetadataFormats` | ✅ **new** | Available metadata formats |
| 8 | `GetRecord` | `GET /oai/repository?verb=GetRecord` | ✅ **new** | Single record by identifier |
| 9 | `ListRecords` | `GET /oai/repository?verb=ListRecords` | ✅ **new** | ResumptionToken pagination — now supported via `resumptionToken` style |
| 10 | `ListIdentifiers` | `GET /oai/repository?verb=ListIdentifiers` | ✅ **new** | Same pagination as `ListRecords` |

**Now supported:** `ListRecords` and `ListIdentifiers` use OAI-PMH
resumptionToken pagination, added as a core `PaginationStyle` in the
framework. Both are declared in `guide.md` with
`style: resumptionToken`, `tokenParam: resumptionToken`, and
`tokenPath: OAI-PMH.List{Records,Identifiers}.resumptionToken.#text`.

**Known caveat:** the OAI-PMH spec requires `resumptionToken` to be the
only argument besides `verb` on subsequent requests. The current paginator
sends all original params plus the token on every page. Strict OAI-PMH
servers may reject this with `badResumptionToken`; a paginator enhancement
to drop non-`verb` params on resume may be needed if DNB enforces the rule.

Verbs 5-8 are single-response operations: `via: restGet`, no pagination.
`Identify` / `ListSets` / `ListMetadataFormats` need zero params; `GetRecord`
needs `identifier` (required); `metadataPrefix` defaults to `MARC21-xml`.

### C. Entity Facts (`hub.culturegraph.org` — separate host)

Base URL: `https://hub.culturegraph.org/entityfacts/{gnd_id}`

| # | Operation | Path | In scope | Reason if dropped |
|---|-----------|------|----------|-------------------|
| 11 | `getEntityFacts` | `GET /entityfacts/{gnd_id}` | ⛔ separate host | Hosted at `hub.culturegraph.org`, not `services.dnb.de`. Needs its own api-guide. |

**Why separate guide:** The `guide.md` has `apiHost: https://services.dnb.de`.
Entity Facts lives on a different host. It's a simple single-parameter
GET that returns JSON-LD, so a minimal guide is straightforward, but
it's out of scope for *this* guide's expansion.

### D. Linked Data Service / SPARQL (BETA)

The [DNB SPARQL Service](https://wiki.dnb.de/x/lZvQGg) is a SPARQL
query endpoint. SPARQL `SELECT` queries are read-only but require a raw
query string that doesn't map to the declarative operation schema. Not
recommended for addition; if agent SPARQL access is needed, a dedicated
`sparql` helper would be more appropriate.

## Grouping for implementation

### Family 1 — SRU catalogue searches (phases 1-3)

All three new SRU catalogues are **identical in shape** to the existing
`searchZdb`. Each new operation is a copy of `searchZdb` with a different
`path` and `name`:

```yaml
- name: searchDnb          # Phase 1 — highest value (main catalogue)
  via: paginate
  path: /sru/dnb
  accept: xml
  pagination:
    style: offset-limit
    itemsPath: searchRetrieveResponse.records.record
    pageParam: startRecord
    pageSizeParam: maximumRecords
    pageSize: 2
  params:
    version:
      description: SRU protocol version.
      default: "1.1"
    operation:
      description: SRU operation.
      default: searchRetrieve
    query:
      description: CQL query. Works with bare terms and indexed queries (unlike ZDB).
      required: true
    recordSchema:
      description: Record schema (oai_dc, MARC21-xml, RDFxml, etc.).
      default: oai_dc
- name: searchDma          # Phase 2 — German Music Archive
  path: /sru/dnb.dma
  # (same shape as searchDnb)
- name: searchAuthorities  # Phase 3 — GND authority data
  path: /sru/authorities
  # (same shape as searchDnb, but note entity-restriction param BBG)
```

Key difference from `searchZdb`: the DNB main catalogue and authorities
**do** support indexed CQL queries (e.g. `SW=Goethe`), unlike ZDB which
requires bare terms. The `query` param description should reflect this.

### Family 2 — OAI-PMH single-request verbs (phase 4)

Four single-response verbs, all on `/oai/repository`:

```yaml
- name: oaiIdentify
  via: restGet
  path: /oai/repository
  accept: xml
  params:
    verb:
      description: OAI-PMH verb.
      default: Identify
- name: oaiListSets
  via: restGet
  path: /oai/repository
  accept: xml
  params:
    verb:
      description: OAI-PMH verb.
      default: ListSets
- name: oaiListMetadataFormats
  via: restGet
  path: /oai/repository
  accept: xml
  params:
    verb:
      description: OAI-PMH verb.
      default: ListMetadataFormats
- name: oaiGetRecord
  via: restGet
  path: /oai/repository
  accept: xml
  params:
    verb:
      description: OAI-PMH verb.
      default: GetRecord
    identifier:
      description: OAI identifier of the record (e.g. `oai:dnb.de/authorities/118540238`).
      required: true
    metadataPrefix:
      description: Metadata format (e.g. `MARC21-xml`, `oai_dc`). Required by OAI-PMH; defaults to `MARC21-xml`.
      default: MARC21-xml
```

All four are XML responses. No pagination needed.

## Implementation phases

### Phase -1 — Cache specs locally

Not needed. Documentation pages are small and statically rendered; the
live documentation URLs are stable and reliable.

### Phase 1 — Add `searchDnb` (DNB main catalogue)

Copy `searchZdb` with `path: /sru/dnb`, update `query` description to
note indexed queries work. Highest value — the DNB main catalogue is
the primary bibliographic database.

### Phase 2 — Add `searchDma` (German Music Archive)

Same shape as `searchDnb`, path `/sru/dnb.dma`. Lower priority — DMA is
a specialised music catalogue.

### Phase 3 — Add `searchAuthorities` (GND authority data)

Same shape as `searchDnb`, path `/sru/authorities`. Add optional param
`BBG` for entity type restriction (e.g. `BBG=Tp*` for persons).

Docs reference for entity qualifiers:

- `Tp` — Person
- `Tg` — Geographical entity
- `Tf` — Corporate body
- `Ts` — Subject term
- `Tu` — Work
- `Tb` — Congress/event

### Phase 4 — Add OAI-PMH single-request verbs

Add `oaiIdentify`, `oaiListSets`, `oaiListMetadataFormats`, `oaiGetRecord`.
All `via: restGet`, XML responses. `oaiGetRecord` has a required
`identifier` param; `metadataPrefix` defaults to `MARC21-xml`.

No helper code needed — none of the new endpoints require transforms
beyond what `restGet` and `paginate` already provide.

## Testing

Follow the boe.es pattern — tests co-located with the guide:

- **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated live coverage:
  parses the guide, executes **every** defined operation against the live
  endpoint, asserts status 200 + non-empty body. Extend this file with
  one assertion per newly added operation.

  Minimal queries for paginated endpoints:
  - `searchDnb`: `query=Leipzig`
  - `searchDma`: `query=Leipzig`
  - `searchAuthorities`: `query=WOE=Goethe`
  - `oaiGetRecord`: `identifier=oai:dnb.de/authorities/118540238&metadataPrefix=MARC21-xml`

- **`helper.test.ts`** — Not needed; no `helper.ts` changes required.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 9 new operations (3 SRU + 4 OAI-PMH single-request + 2 OAI-PMH resumptionToken) |
| `helper.ts` | None |
| `endpoint-coverage.test.ts` | **Create** — live coverage tests |
| `helper.test.ts` | None |
| `spec/` | Not needed |

## Out of scope / deliberate omissions

- **Entity Facts** (`hub.culturegraph.org`) — separate host; merits its
  own minimal api-guide if GND entity lookups become a frequent ask.
- **Linked Data Service / SPARQL** — raw SPARQL queries don't map to
  the declarative operation schema. Not suitable for the current
  framework without a dedicated `sparqlQuery` helper.
- **Write/mutation endpoints** — DNB's data submission (online
  publications delivery, SFTP) is out of scope for a research aide.

## Implementation notes (2026-08-07)

All 7 planned operations shipped with no deviation from the frozen plan's
names/paths/params. `guide.md` now declares **10 ops** (3 SRU + 4 OAI
single-request + 2 OAI resumptionToken + existing `searchZdb`).
`endpoint-coverage.test.ts` created (11 tests: 10 op-asserts + 1 parse
baseline). Bare CI green (live tests `it.skip`); `HOST_INTEGRATION=1`
11/11 live green; `npm run test:ci` green (933 passed).

Key findings recorded for the next implementer:

- **`resumptionToken` strict-server risk REFUTED.** The rollout doc's
  known caveat (paginator re-sends all original params + token on page 2+;
  strict OAI-PMH servers may reply `badResumptionToken`) was probed live
  with `probe-op.ts --gatherAll`: DNB accepts page 2 with
  `metadataPrefix`/`set`/`from`/`until` + `resumptionToken` and returns
  records normally. **No paginator enhancement needed.**
- **OAI single-verb XML nests under an `OAI-PMH` root** in the parsed
  JSON (fast-xml-parser), so assertions dereference `data["OAI-PMH"].<Verb>`
  — not `<Verb>` at the top level. (The `resumptionToken` ops' `itemsPath`
  already accounted for this via `OAI-PMH.ListRecords.record`.)
- **Unbounded OAI harvests 413.** A `ListRecords`/`ListIdentifiers` request
  with no `from`/`until` window returns HTTP 413 (DNB caps responses at
  100k records; a single day ≈ 170k). Tests bound both resumptionToken ops
  with a narrow window (`2026-08-05T00:00:00Z` → `00:05:00Z`). The only
  top-level set is `dnb` (the whole catalogue), so tests don't pass `set`.
- **`searchDnb`/`searchAuthorities` indexed queries verified live**
  (`SW=Goethe`, `WOE=Goethe`) — unlike ZDB, the DNB main catalogue and GND
  authorities accept indexed CQL queries.
- **No helper needed** — `helper.ts` / `helper.test.ts` untouched, per plan.
