---
kind: api
organization: wikimedia.org
description: Page summaries, HTML, and revision metadata via the Wikimedia REST surface.
domains:
  - en.wikipedia.org
shortName: Wikipedia REST
icon: 🌐
apiHost: https://en.wikipedia.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-06"
docs: https://www.mediawiki.org/wiki/Wikimedia_REST_API
operations:
  - name: getPageSummary
    via: restGet
    path: /api/rest_v1/page/summary/{title}
    accept: json
  - name: getPageRevisionMetadata
    via: restGet
    path: /api/rest_v1/page/title/{title}
    accept: json
  - name: getPageRevisionMetadataAt
    via: restGet
    path: /api/rest_v1/page/title/{title}/{revision}
    accept: json
  - name: getPageHtml
    via: restGet
    path: /api/rest_v1/page/html/{title}
    accept: text/html
    parse:
      format: text
    params:
      redirect:
        description: >
          If `false`, do not follow HTTPS redirects and instead return the
          redirect metadata. Default `true` (follow redirects).
  - name: getPageHtmlAt
    via: restGet
    path: /api/rest_v1/page/html/{title}/{revision}
    accept: text/html
    parse:
      format: text
  - name: getPageMediaList
    via: restGet
    path: /api/rest_v1/page/media-list/{title}
    accept: json
  - name: getPageMediaListAt
    via: restGet
    path: /api/rest_v1/page/media-list/{title}/{revision}
    accept: json
  - name: getPageLint
    via: restGet
    path: /api/rest_v1/page/lint/{title}
    accept: json
  - name: getPageLintAt
    via: restGet
    path: /api/rest_v1/page/lint/{title}/{revision}
    accept: json
  - name: getPageMobileHtml
    via: restGet
    path: /api/rest_v1/page/mobile-html/{title}
    accept: text/html
    parse:
      format: text
  - name: getPageMobileHtmlAt
    via: restGet
    path: /api/rest_v1/page/mobile-html/{title}/{revision}
    accept: text/html
    parse:
      format: text
  - name: getCitation
    via: restGet
    path: /api/rest_v1/data/citation/{format}/{query}
    accept: json
    # `format` and `query` are path tokens (inferred). Safe `format` values
    # (per the OpenAPI spec enum): zotero (JSON), mediawiki (JSON),
    # mediawiki-basefields, bibtex (plain text), wikibase — documented in the
    # prose below, since path params cannot carry a descriptions block.
---
# Wikipedia — Wikimedia REST API (Axis D: ETag / conditional-GET)

The Wikimedia REST API exposes page summaries and content with **no
authentication**. Content is CC-BY-SA 4.0; API usage is permitted by
[ToU §12](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#12._API_Terms).

## Operations

### `getPageSummary` — page summary by title (ETag-cached, axis D)

`GET /api/rest_v1/page/summary/{title}` returns a summary object for a single
page (`title`, `extract`, `thumbnail`, …). ETag-cached (`Cache-Control:
max-age=300`) with a strong ETag, so repeated calls within the TTL return
HTTP 304. The recommended smoke-op: stable and no date dependency.

### `getPageRevisionMetadata` / `getPageRevisionMetadataAt` — revision metadata

`GET /api/rest_v1/page/title/{title}` returns the latest revision of a title
as `{"items": [ {title, page_id, rev, timestamp, comment, user_text, …} ]}`.
`GET /api/rest_v1/page/title/{title}/{revision}` returns a specific historical
revision. Both are `stable` per the spec; the `rev` field is a revision id
suitable for the other `{revision}` ops.

### `getPageHtml` / `getPageHtmlAt` — full Parsoid HTML

`GET /api/rest_v1/page/html/{title}` returns the latest rendered HTML for a
title; `/{title}/{revision}` the HTML for a specific revision. Both return
raw HTML (HTTP 200, `text/html`), returned as a plain string. `getPageHtml`
accepts `redirect=false` to surface redirect metadata instead of following
the redirect. This is the "full HTML" path for an agent that needs rendered
content rather than the summary or the Action API wikitext.

### `getPageMediaList` / `getPageMediaListAt` — media used on a page

`GET /api/rest_v1/page/media-list/{title}` returns
`{"revision", "tid", "items": [ {title, type, srcset, …} ]}` — the images,
audio, and video used on a page. Spec-tagged `unstable`: shape may drift.

### `getPageLint` / `getPageLintAt` — linter errors (editor tooling)

`GET /api/rest_v1/page/lint/{title}` returns a JSON array of linter errors
(duplicate ids, missing end tags, …) for a page. Spec-tagged `experimental`.
Niche — most useful for a Wikipedia editor, not general research.

### `getPageMobileHtml` / `getPageMobileHtmlAt` — mobile-optimized HTML

`GET /api/rest_v1/page/mobile-html/{title}` returns HTML optimized for mobile
consumption (a lighter, content-focused DOM), returned as a plain string.
Spec-tagged `experimental`.

### `getCitation` — citation data for an article identifier

`GET /api/rest_v1/data/citation/{format}/{query}` returns citation data for an
article. `format` (per the OpenAPI spec enum) is one of **`zotero`** (JSON
array), **`mediawiki`** (JSON, MediaWiki template fields), **`bibtex`**
(plain text), **`mediawiki-basefields`**, or **`wikibase`**. `query` is an
article title (or URL/DOI/PMID/PMCID). Useful for building references.
Note: `json` is **not** a valid `format` value (the API rejects it with 400)
— use `zotero` for JSON.

## How axis D fires

The axis is the **transport cache**, not pagination. `getPageSummary` carries
a strong ETag + `Cache-Control: max-age=300`; a transport that honors `ETag`
returns the cached parse on 304 instead of re-downloading the full body every
call. This is the candidate whose *purpose* is the conditional-GET path (LoC's
incidental ETag is bonus, not purpose).

## Notes & schema gaps (escape-valve evidence)

- **`Api-User-Agent` etiquette:** the API docs recommend a descriptive
  `User-Agent` / `Api-User-Agent` header. The v1 helper contract can only
  transform **params**, not headers, so the recipe cannot set it. This is a
  transport-header escape-valve candidate (same class as MusicBrainz's UA
  requirement and resources.data.gov's `X-Api-Key`).
- **Do not use the search endpoint** (`/w/rest.php/v1/search/page`) for axis D:
  it returns `cache-control: no-cache` and **no** ETag. Use `getPageSummary`.
- **Language editions:** swap `en.wikipedia.org` for any `xx.wikipedia.org` to
  vary the response language without changing the axis.

## Terms

Content CC-BY-SA 4.0. API Terms of Use §12:
<https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#12._API_Terms>
