# MusicBrainz API — Endpoint Coverage Plan

> Drafted 2026-07-21 against <https://musicbrainz.org/doc/MusicBrainz_API> (verified
> by web-fetch on 2026-07-21) and <https://musicbrainz.org/doc/MusicBrainz_API/Search>
> (verified on 2026-07-21). Also consulted the Examples page at
> <https://musicbrainz.org/doc/MusicBrainz_API/Examples>. Live probes confirmed
> response shapes for search, lookup, and browse.
>
> Implements the high-value read-only endpoints the current `guide.md` does not
> yet cover. The MusicBrainz API surface is large (13 core entities × 3 GET
> operations each + non-MBID lookups); this plan nominates a **curated subset**
> of endpoints most useful for a music-metadata research aide, following the
> same principle as the `api.github.com` and Action API plans in Batch D.

## Status quo

`guide.md` declares **2 of ~80+ documented read-only endpoints**:

| Operation | Path | Type |
|-----------|------|------|
| `searchArtists` | `GET /ws/2/artist?query=&limit=&offset=&fmt=json` | Search (JSON) |
| `searchArtistsXml` | `GET /ws/2/artist?query=&limit=&offset=&fmt=xml` | Search (XML) |

Both hit the same `/ws/2/artist` path with `fmt` query-param content negotiation
(one JSON, one XML — a G5 pattern).

The API docs define three GET operations per core entity (lookup, browse, search)
plus non-MBID lookups, URL-by-text, collection endpoints, and genre/all. Only one
search entity is covered.

## Verification (2026-07-21)

Docs fetched via `web-fetch` from the main API page and the dedicated Search page.
Response shapes verified with live `curl` probes (User-Agent header required,
1 req/sec rate limit).

### Documented endpoint inventory

The API root is `https://musicbrainz.org/ws/2/`. All endpoints return XML by
default; `fmt=json` or `Accept: application/json` selects JSON.

**Core entities** (13): area, artist, event, genre, instrument, label, place,
recording, release, release-group, series, work, url

Each supports three GET operations:

| # | Pattern | Example | Purpose |
|---|---------|---------|---------|
| 1 | `GET /<ENTITY>/<MBID>?inc=` | `GET /ws/2/artist/5b11f4ce-...?inc=aliases` | Lookup by MBID |
| 2 | `GET /<ENTITY>?<LINKED>=<MBID>&limit=&offset=&inc=` | `GET /ws/2/release?artist=5b11f4ce-...` | Browse linked entities |
| 3 | `GET /<ENTITY>?query=<LUCENE>&limit=&offset=` | `GET /ws/2/recording?query=we+will+rock+you` | Search with Lucene query |

**Non-core resources** (3): rating, tag, collection (but rating/tag/collection
writes are POST — see Out of scope).

**Non-MBID lookups** (3):

| # | Path | Purpose |
|---|------|---------|
| 4 | `GET /discid/<discid>?inc=&toc=` | Disc ID → release(s) |
| 5 | `GET /isrc/<isrc>?inc=` | ISRC → recording(s) |
| 6 | `GET /iswc/<iswc>?inc=` | ISWC → work(s) |

**URL by text:**

| # | Path | Purpose |
|---|------|---------|
| 7 | `GET /url?resource=<URL>[&resource=<URL>]...` | URL text → URL entity (up to 100 resources) |

**Genre all:**

| # | Path | Purpose |
|---|------|---------|
| 8 | `GET /genre/all?limit=&offset=` | All genres paginated (also `fmt=txt` for plain-text list) |

**Collection reads** (GET only; PUT/DELETE are mutations):

| # | Path | Purpose |
|---|------|---------|
| 9 | `GET /collection/<MBID>` | Collection lookup |
| 10 | `GET /collection/<MBID>/<ENTITY>` | Collection contents |
| 11 | `GET /collection?editor=<NAME>&inc=user-collections` | Browse collections by editor |

### In-scope / out-of-scope filter

#### Out of scope (write/mutation/auth)

| Endpoint | Reason |
|----------|--------|
| `POST /ws/2/tag?client=` | Write — submits tags/genres |
| `POST /ws/2/rating?client=` | Write — submits ratings |
| `PUT /ws/2/collection/<gid>/releases/<mbid>` | Write — adds to collection |
| `DELETE /ws/2/collection/<gid>/releases/<mbid>` | Write — removes from collection |
| `POST /ws/2/release/?client=` | Write — barcode submission |
| `POST /ws/2/recording/?client=` | Write — ISRC submission |
| `GET /ws/2/collection?editor=&inc=user-collections` | Requires auth for private collections; the public subset (non-inc) is thin. Low value for research aide. |
| `GET /ws/2/rating/<MBID>` | Requires auth; user-ratings are a lookup subquery, not a standalone read endpoint for anonymous research. |

