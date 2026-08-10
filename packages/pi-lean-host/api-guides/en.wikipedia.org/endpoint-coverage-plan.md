# Wikipedia (Wikimedia REST API) — Endpoint Coverage Plan

> Drafted 2026-07-21 against the **official OpenAPI 3.0 spec** at
> <https://en.wikipedia.org/api/rest_v1/?spec> (linked from the REST
> Sandbox at
> <https://en.wikipedia.org/w/index.php?api=wmf-restbase&title=Special%3ARestSandbox>,
> which the `browser-navigate` tool confirmed is the authoritative
> reference). The endpoint list, paths, parameters, summaries, and
> stability markers below are taken **verbatim from the spec**, not
> inferred. Live `curl` probes confirmed the working endpoints and
> exposed a broken existing operation on 2026-07-21.

## Status quo

`guide.md` declares **2** operations:

| Implemented | Operation | Path | Works? |
|-------------|-----------|------|--------|
| ✅ | `getPageSummary` | `/api/rest_v1/page/summary/{title}` | ✅ 200, carries ETag (axis D evidence intact) |
| ⚠ | `getFeaturedFeed` | `/api/rest_v1/feed/featured/{yyyymmdd}` | ❌ **404 on all dates probed** — endpoint removed from the REST API; NOT in the current OpenAPI spec |

