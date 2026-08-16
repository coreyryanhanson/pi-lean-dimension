---
kind: api
schemaVersion: 0
domains:
  - ncbi.nlm.nih.gov
shortName: PubMed E-utilities
icon: 📚
apiHost: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
auth:
  kind: static-key
  secretQueryRefs:
    api_key: api_key
  optional:
    - api_key
responseShape:
  format: xml
  charset: utf-8
verified: "2026-08-15"
docs: https://www.ncbi.nlm.nih.gov/books/NBK25499/
operations:
  - name: esearch
    via: paginate
    path: /esearch.fcgi
    accept: xml
    gatherAllMax: 1000
    pagination:
      style: offset-limit
      itemsPath: eSearchResult.IdList.Id
      pageParam: retstart
      pageSizeParam: retmax
      pageSize: 10
      totalCountPath: eSearchResult.Count
    params:
      db:
        description: Entrez database. Defaults to pubmed.
        default: pubmed
      term:
        description: >
          The search query (PubMed query syntax — field tags in [brackets],
          boolean AND/OR/NOT, quoted phrases, e.g. `"clustered regularly
          interspaced short palindromic repeats"[MeSH Terms]` or a unique
          DOI `"10.1038/s41586-020-2649-2"[doi]`).
        required: true
      retstart:
        description: 0-based offset of the first result to return (paging).
        default: 0
      retmax:
        description: Number of PMIDs to return per page (this op's wire value is set by the guide's pageSize — 10).
        default: 10
      retmode:
        description: >
          xml (default) | json. Note the JSON shape uses a different
          itemsPath (`esearchresult.idlist`), so `retmode=json` breaks this
          op's XML pagination — keep the default xml here. Use `retmode=json`
          on `esummary`/`efetch`/`elink` for compact JSON instead.
        default: xml
      rettype:
        description: uilist (PMIDs) | count (Count only).
        default: uilist
      sort:
        description: Sort order (e.g. relevance, pub_date).
      datetype:
        description: Type of date to restrict (edat | pdat | mdat).
      reldate:
        description: Restrict results to the last N days.
      mindate:
        description: 'Earliest date (format depends on datetype/maxdate: yyyy, yyyy/mm, yyyy/mm/dd).'
      maxdate:
        description: 'Latest date (same formats as mindate).'
      field:
        description: Search field abbreviation (e.g. ti, au, affl).
      idtype:
        description: UID type to return (acc | oai | pubmed — pubmed default).
      tool:
        description: Name of the requesting application (usage policy — include it).
      email:
        description: Contact email for the application (usage policy — include it).

  - name: esearch-raw
    via: restGet
    path: /esearch.fcgi
    accept: xml
    params:
      db:
        description: Entrez database. Defaults to pubmed.
        default: pubmed
      term:
        description: The search query (same PubMed query syntax as `esearch`).
        required: true
      usehistory:
        description: >
          When `y`, ESearch posts the result set to the Entrez History server
          and the response's `eSearchResult` carries a `WebEnv` + `QueryKey`.
          Capture both and pass them to `esummary`/`efetch` as `WebEnv` +
          `query_key` (replacing `id`) for the stateful two-step flow — the
          A3 opaque-token session pattern. The tokens are public (not
          secrets). This is a single-shot call (not paginated); use the
          paginated `esearch` op to step through a result list.
        default: n
      retmax:
        description: >
          Number of UIDs returned in this response. With `usehistory=y` the
          full result set is stored on the History server (up to 10,000);
          retmax only bounds this response, not the stored set.
        default: 10
      retmode:
        description: xml (default) | json. Keep xml so the History tokens parse into the standard shape.
        default: xml
      tool:
        description: Name of the requesting application (usage policy — include it).
      email:
        description: Contact email for the application (usage policy — include it).

  - name: esummary
    via: restGet
    path: /esummary.fcgi
    accept: xml
    params:
      db:
        description: Entrez database. Defaults to pubmed.
        default: pubmed
      id:
        description: >
          Comma-delimited list of PMIDs (≤ ~200) to summarize — the stateless
          input. OR pass the `query_key` + `WebEnv` from a `usehistory=y`
          `esearch-raw` to summarize the stored result set instead. Provide
          one or the other (a bare call with neither reaches NCBI with no
          input and gets a server-side error).
      query_key:
        description: >
          Stateful input — the History-server query key returned by a
          `usehistory=y` `esearch-raw`. Must be paired with `WebEnv`; omit
          `id`.
      WebEnv:
        description: >
          Stateful input — the Web environment string returned by a
          `usehistory=y` `esearch-raw`. Must be paired with `query_key`; omit
          `id`.
      version:
        description: '1.0 (DocSum list) | 2.0 (richer DocumentSummarySet). Default 1.0.'
        default: "1.0"
      retmode:
        description: xml (default) | json. JSON is compact and convenient for a single record.
        default: xml
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).

  - name: efetch
    via: restGet
    path: /efetch.fcgi
    accept: xml
    params:
      db:
        description: Entrez database. Defaults to pubmed.
        default: pubmed
      id:
        description: >
          Comma-delimited list of PMIDs (≤ ~200) to fetch full records for —
          the stateless input. OR pass the `query_key` + `WebEnv` from a
          `usehistory=y` `esearch-raw` to fetch the stored result set instead.
          Provide one or the other.
      query_key:
        description: >
          Stateful input — the History-server query key returned by a
          `usehistory=y` `esearch-raw`. Must be paired with `WebEnv`; omit
          `id`.
      WebEnv:
        description: >
          Stateful input — the Web environment string returned by a
          `usehistory=y` `esearch-raw`. Must be paired with `query_key`; omit
          `id`.
      retmode:
        description: xml (default) | text.
        default: xml
      rettype:
        description: 'For db=pubmed retmode=xml: abstract | medline | uilist | … (per-db table). Plain text (abstract/medline) uses retmode=text.'
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).

  - name: elink
    via: restGet
    path: /elink.fcgi
    accept: xml
    params:
      dbfrom:
        description: Database the input UIDs come from. Defaults to pubmed.
        default: pubmed
      db:
        description: Database to link to. Defaults to pubmed.
        default: pubmed
      id:
        description: Comma-delimited list of input UIDs.
        required: true
      cmd:
        description: >
          Command: neighbor (default) | neighbor_score | acheck | ncheck |
          lcheck | llinks | llinkslib | prlinks. Default neighbor returns the
          related-record links.
        default: neighbor
      linkname:
        description: Restrict links to a named link (e.g. pubmed_pubmed, pubmed_pmc_refs).
      term:
        description: Restrict linked UIDs to those matching a query.
      retmode:
        description: xml (default) | json.
        default: xml
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).

  - name: espell
    via: restGet
    path: /espell.fcgi
    accept: xml
    params:
      db:
        description: Entrez database to check spelling in. Defaults to pubmed.
        default: pubmed
      term:
        description: The (possibly misspelled) query to check.
        required: true
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).

  - name: einfo
    via: restGet
    path: /einfo.fcgi
    accept: xml
    params:
      db:
        description: >
          Entrez database to describe (e.g. pubmed → `eInfoResult.DbInfo` with
          field/link lists). Omit to list all databases (`eInfoResult.DbList.DbName`).
      retmode:
        description: xml (default) | json.
        default: xml
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).

  - name: ecitmatch
    via: restGet
    path: /ecitmatch.cgi
    accept: text/plain
    parse:
      format: text
      charset: utf-8
    params:
      db:
        description: Database to search. Only pubmed is supported.
        default: pubmed
      retmode:
        description: >
          Must be `xml` (the only supported value) — this returns the matched
          PMIDs as plain-text lines (raw `parse.format: text` passthrough, not
          XML). Without `retmode=xml` NCBI serves the batch-citation-matcher
          HTML page instead.
        default: xml
      bdata:
        description: >
          Pipe-delimited citation strings
          (`journal|year|volume|first_page|author|key|`), `+`-separated words,
          one per line (`%0D` between lines), each ending in a final `|`. The
          response echoes each input line with the matched PMID appended
          (`…|key|PMID`).
        required: true
      tool:
        description: Name of the requesting application (usage policy).
      email:
        description: Contact email for the application (usage policy).