#### In scope (read-only, high-value for music research)

**Group A — Search** (one per entity, all same shape: offset-limit pagination,
Lucene `query`, response `{created, count, offset, <entity-plural>: [...]}`):

| Operation | Path | itemsPath |
|-----------|------|-----------|
| `searchRecordings` | `GET /ws/2/recording?query=&limit=&offset=` | `recordings` |
| `searchReleases` | `GET /ws/2/release?query=&limit=&offset=` | `releases` |
| `searchReleaseGroups` | `GET /ws/2/release-group?query=&limit=&offset=` | `release-groups` |
| `searchLabels` | `GET /ws/2/label?query=&limit=&offset=` | `labels` |
| `searchWorks` | `GET /ws/2/work?query=&limit=&offset=` | `works` |
| `searchAreas` | `GET /ws/2/area?query=&limit=&offset=` | `areas` |
| `searchEvents` | `GET /ws/2/event?query=&limit=&offset=` | `events` |
| `searchInstruments` | `GET /ws/2/instrument?query=&limit=&offset=` | `instruments` |
| `searchPlaces` | `GET /ws/2/place?query=&limit=&offset=` | `places` |
| `searchSeries` | `GET /ws/2/series?query=&limit=&offset=` | `series` |
| `searchUrls` | `GET /ws/2/url?query=&limit=&offset=` | `urls` |

**Group B — Lookup** (one per entity, single-resource, `via: restGet`):

| Operation | Path | Response top-level key |
|-----------|------|----------------------|
| `getArtist` | `GET /ws/2/artist/<mbid>?inc=` | `artist` |
| `getRecording` | `GET /ws/2/recording/<mbid>?inc=` | `recording` |
| `getRelease` | `GET /ws/2/release/<mbid>?inc=` | `release` |
| `getReleaseGroup` | `GET /ws/2/release-group/<mbid>?inc=` | `release-group` |
| `getLabel` | `GET /ws/2/label/<mbid>?inc=` | `label` |
| `getWork` | `GET /ws/2/work/<mbid>?inc=` | `work` |
| `getArea` | `GET /ws/2/area/<mbid>?inc=` | `area` |
| `getEvent` | `GET /ws/2/event/<mbid>?inc=` | `event` |
| `getInstrument` | `GET /ws/2/instrument/<mbid>?inc=` | `instrument` |
| `getPlace` | `GET /ws/2/place/<mbid>?inc=` | `place` |
| `getSeries` | `GET /ws/2/series/<mbid>?inc=` | `series` |
| `getUrl` | `GET /ws/2/url/<mbid>?inc=` | `url` |

**Group C — Browse** (paginated, offset-limit, via: paginate). The docs list which
linked entities each result entity supports; only the most valuable browse
patterns for music research are included:

| Operation | Path | itemsPath |
|-----------|------|-----------|
| `browseReleasesByArtist` | `GET /ws/2/release?artist=<mbid>&limit=&offset=` | `releases` |
| `browseRecordingsByRelease` | `GET /ws/2/recording?release=<mbid>&limit=&offset=` | `recordings` |
| `browseReleaseGroupsByArtist` | `GET /ws/2/release-group?artist=<mbid>&limit=&offset=` | `release-groups` |
| `browseReleasesByLabel` | `GET /ws/2/release?label=<mbid>&limit=&offset=` | `releases` |
| `browseRecordingsByArtist` | `GET /ws/2/recording?artist=<mbid>&limit=&offset=` | `recordings` |
| `browseWorksByArtist` | `GET /ws/2/work?artist=<mbid>&limit=&offset=` | `works` |
| `browseReleasesByCollection` | `GET /ws/2/release?collection=<mbid>&limit=&offset=` | `releases` |

**Group D — Non-MBID lookups** (single-resource, via: restGet):

| Operation | Path | Response key |
|-----------|------|-------------|
| `lookupDiscId` | `GET /ws/2/discid/<discid>?inc=&toc=` | `release-list` (XML) or releases (JSON — returns list, not single) |
| `lookupIsrc` | `GET /ws/2/isrc/<isrc>?inc=` | recordings |
| `lookupIswc` | `GET /ws/2/iswc/<iswc>?inc=` | works |

**Group E — URL by text** (special: `resource` query param instead of MBID path):

| Operation | Path | Notes |
|-----------|------|-------|
| `lookupUrlByResource` | `GET /ws/2/url?resource=<URL>` | Returns single url when one resource; url-list when multiple |