⚠ **Broken operation:** `getFeaturedFeed` returns 404 for every date
probed (2026-07-21) and is **not present in the current OpenAPI spec**
(the spec's `paths` contain no `/feed/*` entries). The existing
`guide.md` already notes this ("has been observed returning HTTP 404 for
all dates (July 2026)"). The feed endpoints appear to have been retired.
The axis D (ETag/conditional-GET) evidence now lives entirely on
`getPageSummary`, which carries a strong ETag
(`W/"1364888318/..."`) and `Cache-Control: max-age=300`.

**Recommendation:** remove `getFeaturedFeed` from `guide.md` (or mark it
deprecated) and rely on `getPageSummary` for axis D. This is a
correction to the existing guide, not a new operation.

## Verification (2026-07-21)

The OpenAPI 3.0 spec lists **46 paths** total. Filtering to **GET**
endpoints (read-only) yields **28 endpoints**; the rest are POST/PUT/DELETE
(transforms, lists, math-check — out of scope for a read-only research
aide). The spec provides stability markers (`stable`, `unstable`,
`experimental`) per endpoint.

### Complete GET endpoint list (from the spec)

#### Page content (13 endpoints — the high-value family)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 1 | `GET /page/` | List page-related API entry points | stable | ❌ |
| 2 | `GET /page/title/{title}` | Get revision metadata for a title | stable | ❌ |
| 3 | `GET /page/title/{title}/{revision}` | Get revision metadata for a title (specific revision) | stable | ❌ |
| 4 | `GET /page/html/{title}` | Get latest HTML for a title | stable | ❌ |
| 5 | `GET /page/html/{title}/{revision}` | Get HTML for a specific title/revision | stable | ❌ |
| 6 | `GET /page/lint/{title}` | Get the linter errors for a specific title/revision | experimental | ❌ |
| 7 | `GET /page/lint/{title}/{revision}` | Get the linter errors for a specific title/revision | experimental | ❌ |
| 8 | `GET /page/summary/{title}` | Get basic metadata and simplified article introduction | stable | ✅ `getPageSummary` |
| 9 | `GET /page/media-list/{title}` | Get list of media files used on a page | unstable | ❌ |
| 10 | `GET /page/media-list/{title}/{revision}` | Get list of media files used on a page | unstable | ❌ |
| 11 | `GET /page/mobile-html/{title}` | Get page content HTML optimized for mobile consumption | experimental | ❌ |
| 12 | `GET /page/mobile-html/{title}/{revision}` | Get page content HTML optimized for mobile consumption | experimental | ❌ |
| 13 | `GET /page/mobile-html-offline-resources/{title}` | Get styles and scripts for offline consumption of mobile-html pages | experimental | ❌ |
| 14 | `GET /page/mobile-html-offline-resources/{title}/{revision}` | (same, specific revision) | experimental | ❌ |
| 15 | `GET /page/talk/{title}` | Get structured talk page contents | experimental | ❌ |
| 16 | `GET /page/talk/{title}/{revision}` | Get structured talk page contents | experimental | ❌ |

#### Citation (1 endpoint)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 17 | `GET /data/citation/{format}/{query}` | Get citation data given an article identifier | — | ❌ |

#### Math (2 endpoints)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 18 | `GET /media/math/formula/{hash}` | Get a previously-stored formula | — | ❌ |
| 19 | `GET /media/math/render/{format}/{hash}` | Get rendered formula in the given format | — | ❌ |

#### Reading lists (4 endpoints — require auth)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 20 | `GET /data/lists/` | Get all lists of the current user | — | ❌ |
| 21 | `GET /data/lists/changes/since/{date}` | Get recent changes to the lists | — | ❌ |
| 22 | `GET /data/lists/pages/{project}/{title}` | Get lists of the current user which contain a given page | — | ❌ |
| 23 | `GET /data/lists/{id}/entries/` | Get all entries of a given list | — | ❌ |

#### Recommendation (3 endpoints)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 24 | `GET /data/recommendation/article/creation/morelike/{seed_article}` | Recommend missing articles | — | ❌ |
| 25 | `GET /data/recommendation/article/creation/translation/{from_lang}` | Recommend articles for translation | — | ❌ |
| 26 | `GET /data/recommendation/article/creation/translation/{from_lang}/{seed_article}` | Recommend articles for translation | — | ❌ |

#### Mobile app infrastructure (3 endpoints — not research-relevant)

| # | Path | Summary | Stability | In guide? |
|---|------|---------|-----------|-----------|
| 27 | `GET /data/css/mobile/{type}` | Get CSS for mobile apps | — | ❌ |
| 28 | `GET /data/javascript/mobile/{type}` | Get JavaScript for mobile apps | — | ❌ |
| 29 | `GET /data/i18n/{type}` | Get internationalization info | — | ❌ |

### Key observations

- **No `/feed/*` endpoints in the spec.** The existing `getFeaturedFeed`
  operation targets an endpoint that no longer exists. See "Status quo."
- **No pagination.** Every GET endpoint is a single-resource fetch
  (`restGet`). None return a paginated list — the REST API is designed
  for cacheable single-resource access, not list crawling. (List/search
  access is the Action API's job, covered by the separate
  `en.wikipedia.org-action` guide.)
- **ETag/conditional-GET** is the transport-level concern (axis D),
  handled by the HTTP layer automatically — not an endpoint property to
  declare per-op.
- **Stability tiers matter.** `stable` endpoints (`/page/title/`,
  `/page/html/`, `/page/summary/`) are safe to depend on;
  `experimental`/`unstable` endpoints (`/page/lint/`, `/page/media-list/`,
  `/page/mobile-html/`, `/page/talk/`) may change. The plan prioritizes
  stable endpoints.

## Out-of-scope rows

- **Reading lists (`/data/lists/*`):** require authentication (the spec
  lists them as "current user" lists). The existing guide declares
  `auth: none`; adding authed endpoints would violate that. Out of scope
  for a no-auth research aide.
- **Mobile app infrastructure (`/data/css/mobile/`,
  `/data/javascript/mobile/`, `/data/i18n/`):** these serve the
  Wikipedia mobile apps' rendering pipeline, not research queries. A
  research agent has no use for mobile CSS/JS bundles. Out of scope.
- **Math endpoints (`/media/math/*`):** render a single formula by hash.
  Niche use case (formula rendering), not information retrieval. Low
  priority — could add if a math-research use case arises, but not
  proposed now.
- **POST transforms (`/transform/*`):** write/transform endpoints
  (wikitext↔HTML conversion), not read-only. Out of scope.
- **POST/PUT/DELETE list endpoints:** mutations. Out of scope.

## Grouping for implementation

### Group A — Stable page metadata + content (high value, 6 operations)

The stable `/page/` endpoints are the core research surface. All are
`restGet`, single-resource, no pagination.

| # | Operation | Path | Stability | Notes |
|---|-----------|------|-----------|-------|
| A1 | `getPageRevisionMetadata` | `/page/title/{title}` | stable | Revision metadata for the latest revision of a title. |
| A2 | `getPageRevisionMetadataAt` | `/page/title/{title}/{revision}` | stable | Revision metadata for a specific revision. |
| A3 | `getPageHtml` | `/page/html/{title}` | stable | Latest HTML for a title (full Parsoid HTML). |
| A4 | `getPageHtmlAt` | `/page/html/{title}/{revision}` | stable | HTML for a specific revision. |
| A5 | `listPageEndpoints` | `/page/` | stable | Lists page-related API entry points (navigation/discovery). |

`getPageSummary` (A-existing) already covers the summary use case.

**Why separate `{title}` and `{title}/{revision}` ops?** Per the plan
doc's "one operation per documented endpoint, distinct `name`" rule —
the spec lists them as separate paths, so they get separate names. An
agent that wants the latest revision uses A1/A3; one that wants a
specific historical revision uses A2/A4.

### Group B — Media + talk (unstable/experimental, 4 operations, medium priority)

| # | Operation | Path | Stability | Notes |
|---|-----------|------|-----------|-------|
| B1 | `getPageMediaList` | `/page/media-list/{title}` | unstable | Media files (images/audio/video) used on a page. |
| B2 | `getPageMediaListAt` | `/page/media-list/{title}/{revision}` | unstable | (specific revision) |
| B3 | `getPageTalk` | `/page/talk/{title}` | experimental | Structured talk page contents. |
| B4 | `getPageTalkAt` | `/page/talk/{title}/{revision}` | experimental | (specific revision) |

⚠ **Stability caveat:** `unstable`/`experimental` endpoints may change
shape. Document the stability tier in `guide.md` for these ops so the
agent knows the risk.

### Group C — Lint + mobile-html (experimental, 4 operations, low priority)

| # | Operation | Path | Stability | Notes |
|---|-----------|------|-----------|-------|
| C1 | `getPageLint` | `/page/lint/{title}` | experimental | Linter errors for a page. Niche (editor tooling). |
| C2 | `getPageLintAt` | `/page/lint/{title}/{revision}` | experimental | (specific revision) |
| C3 | `getPageMobileHtml` | `/page/mobile-html/{title}` | experimental | Mobile-optimized HTML. |
| C4 | `getPageMobileHtmlAt` | `/page/mobile-html/{title}/{revision}` | experimental | (specific revision) |

Low priority — lint is editor tooling, mobile-html is for mobile-app
consumers. A research agent generally wants `/page/html/` (full HTML)
or `/page/summary/` (metadata), not these.

### Group D — Citation (1 operation, medium priority)

| # | Operation | Path | Stability | Notes |
|---|-----------|------|-----------|-------|
| D1 | `getCitation` | `/data/citation/{format}/{query}` | — | Citation data for an article identifier. Params: `format` (path), `query` (path), `Accept-Language` (header). |

Useful for a research agent building references. `format` enum and
`query` shape should be probed in Phase 0.

### Group E — Recommendation (3 operations, low priority)

| # | Operation | Path | Stability | Notes |
|---|-----------|------|-----------|-------|
| E1 | `getArticleRecommendationsMorelike` | `/data/recommendation/article/creation/morelike/{seed_article}` | — | Recommend missing articles similar to a seed. |
| E2 | `getArticleRecommendationsTranslation` | `/data/recommendation/article/creation/translation/{from_lang}` | — | Recommend articles for translation from a language. |
| E3 | `getArticleRecommendationsTranslationSeed` | `/data/recommendation/article/creation/translation/{from_lang}/{seed_article}` | — | (with a seed article) |

Niche — these serve translation/editing workflows, not pure research.
Low priority.

## Proposed operations summary

| Group | Ops to add | `via` | Priority | Stability | Notes |
|-------|-----------|-------|----------|-----------|-------|
| A | 5 | `restGet` | High | stable | Page metadata + HTML (core research surface) |
| B | 4 | `restGet` | Medium | unstable/experimental | Media list + talk pages |
| C | 4 | `restGet` | Low | experimental | Lint + mobile-html (editor/mobile tooling) |
| D | 1 | `restGet` | Medium | — | Citation data |
| E | 3 | `restGet` | Low | — | Article recommendations (translation workflows) |
| **Total** | **17** | | | | |

Plus: **remove or deprecate the broken `getFeaturedFeed` operation.**

## Implementation phases

### Phase 0 — Live shape probes (2 quick probes)

1. **Probe `/data/citation/{format}/{query}`:** the spec lists `format`
   and `query` as path params but doesn't show the `format` enum in the
   summary. Call `GET /data/citation/json/https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FEarth`
   (or similar) to confirm the `format` values (likely `json`, `mediawiki`,
   `zotero`) and the `query` shape (URL-encoded article identifier).
2. **Confirm `/feed/featured/` is dead:** re-probe a range of dates to
   confirm the 404 is persistent before removing `getFeaturedFeed`.

### Phase 1 — Remove broken op + add Group A (stable page endpoints)

**First:** remove `getFeaturedFeed` from `guide.md` (or mark it
`deprecated: true` if the guide schema supports it). Update the prose to
shift axis D evidence fully to `getPageSummary`.

**Then** add Group A (5 ops):

```yaml
  - name: getPageRevisionMetadata
    via: restGet
    path: /api/rest_v1/page/title/{title}
    accept: json
    pathParams:
      - title

  - name: getPageRevisionMetadataAt
    via: restGet
    path: /api/rest_v1/page/title/{title}/{revision}
    accept: json
    pathParams:
      - title
      - revision

  - name: getPageHtml
    via: restGet
    path: /api/rest_v1/page/html/{title}
    accept: html
    pathParams:
      - title
    params:
      redirect:
        description: >
          If `false`, do not follow page redirects (return the redirect
          metadata instead). Default `true`.

  - name: getPageHtmlAt
    via: restGet
    path: /api/rest_v1/page/html/{title}/{revision}
    accept: html
    pathParams:
      - title
      - revision

  - name: listPageEndpoints
    via: restGet
    path: /api/rest_v1/page/
    accept: json
```

⚠ **`accept` for HTML endpoints:** `/page/html/*` returns HTML, not JSON.
Use `accept: html` (or whatever the guide schema allows for non-JSON).
The agent can read the HTML body. Verify the guide router handles
non-JSON `accept` values in Phase 0 if uncertain.

### Phase 2 — Add Group B (media + talk, unstable/experimental)

```yaml
  - name: getPageMediaList
    via: restGet
    path: /api/rest_v1/page/media-list/{title}
    accept: json
    pathParams:
      - title
    # NOTE: spec marks this endpoint UNSTABLE — shape may change.

  - name: getPageMediaListAt
    via: restGet
    path: /api/rest_v1/page/media-list/{title}/{revision}
    accept: json
    pathParams:
      - title
      - revision

  - name: getPageTalk
    via: restGet
    path: /api/rest_v1/page/talk/{title}
    accept: json
    pathParams:
      - title
    # NOTE: spec marks this endpoint EXPERIMENTAL.

  - name: getPageTalkAt
    via: restGet
    path: /api/rest_v1/page/talk/{title}/{revision}
    accept: json
    pathParams:
      - title
      - revision
```

### Phase 3 — Add Group D (Citation)

```yaml
  - name: getCitation
    via: restGet
    path: /api/rest_v1/data/citation/{format}/{query}
    accept: json
    pathParams:
      - format
      - query
    # `format` enum TBD in Phase 0 (likely json/mediawiki/zotero).
    # `query` is an article identifier (URL or title).
```

### Phase 4 (optional) — Add Group C (lint + mobile-html)

Only if an editor-tooling or mobile-consumption use case arises. Low
priority. Same `restGet` shape as Groups A/B.

### Phase 5 (optional) — Add Group E (recommendations)

Only if a translation-workflow use case arises. Low priority.

## Testing

Follow the boe.es pattern — one file, co-located:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - `getPageSummary`: status 200, response has `title` + `extract`
     (existing — keep)
   - `getPageRevisionMetadata`: status 200, response has `title` + `rev`
   - `getPageRevisionMetadataAt`: status 200, response has `rev`
   - `getPageHtml`: status 200, body is non-empty HTML
   - `getPageHtmlAt`: status 200, body is non-empty HTML
   - `listPageEndpoints`: status 200, response lists page endpoints
   - `getPageMediaList`: status 200, response has `items` array
   - `getPageTalk`: status 200, response has talk topic structure
   - `getCitation`: status 200, response has citation fields
   - Use a stable title (`Earth`) for all page ops.
   - **Assert `getFeaturedFeed` is removed** (the op should no longer be
     in the parsed recipe) — or skip if deprecated.

2. **`helper.test.ts`** — Not needed. No helper transforms proposed.

Manual: run `api-guide en.wikipedia.org` from a pi session, confirm
all implemented ops appear with correct param hints.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | **Remove/deprecate `getFeaturedFeed`** (broken, 404). Add Group A (5 ops, Phase 1), Group B (4 ops, Phase 2), Group D (1 op, Phase 3). Optionally Groups C/E. Update axis D prose to cite `getPageSummary` only. |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created — the authoritative spec is the live OpenAPI JSON at `/api/rest_v1/?spec`, fetched directly. No PDF to cache. |

## Out of scope / deliberate omissions

- **`getFeaturedFeed` (existing):** broken — returns 404 on all dates,
  and the `/feed/*` paths are absent from the current OpenAPI spec. The
  feed endpoints appear retired. Remove or deprecate. Axis D evidence
  shifts entirely to `getPageSummary` (which carries a strong ETag +
  `Cache-Control: max-age=300`, probe-confirmed).
- **Reading lists (`/data/lists/*`):** require authentication ("current
  user" lists). The guide declares `auth: none`; adding authed endpoints
  would violate that. Out of scope.
- **Mobile app infrastructure (`/data/css/mobile/`,
  `/data/javascript/mobile/`, `/data/i18n/`):** serve the Wikipedia
  mobile apps' rendering pipeline (CSS/JS bundles, i18n strings), not
  research queries. A research agent has no use for mobile CSS/JS. Out
  of scope.
- **Math endpoints (`/media/math/*`):** render a single formula by hash.
  Niche formula-rendering use case, not information retrieval. Not
  proposed; add if a math-research use case arises.
- **POST transforms (`/transform/*`):** write/transform endpoints
  (wikitext↔HTML conversion via POST). Not read-only. Out of scope.
- **POST/PUT/DELETE list endpoints:** mutations. Out of scope.
- **`{title}/{revision}` paired ops:** the spec lists revision-specific
  variants as separate paths, so they get separate operation names per
  the "one operation per documented endpoint" rule. An alternative would
  be to make `revision` an optional path param on one op, but the guide
  schema's `pathParams` are positional, not optional — so separate ops
  is the cleaner shape.

---

## Implementation notes (2026-08-06)

Shipped **12 ops** in `guide.md` (existing `getPageSummary` + **11 new**).
Removed the broken `getFeaturedFeed`. Live probes (Phase 0) drove several
deviations from this plan; each is recorded below. The rollout doc's
"+17, −1" count assumed Groups A/B/C/D/E all land; the drops below are all
live-probe-justified (the endpoint is dead or gated), not editorial.

### Deviations from the plan

1. **Removed `getFeaturedFeed`** (as planned) — confirmed 404 on
   2026-07-21 and 2026-08-06; `/feed/*` absent from the current OpenAPI
   spec. Axis D evidence sits entirely on `getPageSummary` (strong ETag +
   `Cache-Control: max-age=300`).
2. **Dropped A5 `listPageEndpoints` (`GET /page/`)** — the route is defined
   in the OpenAPI spec (200 → `listing` schema) but is **not served** on the
   public API: production `en.wikipedia.org` returns 404, the spec's own
   sandbox server (`test.wikimedia.org`) returns 404, and the sibling listing
   route `/media/` behaves identically. Corroboration (researched 2026-08-06):
   the official `API:REST_API/Reference` documents only concrete `/page/...`
   paths (never a bare `GET /page/`), and the restbase internals describe
   `/page/...` as a `Handlers` registry listing (router config), not a served
   content endpoint. This is a spec-defined-but-never-deployed listing route,
   not a probe error — no URL/Accept/UA variant or trailing-slash trick
   returns 200. Not shipped; an agent calling it would 404 every time.
3. **Dropped Group B talk ops (`getPageTalk`, `getPageTalkAt`)**
   (`/page/talk/{title}`) — live probe returns HTTP 403 with a Wikimedia
   error page, persistent across retries and revisions. The 403 body is
   explicit: *"This API endpoint is being decommissioned. See
   <https://phabricator.wikimedia.org/T401895>"*. That task
   ([T401895](https://phabricator.wikimedia.org/T401895), "Block traffic
   to RESTBase /page/talk endpoint and sunset it", authored 2025-08-14)
   records that `/page/talk` was an **experimental** endpoint no longer
   used by any Wikimedia Android/iOS app ([T392491](https://phabricator.wikimedia.org/T392491));
   because it carries the `experimental` stability tag the REST API policy
   permits a traffic block without the usual deprecation grace, and the
   block is enacted at the Varnish edge (the only remaining external
   consumer, Wikiwand, was given a migration window). This is a deliberate
   server-side sunset (block-then-delete-code, mirroring the 2023 MCS
   decommission [T328036](https://phabricator.wikimedia.org/T328036)) — not
   rate limiting, not a header/UA/probe issue, and not routable around.
   Not shipped; an agent calling it would 403 every time.
4. **Dropped Group E recommendations (all 3 ops)**
   (`/data/recommendation/...`) — live probe returns HTTP 403 on every
   variant (`morelike`, `translation`, `translation/{seed}`). The 403 body
   is explicit: *"API endpoint is removed. See
   <https://phabricator.wikimedia.org/T390517>"*. That task
   ([T390517](https://phabricator.wikimedia.org/T390517), "Remove
   recommendation-api from the REST API offerings", authored 2025-03-31,
   tagged `RESTBase-Sunsetting`) records the sunset of the whole
   recommendation-api service, with a public announcement at
   [diff.wikimedia.org/2025/02/24/sunset-of-wikimedia-recommendation-api](https://diff.wikimedia.org/2025/02/24/sunset-of-wikimedia-recommendation-api/).
   The action item was "block the API at the CDN level" — the 403 is that
   edge block, not rate limiting or a probe issue. Not shipped; an agent
   calling any recommendation op would 403 every time.
5. **Citation `format` enum corrected.** The plan assumed `json` as a
   `format`; live probe shows `json` → HTTP 400 `Invalid format requested
   json`. Valid values (full spec enum) are **`zotero`** (JSON array),
   **`mediawiki`** (JSON), **`bibtex`** (plain text),
   **`mediawiki-basefields`**, and **`wikibase`**. The recipe uses no
   explicit default
   (path token); the enum is documented in the guide prose because path
   params cannot carry a `params` description block (validator rejects a
   params key that duplicates a `{token}`).
6. **HTML ops need a `parse` override.** The guide's top-level
   `responseShape.format: json` would fail to parse an HTML body. The
   `/page/html/*` and `/page/mobile-html/*` ops use `accept: text/html` +
   `parse: {format: text}` so `data` is the raw HTML string.

### Shipped ops (12)

`getPageSummary` (existing), `getPageRevisionMetadata`,
`getPageRevisionMetadataAt`, `getPageHtml`, `getPageHtmlAt`,
`getPageMediaList`, `getPageMediaListAt`, `getPageLint`, `getPageLintAt`,
`getPageMobileHtml`, `getPageMobileHtmlAt`, `getCitation`.

Group C (lint + mobile-html) shipped despite being "optional" — live probe
confirmed both work (200) and they add research value. Groups B/talk and E
were dropped (see above). No pagination anywhere — every REST op is a
single-resource `restGet`, consistent with the plan's "no pagination"
observation.

### Test status

- Bare CI: `en.wikipedia.org/endpoint-coverage.test.ts` → **13 skip**.
- `HOST_INTEGRATION=1`: **13/13 pass** (parse baseline + one assertion per
  op). Revision-specific ops derive a real `rev` from
  `getPageRevisionMetadata` at test time, so they don't hard-code a stale
  revision id.
- Repo `npm run test:ci`: **921 passed, 0 failed**.