---
# PubMed E-utilities — read-only literature access

Read-only access to the NCBI Entrez Programming Utilities (E-utilities) for
`db=pubmed` — search, summarize, fetch, and link biomedical literature.
Unauthenticated by default; an optional `api_key` raises the rate ceiling when
provisioned. The API is a set of `.fcgi` utilities under
`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`; every guide op is a single
request to one utility (see the E-utilities docs
<https://www.ncbi.nlm.nih.gov/books/NBK25499/>).

## Operations

### `esearch` — Search PubMed → PMID list + total count

Paginated search. Returns up to `pageSize` (10) PMIDs per page in
`eSearchResult.IdList.Id`; `eSearchResult.Count` surfaces the **total hit
count** as `serverTotal`. Offset-limit pagination via `retstart`/`retmax`;
an empty `<IdList/>` past the last result terminates the walk. A page with a
**single** `<Id>` is normalized to a one-element array (the design-doc A1 fix
— proven live by a unique-DOI query that returns exactly one PMID).

**Efficient search→records flow:** call `esearch` first with
`rettype=count` for the hit count, or the paginated form for a specific
page of PMIDs, then feed those PMIDs to `esummary` (metadata) or `efetch`
(full records).

### `esearch-raw` — single-shot search returning the raw result set

`GET /esearch.fcgi` run **once** (not paginated), returning the whole
`eSearchResult` body as `data`. With `usehistory=y` the body carries a
`WebEnv` + `QueryKey` — capture them for the two-step History flow (below).
Use the paginated `esearch` op when you just want to step through a result
list page by page.

### `esummary` — Document summaries for a PMID list

`GET /esummary.fcgi?db=pubmed&id=<PMIDs>` returns one `DocSum` per PMID
(`eSummaryResult.DocSum`; each has `Id`, `PubDate`, `Source`, `AuthorList`,
`Title`, `Volume`, `Pages`…). Pass `version=2.0` for the richer
`DocumentSummarySet` shape; `retmode=json` for compact JSON. Best for
batch metadata (titles + authors) before deciding which records to fetch in
full.

### `efetch` — Full records for a PMID list

`GET /efetch.fcgi?db=pubmed&id=<PMIDs>` returns full formatted PubMed
records (`PubmedArticleSet.PubmedArticle` in XML; use `rettype=abstract` +
`retmode=xml` for abstracts, `retmode=text`+`rettype=medline` for raw
MEDLINE). Heavier than `esummary` — prefer summaries for reconnaissance,
records for the final read list.

### `elink` — Related/linked UIDs

`GET /elink.fcgi?dbfrom=pubmed&db=pubmed&id=<PMID>` returns the input UID
echo (`LinkSet.IdList.Id`) plus linked records in `LinkSet.LinkSetDb.Link.Id`
(cmd=neighbor default). Useful for "related articles" and cross-database
links (e.g. `db=pmc` for full-text records). The response is a single object
per request — the whole body is returned.

### `espell` — Spelling suggestions

`GET /espell.fcgi?db=pubmed&term=<query>` checks a query for spelling variants
and returns `eSpellResult.CorrectedQuery` plus a `SpelledQuery` diff. Paired
with `esearch`: when a search returns few hits, run the raw term through
`espell` to catch a misspelling before rewriting the query.

### `einfo` — Database/field metadata

`GET /einfo.fcgi?db=pubmed` returns `eInfoResult.DbInfo` — record count,
build date, and the searchable field list (`FieldList`) and link list
(`LinkList`) for a database. Omit `db` to list every Entrez database
(`DbList.DbName`). Useful for discovering valid `field`/`datetype` values
before crafting an `esearch` query.

### `ecitmatch` — Batch citation matching

`GET /ecitmatch.cgi?db=pubmed&retmode=xml&bdata=<citations>` matches a set of
bibliographic citation strings to PMIDs (the API behind PubMed's batch
citation matcher). The response is **plain text** (Content-Type
`text/plain`), so this op declares `parse.format: text` for raw passthrough:
one output line per input citation — the citation echoed back with the matched
PMID appended (`…|key|PMID`). Unmatched citations come back with no PMID.

## Stateful two-step flow (History server) — A3

For an entire search set that exceeds a single page, or to retrieve records
for the whole set in one `esummary`/`efetch` call, use the History-server
two-step flow (the A3 opaque-token session pattern). The tokens are
**public** — no store, no core change; they are plain params passed back.

1. `esearch-raw` with `usehistory=y` → the response's `eSearchResult` carries
   a `WebEnv` + `QueryKey` (NCBI stored your *search results*, not arbitrary
   data).
2. Pass `query_key` + `WebEnv` to `esummary`/`efetch` — **instead of** `id` —
   to summarize or fetch the stored record set.

The set lives on NCBI's History server for at least 8 hours. `epost` (the
only way to stash a hand-picked, non-search UID list) is **excluded** as a
pure mutation — see below.