**Group F — Genre all** (paginated utility endpoint):

| Operation | Path | itemsPath |
|-----------|------|-----------|
| `listAllGenres` | `GET /ws/2/genre/all?limit=&offset=` | `genres` |

## Grouping for implementation

### Family 1 — Search endpoints (identical shape, Group A)

All search endpoints share:

- **Path**: `GET /ws/2/<entity>?query=&limit=&offset=`
- **Pagination**: offset-limit (`style: offset-limit`, `pageParam: offset`, `pageSizeParam: limit`, `pageSize: 25`)
- **Query params**: `query` (required, Lucene syntax), `limit` (default 25, max 100), `offset` (default 0), `fmt` (default `json`)
- **Response shape**: `{created, count, offset, <plural>: [...]}`
- **itemsPath**: `<entity>s` with a dash for multi-word entities (release-groups)

All 11 search operations differ only in:

1. the path entity name
2. the `itemsPath` plural
3. the searchable fields (Lucene index per entity — caller controls `query` content)

Implementation: define all 11 at once in `guide.md` by parameterizing the entity
name and `itemsPath`. No helper code needed; the existing `paginate` handler
handles offset-limit.

### Family 2 — Lookup endpoints (identical shape, Group B)

All lookup endpoints share:

- **Path**: `GET /ws/2/<entity>/<mbid>?inc=`
- **Type**: `via: restGet` (single resource)
- **Params**: `mbid` (required, path param), `inc` (optional, space-separated subqueries like `aliases+artist-rels`), `fmt` (default `json`)
- **Response shape**: top-level key matches the entity name (e.g. `artist`, `release`)

All 12 lookups differ only in entity name.

Implementation: all 12 at once. No helper code needed.

### Family 3 — Browse endpoints (identical shape, Group C)

All browse endpoints share:

- **Pagination**: offset-limit, same params as search
- **Response shape**: same `{<plural>-count, <plural>-offset, <plural>: [...]}` as search
- **itemsPath**: same `<entity>s` convention

They differ in:

1. The result entity path
2. The linked entity parameter name (e.g. `artist=`, `release=`, `label=`, `collection=`)
3. The `itemsPath`

Implementation: 7 browse operations, grouped by how intuitive they are for music
research (releases-by-artist highest value, releases-by-collection lowest).

### Family 4 — Non-MBID lookups (Group D)

`lookupDiscId`, `lookupIsrc`, `lookupIswc` each have unique path patterns and
params; implement individually.

Note: `lookupDiscId` is the most complex — it supports `inc`, `toc` (for fuzzy
lookup), `cdstubs=no`, and `media-format=all`. The basic case (`discid` only)
is straightforward; the full TOC fuzzy search is a nicety.

### Family 5 — Special endpoints (Groups E–F)

`lookupUrlByResource` uses a query param `resource` instead of an MBID — unique
shape.

`listAllGenres` follows the standard offset-limit pattern with `itemsPath: genres`.
Also supports `fmt=txt` for plain-text output (no pagination support in txt mode).
Default to `fmt=json`.

## Implementation phases

### Phase -1 — Cache specs locally

Not needed. The docs page is a single wiki page (~36KB) and the Search page is
a single page (~33KB). Both are statically served and stable. Skip.

### Phase 0 — Live shape probe

Already done for search, lookup, and browse via `curl` probes above. The response
shapes match the docs. No further probing needed.

### Phase 1 — Search endpoints (Family 1, 11 new operations)

Add all 11 search operations to `guide.md`. Highest value for a research aide
(the most natural entry point: "find me recordings/releases/works matching...").

- `searchRecordings` — `itemsPath: recordings`
- `searchReleases` — `itemsPath: releases`
- `searchReleaseGroups` — `itemsPath: release-groups`
- `searchLabels` — `itemsPath: labels`
- `searchWorks` — `itemsPath: works`
- `searchAreas` — `itemsPath: areas`
- `searchEvents` — `itemsPath: events`
- `searchInstruments` — `itemsPath: instruments`
- `searchPlaces` — `itemsPath: places`
- `searchSeries` — `itemsPath: series`
- `searchUrls` — `itemsPath: urls`

Each gets `via: paginate` with `style: offset-limit`, `pageParam: offset`,
`pageSizeParam: limit`, `pageSize: 25`. The existing `searchArtists` is the
reference — these are identical except path/itemsPath.

### Phase 2 — Lookup endpoints (Family 2, 12 new operations)

Add all 12 lookup operations. Second-highest value: once the agent has an MBID
from a search, it needs to fetch the full entity details.

