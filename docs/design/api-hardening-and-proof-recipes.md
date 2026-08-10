# API Core Hardening + Axis-Proof Recipes

> Drafted 2026-08-10. Follow-up to
> [`api-helper-escape-valve.md`](./api-helper-escape-valve.md)
> (~35 quirk classes classified). The endpoint-coverage audit it built
> on is complete — every shipped guide has a plan or completeness note
> in its own `endpoint-coverage-plan.md`.
>
> Round-2 research (live probes of no-auth APIs, 2026-08-10) found **three
> real internal-mechanics gaps** in the core that no shipped recipe forced
> yet. This plan fixes those gaps **and** ships recipes that exercise each
> fix end-to-end — a shape is only proven when a shipped recipe runs it
> against the live endpoint, not when a unit test fakes it.

## TL;DR

1. **Three core fixes:** XML single-record array normalization, namespaced-XML
   handling, Retry-After HTTP-date parsing. All small, all verified zero
   regression against existing XML recipes.
2. **Two proof recipes ship with them:** `arxiv.org` (forces the single-record
   fix on every `max_results=1` call — and is a compelling scholarly axis on
   its own) and `gitlab.com` (proves root-array + `page`-style pagination
   live, and settles the header-pagination question with evidence).
4. **A planned Batch 3 completes the proof:** PubMed E-utilities
   (single-record fix on a third independent API) and ECB SDMX
   (namespaced-XML hard proof) are a scheduled phase, not optional — and
   the first release waits for it (see "Batches & order").
5. **One recipe addendum:** DNB SRU's 200-OK `<diagnostics>` envelope that
   silently swallows errors.
4. **Parked with justification:** CSV response format; header-aware
   pagination style. Neither is built until a shipped recipe forces it.

## Background

The escape-valve doc classifies every quirk the 14 bundled recipes surface:
32 built-in, 6 local-helper. Its "when to upgrade" rules:
1. A second independent API exhibits the same quirk.
2. The fix is a small, well-understood change to a single function.
3. The local-helper workaround is fragile.

Round-2 research applied those rules by probing no-auth APIs live. Findings
below each carry the probe evidence and the verdict.

## Axis research summary (evidence)

| Axis | Live evidence (2026-08-10) | Verdict |
|------|---------------------------|---------|
| **A. Single-record XML boxing** | PubMed `esearch?retmax=1` → `<IdList><Id>42572859</Id>` parses to `{Id: scalar}`; `retmax=2` → array. arXiv `max_results=1` → exactly one `<entry>` (verified: `<entry>` count = 1, boxes). DNB OAI `oaiListRecords` with a one-record page boxes too — **a shipped recipe's API hits this at one-record pages** | **Fix built-in** (A1) — 3 independent no-auth APIs; the doc's own pending `parseResponse` generalization |
| **B. Namespaced XML** | ECB SDMX: `message:GenericData` / `generic:Obs` — prefix on *every* element. arXiv uses `opensearch:` + `arxiv:` prefixes on totals/categories while `feed`/`entry` stay prefix-free. DNB SRU + MusicBrainz XML are default-xmlns (prefix-free) | **Fix built-in** (A2) — brittle colon-key `itemsPath` today; one config line enables stable paths; verified zero regression on *itemsPath resolution* across all shipped XML recipes (parsed field names inside records shift prefixed→unprefixed — beneficial, no test asserts them) |
| **C. Retry-After HTTP-date form** | RFC 9110 allows `Retry-After: <date>` besides delay-seconds; `waitForRetry` does `parseInt` only → date form silently falls back to backoff, ignoring the server's stated wait | **Fix built-in** (A3) — two lines, correct-by-spec |
| Root-array responses | GitLab `/api/v4/projects` returns bare `[{...}]`; `api.github.com` already ships `itemsPath: $` on 7 ops | Already supported — no fix; **GitLab proves it with pagination** (B2) |
| Header-based pagination | GitLab sends `Link: rel="next"` + `x-next-page`/`x-page` (no auth) — a *second* independent API after GitHub | **Criterion #1 met but parked**: GitLab returns `[]` past the last page, so the existing `page` style drives it with zero framework change. No API found where page-style fails |
| JSON:API vendor media type | DataCite serves `application/json` content-type for `Accept: application/json` (200, verified in-browser) | No gap, rejected |
| Query-param API keys (NASA `DEMO_KEY`, NVD `apiKey`) | — | Expressible as defaulted `params`; no gap |
| CSV response format | Open-Meteo `format=csv`, ECB `format=csvdata`, USGS, Census all serve `text/csv` while `parseResponse` knows json/xml/text only | **Parked** — 4+ APIs exist, but a guide can ride `format: text` + post-response `transform` today. Promote when the open-meteo (weather) guide lands |
| NDJSON / epoch timestamps / big-int fields | No mainstream no-auth API uses them | Rejected |