## Excluded — outside read-only scope, or dead

Everything else the E-utilities docs surface is dropped with a stated reason
per the plan's "be comprehensive, never silent" rule:

- **EGQuery** (`egquery.fcgi`, cross-database record counts) — **publicly dead
  link**. The current NCBI docs still document it — E-utilities Help, Chapter
  4, "The E-utilities In-Depth"
  (<https://www.ncbi.nlm.nih.gov/books/NBK25499/>), EGQuery base URL
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/egquery.fcgi` — but the live
  endpoint is gone.

  **Status (verified 2026-08-12):** the documented URL returns a permanent
  HTTP 301 redirect to an **internal** host,
  `https://ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery?…` (observed on
  every probe, including the docs' own example `?term=asthma`). The
  `linkerd.ncbi.nlm.nih.gov` name is NCBI's internal service-mesh host — not
  resolvable from the public internet — so the documented endpoint is
  effectively decommissioned (moved behind NCBI's linkerd mesh with no public
  replacement URL advertised).

  **Evidence:** [NCBI E-utilities Help, EGQuery chapter](
  https://eutils.ncbi.nlm.nih.gov/entrez/eutils/egquery.fcgi) — documented
  URL; live probe 2026-08-12, HTTP 301
  `Location: https://ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery?term=asthma&retmode=xml`.
  Archived/documented-at: cached at `spec/eutilities-indepth.md` EGQuery.
  This guide does **not** ship an `egquery` op because no public URL answers;
  revisit if NCBI re-publishes a public EGQuery endpoint.

- **EPost** (`epost.fcgi`) — **excluded** — uploads an **arbitrary UID list
  you supply** to the History server. It is the only path to stash a
  hand-picked set built without a search, and its entire purpose is a pure
  mutation (the response is just the `WebEnv`/`query_key` tokens identifying
  the uploaded set — nothing is retrieved). Its History-server role is fully
  covered by `usehistory=y` on `esearch`, so dropping it costs the read-only
  surface nothing. Not information retrieval → read-only-only rule.

  The `usehistory=y` **two-step flow** *is* in scope (stateful sessions, A3):
  `esearch-raw` with `usehistory=y` posts the **search results** to the
  History server as a side effect — the primary action is still a read — and
  returns the public `WebEnv`/`query_key` tokens, which `esummary`/`efetch`
  then accept in place of `id`. The tokens are not secrets; there is no
  store involvement.
- **HTTP POST variants** — a transport choice for the same GET endpoints, not
  a separate family; this guide uses GET.

## Rate / usage notes

- **Rate limit:** 3 requests/second without an API key, 10/s with one (NCBI
  usage policy, E-utilities Chapter 2; observed `x-ratelimit-limit: 3`
  2026-08-12). Space calls out — keep coverage tests to a small number of
  tiny requests (small `retmax`/`retstart`, few PMIDs).
- **`tool` + `email`** params are recommended on every call (usage policy).
- **Optional auth:** no key required. The optional `api_key` only raises the
  rate ceiling (3/s → 10/s). Provision it in the secrets store at
  `ncbi.nlm.nih.gov` as `api_key` (`/api secrets ncbi.nlm.nih.gov
  api_key <value>`); when provisioned it is injected onto the query string
  and **redacted from every surfaced URL** (`?api_key=***`) — it never
  appears in the returned params map.
- Underlying content: PubMed/MEDLINE is copyrighted — see NCBI's usage
  policy for citation/reuse terms.

## Terms

NCBI E-utilities usage — see <https://www.ncbi.nlm.nih.gov/books/NBK25497/#chapter2.Usage_Policy_and_Disclaimer>.
