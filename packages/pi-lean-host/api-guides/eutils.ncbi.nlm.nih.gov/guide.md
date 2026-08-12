---
kind: api
domains:
  - eutils.ncbi.nlm.nih.gov
shortName: PubMed E-utilities
icon: 📚
apiHost: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
verified: "2026-08-12"
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

  - name: esummary
    via: restGet
    path: /esummary.fcgi
    accept: xml
    params:
      db:
        description: Entrez database. Defaults to pubmed.
        default: pubmed
      id:
        description: Comma-delimited list of PMIDs (≤ ~200 per request) to summarize.
        required: true
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
        description: Comma-delimited list of PMIDs (≤ ~200 per request) to fetch full records for.
        required: true
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
`db=pubmed` — search, summarize, fetch, and link biomedical literature. Fully
unauthenticated. The API is a set of `.fcgi` utilities under
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

- **EPost** (`epost.fcgi`) and **History-server input modes** (`usehistory`,
  `WebEnv`, `query_key`) — **mutate NCBI server state** (upload a UID set to
  the History server); not information retrieval, excluded by the
  read-only-only rule.
- **HTTP POST variants** — a transport choice for the same GET endpoints, not
  a separate family; this guide uses GET.

## Rate / usage notes

- **Rate limit:** 3 requests/second without an API key, 10/s with one (NCBI
  usage policy, E-utilities Chapter 2; observed `x-ratelimit-limit: 3`
  2026-08-12). Space calls out — keep coverage tests to a small number of
  tiny requests (small `retmax`/`retstart`, few PMIDs).
- **`tool` + `email`** params are recommended on every call (usage policy).
- **Unauthenticated:** no key required. The optional `api_key` param only
  raises the rate ceiling — not required for these read-only calls.
- Underlying content: PubMed/MEDLINE is copyrighted — see NCBI's usage
  policy for citation/reuse terms.

## Terms

NCBI E-utilities usage — see <https://www.ncbi.nlm.nih.gov/books/NBK25497/#chapter2.Usage_Policy_and_Disclaimer>.