- `getArtist`, `getRecording`, `getRelease`, `getReleaseGroup`, `getLabel`,
  `getWork`, `getArea`, `getEvent`, `getInstrument`, `getPlace`, `getSeries`,
  `getUrl`

Each gets `via: restGet` with optional `inc` and `fmt` params.

### Phase 3 — Browse endpoints (Family 3, 7 new operations)

Add the most valuable browse patterns for music research:

- `browseReleasesByArtist` — highest value ("show me all albums by X")
- `browseRecordingsByRelease` — track listing
- `browseReleaseGroupsByArtist` — group releases
- `browseReleasesByLabel` — label discography
- `browseRecordingsByArtist` — all recordings by artist
- `browseWorksByArtist` — compositions by artist
- `browseReleasesByCollection` — collection contents

Each gets `via: paginate` with offset-limit.

### Phase 4 — Non-MBID lookups (Family 4, 3 new operations)

- `lookupDiscId` — CD lookup (most useful for physical media identification)
- `lookupIsrc` — ISRC → recordings
- `lookupIswc` — ISWC → works

### Phase 5 — Special endpoints (Family 5, 2 new operations)

- `lookupUrlByResource` — URL text → MusicBrainz URL entity
- `listAllGenres` — all genres paginated (utility for tag-based queries)

## Proposed `guide.md` YAML for each new operation

### Phase 1 — Search pattern

```yaml
  - name: searchRecordings
    via: paginate
    path: /ws/2/recording
    accept: json
    pagination:
      style: offset-limit
      itemsPath: recordings
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query (required). Fields vary by entity — see docs.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

All 11 searches share this shape; only `path`, `itemsPath`, and the `name` change.

### Phase 2 — Lookup pattern

```yaml
  - name: getArtist
    via: restGet
    path: /ws/2/artist/{mbid}
    accept: json
    params:
      mbid:
        description: MusicBrainz UUID for the artist.
        required: true
      inc:
        description: Space-separated subqueries (aliases, recordings, releases, etc.).
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

All 12 lookups share this shape; only `path` and `name` change.

### Phase 3 — Browse pattern

```yaml
  - name: browseReleasesByArtist
    via: paginate
    path: /ws/2/release
    accept: json
    pagination:
      style: offset-limit
      itemsPath: releases
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      artist:
        description: MBID of the artist.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

Each browse varies in path, itemsPath, and the linked-entity param name.

### Phase 4 — Non-MBID lookups

```yaml
  - name: lookupDiscId
    via: restGet
    path: /ws/2/discid/{discid}
    accept: json
    params:
      discid:
        description: Disc ID (e.g. from CD ripper).
        required: true
      toc:
        description: TOC string for fuzzy lookup when exact discid not found.
      inc:
        description: Space-separated subqueries (same as release lookup).
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

```yaml
  - name: lookupIsrc
    via: restGet
    path: /ws/2/isrc/{isrc}
    accept: json
    params:
      isrc:
        description: International Standard Recording Code.
        required: true
      inc:
        description: Space-separated subqueries (same as recording lookup).
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

```yaml
  - name: lookupIswc
    via: restGet
    path: /ws/2/iswc/{iswc}
    accept: json
    params:
      iswc:
        description: International Standard Musical Work Code.
        required: true
      inc:
        description: Space-separated subqueries (same as work lookup).
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

### Phase 5 — Special endpoints

```yaml
  - name: lookupUrlByResource
    via: restGet
    path: /ws/2/url
    accept: json
    params:
      resource:
        description: URL to look up (must be double-URL-encoded).
        required: true
      fmt:
        description: Response format — `json` or `xml`.
        default: json
```

```yaml
  - name: listAllGenres
    via: paginate
    path: /ws/2/genre/all
    accept: json
    pagination:
      style: offset-limit
      itemsPath: genres
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format — `json`, `xml`, or `txt` (plain-text names).
        default: json
```

## Testing

Follow the boe.es pattern — tests co-located with the guide, not in the package
`__tests__/` dir.

Two files:

### `endpoint-coverage.test.ts`

`HOST_INTEGRATION=1`-gated live coverage test. Parse the recipe, execute every
defined operation against the live endpoint, assert status 200 + non-empty body
with expected shape. One assertion per operation group:

- **Phase 1** (search): pick one representative entity (e.g. `searchRecordings`
  with `query=we+will+rock+you`) and verify `200` + `recordings` array present.
- **Phase 2** (lookup): pick one representative (e.g. `getArtist` with Nirvana's
  MBID) and verify `200` + `artist.name` matches.
- **Phase 3** (browse): `browseReleasesByArtist` with Nirvana's MBID, verify
  `releases` array.