## Workstream A — core fixes (each lands with its proof)

### A1. XML single-record array normalization

- **Where:** `core/helpers.ts` — `paginate`, immediately after
  `resolveJsonPath(data, itemsPath)` (~line 646).
- **What:** declared XML list paths (the op's `itemsPath`) must always yield
  an array, even with one element. Normalize post-parse: if the resolved
  node is a non-null non-array object/scalar, wrap it in `[node]` (~2-line
  change). This is the `parseResponse` generalization the escape-valve doc
  already names as pending — implemented at the `paginate` call site where
  `itemsPath` already lives, not inside `parseResponse` (which is also
  called from `restGet` with no `itemsPath`, so threading `itemsPath`
  through its signature would buy nothing).
- **Why not the `isArray` callback:** fast-xml-parser's `isArray` is a
  global parser option that forces *all* instances of a tag name into
  arrays, even in non-list contexts, risking over-arraying non-list
  elements. Post-parse normalization scopes the array-guarantee to the one
  declared list path.
- **Proof shipped:** `arxiv.org` guide (B1) with a live coverage test that
  calls `max_results=1` and asserts `feed.entry` is still an array.
- **Test:** axis unit test with the exact PubMed single-`<Id>` fixture from
  the live probe.

### A2. Namespaced XML

- **Where:** `core/helpers.ts:238` — add `removeNSPrefix: true` to the
  `XMLParser` config.
- **Regression check (done 2026-08-10):** DNB (`searchRetrieveResponse.records.record`,
  `OAI-PMH.ListRecords.record`), MusicBrainz (`metadata.artist-list.artist`),
  BOE (`getConsolidada`) — all itemsPaths are prefix-free local names;
  unaffected. arXiv paths (`feed.entry`) unaffected; `opensearch:totalResults`
  simply becomes `totalResults` (cleaner `totalCountPath`).
- **Behavioral note (not an itemsPath regression):** `removeNSPrefix` is
  global, so parsed *field names inside XML records* change from prefixed
  to unprefixed — e.g. DNB OAI `recordData` fields go from `dc:title`/
  `dc:creator` to `title`/`creator`. This is beneficial (cleaner names for
  helper transforms) and no existing test asserts inner field names (the
  axis B test checks `recordData` is truthy; the DNB coverage test checks
  items is a non-empty array), so no test breaks. The "zero regression"
  claim above is scoped to itemsPath resolution; the inner field-name
  change is a deliberate, beneficial behavioral shift.
- **Test:** unit fixture with `message:`/`generic:`-prefixed elements (ECB
  shape) resolving clean paths; rerun `__tests__/axis-units.test.ts` axis B.

### A3. Retry-After HTTP-date form

- **Where:** `core/transport.ts` `waitForRetry` — `parseInt` for delay-second
  form, `Date.parse` fallback for HTTP-date form. If the parsed HTTP-date is
  in the past (server clock skew or an already-expired retry time), fall
  through to backoff — never return a negative or zero delay.
- **Test:** `waitForRetry` is not currently exported from `transport.ts`.
  Export it for direct unit testing and add an A3 fixture in a new
  `__tests__/transport.test.ts` with both delay-second and HTTP-date
  `Retry-After` values, plus a past-dated HTTP-date case asserting backoff
  fallback. No recipe can reliably force a 429, so the unit test is the
  proof. The existing 429 retry test in `__tests__/helpers.test.ts:~1369`
  (real test server, delay-second `/api/retry` endpoint) stays as-is.

## Workstream B — proof recipes (ship with the fixes)

### B1. arXiv — `export.arxiv.org`

- **Why:** the single most compelling missing axis for a research aide —
  preprints, abstracts, authors, citation surfaces — fully unauthenticated
  and read-only. Atom XML exercises A1 on every `max_results=1` call and A2
  on its `opensearch:`/`arxiv:` prefixed fields; `start`/`max_results` is
  textbook offset-limit. It does not force a *new* shape — it proves two
  fixes on a high-value domain. That is the point of shipping it now.
- **Ops (curated):** search by query (`all:`/`ti:`/`au:` fields), fetch by
  `id_list`, recent-by-category. One op per documented endpoint family.
- **Pagination:** offset-limit (`start`/`max_results`); empty-page
  termination.
- **Helper:** none expected — XML→JSON conversion carries title/summary/
  authors; YAGNI on transforms.
- **Tests:** co-located `endpoint-coverage.test.ts` (`HOST_INTEGRATION=1`):
  every op live + the `max_results=1` array assertion named in A1.
- **Docs:** `info.arxiv.org/help/api/user-manual.html` — plain HTML,
  web-fetch OK (verified).

### B2. GitLab — `gitlab.com` (`/api/v4`)

- **Why:** proves two things end-to-end that are currently only unit-tested:
  (a) `page` style (built-in, **zero recipes use it yet**) and (b) paginated
  root-array via `itemsPath: $` (shipped but only on `restGet` ops today).
  Also settles the header-pagination decision with a live recipe.
- **Ops (curated, read-only):** list/search projects, users, issues.
- **Pagination:** `page` style + `itemsPath: $` — `page`/`per_page` params,
  `[]` past last page terminates. Header-style (`Link`, `x-next-page`,
  verified live) is explicitly **not** needed; record that decision in the
  guide's plan file per the escape-valve upgrade rules.
- **Tests:** co-located coverage test asserting a >1-page pagination drains
  to empty against the live API.
- **Docs:** GitLab's API docs — plain; `api-guide` plans web-fetch first,
  browser fallback if WAF/JS pages appear.

### B3. PubMed E-utilities — `eutils.ncbi.nlm.nih.gov`

- **Why:** scholarly complement to arXiv (biomedical literature), fully
  unauthenticated and read-only (3 req/s without a key). Places A1 on a
  **third independent API**: `esearch`/`efetch` sized with a small `retmax`
  return a boxed single `<Id>`/`<PubmedArticle>` on every small page — the
  same edge arXiv forces, independently confirming the A1 generalization
  isn't tuned to one responder. Also broadens XML *and* JSON coverage on
  one domain (`retmode=json` and `retmode=xml` live side by side).
- **Ops (curated):** `esearch` (search → ID list + counts), `esummary`
  (batch metadata by ID), `efetch`/`elink` if needed. One op per documented
  endpoint family.
- **Pagination:** offset-limit (`retstart`/`retmax`); empty-`IdList`
  termination.
- **Helper:** none expected — XML→JSON conversion carries the fields; the
  A1 normalization makes single-ID pages list-shaped. Revisit only if a
  transform proves necessary.
- **Tests:** co-located `endpoint-coverage.test.ts` (`HOST_INTEGRATION=1`)
  incl. a `retmax=1` array assertion (same shape as arXiv's).
- **Docs:** NCBI Bookshelf (E-utilities chapter) — plain HTML; web-fetch
  first, browser fallback if NCBI resists.

### B4. ECB SDMX — `data-api.ecb.europa.eu`

- **Why:** the only genuinely prefix-everywhere XML recipe found
  (`message:GenericData`, `generic:Obs`, `common:…` — prefix on *every*
  element). Hard-proves A2 beyond the unit fixture: without
  `removeNSPrefix` its `itemsPath` would require literal colon-key paths
  (`message:DataSet.…`), brittle across providers; with it, clean local
  names. Also a high-value economics axis (exchange rates, interest
  rates, money aggregates) that is fully unauthenticated and read-only.
- **Ops (curated):** one family — `service/data/{flow}/{key}` with the
  SDMX-ML XML response (`format=sdmx-json` available as a JSON sibling op).
  Single `<DataSet>` per response also re-exercises A1 at the top level.
- **Pagination:** SDMX `startPeriod`/`endPeriod` windowing is
  server-supplied; treat as single-shot `restGet` ops unless a live probe
  shows pagination (per the no-speculative-pagination rule).
- **CSV variant (`format=csvdata`):** rides the parked local path
  (`format: text` + post-response `transform`) — this *exercises* the
  parked CSV decision live rather than promoting it; the built-in CSV
  `ResponseFormat` promotion stays parked until the open-meteo guide
  forces it.
- **Tests:** co-located coverage test asserting the prefix-free
  `itemsPath` resolves against the live SDMX-ML response.
- **Docs:** ECB data API documentation — plain; verify at plan drafting.

## Workstream C — recipe addendum (no core change)

- **DNB SRU 200-OK diagnostics:** verified live — an unsupported index
  returns `<diagnostics>` inside a 200 with no `<records>`; `itemsPath`
  resolves to `undefined`, paginate stops, and the diagnostic is silently
  swallowed. Add to the DNB guide: a prose note in `guide.md` + a live
  coverage assertion that a `diagnostics` response is surfaced, not silently
  empty. Same family as GitHub `incomplete_results`; recipe-level, not
  framework.

## Testing

- `__tests__/axis-units.test.ts` — extend axes A–D with: single-record XML
  (PubMed fixture), namespaced fixture (ECB shape), rerun of axis B with A2
  enabled. No network.
- `__tests__/transport.test.ts` (new) — A3 fixture: export `waitForRetry`
  from `core/transport.ts` and unit-test delay-second, HTTP-date, and
  past-dated-HTTP-date (backoff fallback) cases.
- Per-guide `api-guides/<domain>/endpoint-coverage.test.ts` — live proof,
  `HOST_INTEGRATION=1`-gated, skipped in bare CI. **This is what "proves the
  shape":** `max_results=1` array assertion (arXiv), drain-to-empty
  pagination (GitLab), diagnostics surfacing (DNB).
- `npm run test:ci` stays green in bare CI; `test:py-bridge` unaffected.

## Batches & order

| Batch | Contents | Gated on |
|-------|----------|----------|
| 1 | Core: A1 + A2 + A3 with unit tests | none — shippable alone, no network |
| 2a | B1 arXiv (proves the riskiest fix first) | Batch 1 |
| 2b | B2 GitLab + C1 DNB addendum | Batch 1 |
| 3 | B3 PubMed + B4 ECB SDMX (planned phase) | Batch 2 |

Order within batch 2: arXiv before GitLab — A1 is the fix with the most
surface area, so it gets proven first. Batch 3 order: PubMed (B3) before
ECB (B4) — A1 gets a second independent confirmation before A2's
hard proof, and PubMed's docs/API surface is lighter than SDMX to author.

**Release scope:** the first release of `pi-lean-host` ships after Batch 3
completes. Batch 1 + Batch 2 already satisfy the escape-valve "second
independent API" rule for all three fixes (arXiv is the second API for
both A1 and A2; A3 is spec-correct with a unit test). Batch 3 is
intentionally *redundant proof* — PubMed gives A1 a third independent
confirmation and ECB gives A2 a hard live proof on prefix-everywhere XML —
gated before v1 for confidence on the first public release, not because
the upgrade rules require it.

## Cross-cutting rules (inherited)

- Cite the source in every plan/guide; docs read with web-fetch first,
  `browser-navigate` when WAF/JS (arXiv and GitLab docs verified plain).
- No speculative helpers; no speculative pagination (`page` chosen for GitLab
  because empty-array termination was verified live; `nextLink` stays
  server-supplied-only).
- Read-only only; one operation per documented endpoint; tests co-located in
  the guide dir, never in `packages/pi-lean-host/__tests__/`.
- Per-guide `endpoint-coverage-plan.md` files are drafted per guide before
  any `guide.md` edits, per
  [CONTRIBUTING.md](../../packages/pi-lean-host/api-guides/CONTRIBUTING.md).

## Out of scope / deliberate omissions

- **CSV ResponseFormat** — parked; local path exists (`format: text` +
  transform). Promote when the open-meteo (weather) guide lands; four
  no-auth APIs already serve CSV, so the upgrade criteria are met, just not
  forced yet.
- **Header-aware pagination style** — parked with the GitLab decision record:
  every header-paginated no-auth API found (GitHub, GitLab) also terminates
  on an empty page, so the existing `page` style covers them. Revisit only
  if a header-*only* API surfaces.
- Rejected during research (evidence on record): JSON:API vendor media type,
  query-param API keys, NDJSON, epoch timestamp params, big-int fields.