- **Phase 4** (non-MBID): `lookupIsrc` with a known ISRC, verify recordings.
- **Phase 5** (special): `listAllGenres` with `limit=3`, verify `genres` array.

No helper tests needed (`helper.ts` is not being touched).

### Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 35 new operations across 5 phases |
| `endpoint-coverage.test.ts` | New file, co-located live coverage |
| `helper.ts` | Unchanged (no helper code needed) |
| `helper.test.ts` | Unchanged |

## Out of scope / deliberate omissions

| Endpoint | Reason |
|----------|--------|
| `GET /ws/2/annotation?query=` | Annotation search is low-value for music research; annotations are wiki-style text on entities, not structured metadata. |
| `GET /ws/2/cdstub?query=` | CD stub search (user-submitted tracklists for uncatalogued discs); low reliability. |
| `GET /ws/2/tag?query=` | Tag search; tags are user-generated and noisy. The `listAllGenres` endpoint provides curated genre names instead. |
| `GET /ws/2/genre/<mbid>` | Genre lookup by MBID; genres have minimal fields (name + disambiguation). Low value standalone. |
| `GET /ws/2/collection/<mbid>` | Collection lookup requires auth to see private collections; public collections are niche. |
| `GET /ws/2/release?track_artist=<mbid>` | Browse releases by track artist (specialized case). Deferred — the standard `browseReleasesByArtist` covers the common case. |
| Browse for area/event/instrument/place/series/url | While documented, these are less relevant for a music-metadata research aide. Added only the most intuitive browse patterns. |
| `inc=` subquery parameter validation | The `inc=` parameter accepts many values (`aliases`, `artist-rels`, `recordings`, `releases`, `tags`, `genres`, `ratings`, etc.). These are passed through to the API as-is — no need to enumerate every combination in the guide. The param is declared as a free-text string. |
| Relax NG schema validation | The schema at `musicbrainz_mmd-2.0.rng` is useful for XML submission but irrelevant to JSON read-only use. |
| OAuth / digest authentication | Authentication is only needed for write endpoints and user-specific data (tags, ratings, private collections). Out of scope by design. |
| User-Agent header requirement | Documented in the existing `guide.md` as a transport gap (G12). Not solved by this plan — same escape-valve class as Wikipedia and resources.data.gov. |

## Implementation notes (shipped 2026-08-06)

Shipped **35 new ops → 37 total** (2 existing untouched). All 37 live
assertions pass (`HOST_INTEGRATION=1`), bare CI + `test:ci` green. Deviations
from the frozen plan:

1. **`browseReleasesByCollection` shipped in full** (all 7 plan browse ops).
   A public collection MBID was located via web research (MusicBrainz
   editor-profile discovery, not the API — the API browse-by-editor and the
   site search do not expose collections without auth). Test uses
   `801df7ed-ffc4-4a0f-9351-ed0d5af4b079` ("Together Forever: Greatest Hits
   1983–1991", 104 releases, editor Freso). Live-verified: `release-count`
   104, non-empty `releases`.
2. **Lookup JSON returns the bare entity, not an entity-named wrapper.** The
   plan's "Response top-level key matches the entity name" holds for XML
   (`<entity>`) but not JSON — JSON lookups return the entity object directly
   with a top-level `id`. Tests assert `data.id` (not a wrapper key).
3. **Path params are inferred, not re-declared.** `{mbid}` / `{discid}` /
   `{isrc}` / `{iswc}` are inferred from `{token}` in `path:` and must **not**
   also appear in `params:` (the parser rejects re-declaration — same
   `datos.gob.es` / `openlibrary.org` precedent). Callers pass them as params;
   the executor substitutes them into the path. `toc` (discid) remains a real
   query param.
4. **`searchUrls` query must be free-text.** The `url:` Lucene *field* index
   returns 0 even for an exact `url:"https://www.nirvana.com"` query; a
   free-text token (e.g. `discogs`) returns results. Test uses a free-text
   query.
5. **Live gate robustness.** MusicBrainz intermittently returns HTTP 503
   `{"error": "... busy ..."}` under load (not a rate limit — the pipeline's
   default UA satisfies the UA requirement). The test's `fetchOp` retries
   transient 503s with backoff so a correct recipe isn't masked by a busy
   server. Pacing at 1s (1 req/sec anonymous limit) throughout.

No `helper.ts` needed (B4/A5): the ops share the existing `restGet`/`paginate`
surface with no domain-specific transform. No `spec/` committed (D3). No new
WAF/bot-detection quirk (D2) — the UA requirement was already recorded as G12
in `guide.md`.
