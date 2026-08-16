---
kind: api
schemaVersion: 0
organization: wikimedia.org
description: Wiki data, catalog lists, and site metadata via the MediaWiki action=query surface.
domains:
  - wikipedia.org
shortName: Wikimedia Action
icon: 🛠️
apiHost: https://en.wikipedia.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://www.mediawiki.org/wiki/API:Main_page
operations:
  - name: listRecentChanges
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.recentchanges
      continuationParams:
        - continue.rccontinue
        - continue.continue
    params:
      action:
        description: MediaWiki action.
        default: query
      list:
        description: Query list module.
        default: recentchanges
      rclimit:
        description: Per-page count.
        default: 2
      format:
        description: Response format (MediaWiki uses a query param, not Accept).
        default: json
  # ── Group A — Search ────────────────────────────────────────────────
  - name: searchPages
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: offset-limit
      itemsPath: query.search
      pageParam: sroffset
      pageSizeParam: srlimit
      pageSize: 20
    params:
      action:
        default: query
      list:
        default: search
        description: Query list module.
      srsearch:
        required: true
        description: Full-text search query.
      sroffset:
        default: 0
        description: Row offset into the result set.
      srlimit:
        default: 20
        description: Results per page.
      format:
        default: json
  - name: openSearch
    via: restGet
    path: /w/api.php
    accept: json
    transform: true
    params:
      action:
        default: opensearch
        description: MediaWiki action.
      search:
        required: true
        description: Search string (OpenSearch title lookup).
      limit:
        default: 10
        description: Max titles returned.
      format:
        default: json
  - name: prefixSearch
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: offset-limit
      itemsPath: query.prefixsearch
      pageParam: psoffset
      pageSizeParam: pslimit
      pageSize: 20
    params:
      action:
        default: query
      list:
        default: prefixsearch
        description: Query list module.
      pssearch:
        required: true
        description: Prefix to search titles by.
      psoffset:
        default: 0
        description: Row offset into the results (param is `psoffset`, not `ppsoffset`).
      pslimit:
        default: 20
        description: Results per page.
      format:
        default: json
  # ─ Group B: page content & properties ───────────────────────────────
  - name: parsePage
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: parse
        description: MediaWiki action.
      page:
        required: true
        description: Page title to render.
      prop:
        default: text
        description: Which parts to include.
      format:
        default: json
  - name: getPageContent
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: revisions
        description: Query property module.
      titles:
        required: true
        description: Page title.
      rvprop:
        default: content
        description: |
          Revision properties; `content` returns raw wikitext.
      format:
        default: json
  - name: getPageInfo
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: info
        description: Query property module.
      titles:
        required: true
        description: Page title.
      format:
        default: json
  - name: getPageCategories
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: categories
        description: Query property module.
      titles:
        required: true
        description: Page title.
      format:
        default: json
  - name: getPageLinks
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: links
        description: Query property module.
      titles:
        required: true
        description: Page title.
      plnamespace:
        description: Namespace filter for internal links.
      format:
        default: json
  - name: getPageImages
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: images
        description: Query property module.
      titles:
        required: true
        description: Page title.
      format:
        default: json
  - name: getPageExtLinks
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: extlinks
        description: Query property module.
      titles:
        required: true
        description: Page title.
      ellimit:
        default: 20
        description: External links per page.
      format:
        default: json
  - name: getPageTemplates
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: templates
        description: Query property module.
      titles:
        required: true
        description: Page title.
      format:
        default: json
  - name: getPageRedirects
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: redirects
        description: Query property module.
      titles:
        required: true
        description: Page title.
      format:
        default: json
  - name: getPageLangLinks
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: langlinks
        description: Query property module.
      titles:
        required: true
        description: Page title.
      lllimit:
        default: 20
        description: Interlanguage links per page.
      format:
        default: json
  - name: getPageContributors
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: contributors
        description: Query property module.
      titles:
        required: true
        description: Page title.
      pclimit:
        default: 20
        description: Contributors per page.
      format:
        default: json
  - name: getPageCategoryInfo
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: categoryinfo
        description: Query property module.
      titles:
        required: true
        description: Category page title.
      format:
        default: json
  - name: getPageRevisions
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      prop:
        default: revisions
        description: Query property module.
      titles:
        required: true
        description: Page title.
      rvlimit:
        default: 20
        description: Revisions per page.
      rvprop:
        default: "ids|timestamp|user|comment"
        description: Which revision fields to return.
      format:
        default: json
  # ─ Group C: catalog lists ───────────────────────────────────────────
  - name: listAllPages
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.allpages
      continuationParams:
        - continue.apcontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: allpages
        description: Query list module.
      apprefix:
        description: Alphabetical prefix filter.
      aplimit:
        default: 20
        description: Pages per page.
      format:
        default: json
  - name: listCategoryMembers
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.categorymembers
      continuationParams:
        - continue.cmcontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: categorymembers
        description: Query list module.
      cmtitle:
        required: true
        description: Category to enumerate.
      cmlimit:
        default: 20
        description: Members per page.
      format:
        default: json
  - name: listAllCategories
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.allcategories
      continuationParams:
        - continue.accontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: allcategories
        description: Query list module.
      acfrom:
        description: Alphabetical start category.
      aclimit:
        default: 20
        description: Categories per page.
      format:
        default: json
  - name: listBacklinks
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.backlinks
      continuationParams:
        - continue.blcontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: backlinks
        description: Query list module.
      bltitle:
        required: true
        description: Page whose backlinks to list.
      bllimit:
        default: 20
        description: Backlinks per page.
      format:
        default: json
  - name: listUserContribs
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.usercontribs
      continuationParams:
        - continue.uccontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: usercontribs
        description: Query list module.
      ucuser:
        required: true
        description: Username whose contributions to list.
      uclimit:
        default: 20
        description: Contributions per page.
      format:
        default: json
  - name: listLogEvents
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.logevents
      continuationParams:
        - continue.lecontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: logevents
        description: Query list module.
      letype:
        description: Log type filter (e.g. edit).
      lelimit:
        default: 20
        description: Log entries per page.
      format:
        default: json
  - name: listRandom
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.random
      continuationParams:
        - continue.rncontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: random
        description: Query list module.
      rnnamespace:
        default: 0
        description: Namespace for random pages.
      rnlimit:
        default: 1
        description: Random pages per page.
      format:
        default: json
  - name: listAllUsers
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.allusers
      continuationParams:
        - continue.aufrom
        - continue.continue
    params:
      action:
        default: query
      list:
        default: allusers
        description: Query list module.
      aulimit:
        default: 20
        description: Users per page.
      format:
        default: json
  - name: listProtectedTitles
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.protectedtitles
      continuationParams:
        - continue.ptcontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: protectedtitles
        description: Query list module.
      ptlimit:
        default: 20
        description: Protected titles per page.
      format:
        default: json
  # ─ Group D: site metadata + user lookup ────────────────────────────
  - name: getSiteInfo
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      meta:
        default: siteinfo
        description: Query meta module.
      siprop:
        default: general
        description: Site info properties to fetch.
      format:
        default: json
  - name: getUserInfo
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        default: query
      list:
        default: users
        description: Query list module.
      ususers:
        required: true
        description: Username to look up.
      usprop:
        default: "groups|editcount"
        description: Public user fields to fetch.
      format:
        default: json
  - name: listExtUrlUsage
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: tokenBag
      itemsPath: query.exturlusage
      continuationParams:
        - continue.eucontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: exturlusage
        description: Query list module.
      euquery:
        required: true
        description: External URL fragment to match.
      eulimit:
        default: 20
        description: Pages per page.
      format:
        default: json
---
# Wikimedia Action API (G4: `continue`-token bag)

The MediaWiki Action API (`/w/api.php`) exposes wiki data with **no auth**.
Content is CC-BY-SA 4.0; API usage permitted by ToU §12. This recipe targets
The **Action API** (`/w/api.php`) — distinct from the REST API recipe
(axis D), which lives under `/api/rest_v1`. Both guides claim the
`en.wikipedia.org` domain: `api-guide({domain: "en.wikipedia.org"})` shows a
menu (select by `shortName`), and `api-fetch` resolves operations by name
across both guides. The `organization: wikimedia.org` field groups them in
the catalog. The directory name `en.wikipedia.org-action` is only the loader
identity (never surfaced to the agent); `apiHost` is the real
`https://en.wikipedia.org` for URL construction.

## Operations

29 operations total: the existing `listRecentChanges` plus 28 new ones,
grouped as:

- **Group A — Search (3):** `searchPages`, `openSearch`, `prefixSearch`.
  `searchPages`/`prefixSearch` use `offset-limit` pagination
  (`sroffset`/`psoffset`); `openSearch` is a single-page `restGet` returning a
  bare `[searchTerm, [titles], [descriptions], [urls]]` array. A `transform`
  named export in this guide's `helper.ts` zips the three parallel column
  arrays into `[{ title, description, url }, …]` — see the `transform: true`
  field on `openSearch`. If the transform throws, the raw array is returned
  with a warning
  (graceful, no disable).
- **Group B — Page content & properties (13):** `parsePage` and the 12
  `prop=` reads (`getPageContent` … `getPageCategoryInfo`). All `restGet`;
  `parsePage` returns rendered HTML at `{parse.text."*"}` (outside the
  `query` wrapper).
- **Group C — Catalog lists (9):** `listAllPages` … `listProtectedTitles`.
  All `paginate style: tokenBag`, paginating via the module's
  `*continue` key plus the generic `continue` key.
- **Group D — Site metadata + user lookup (3):** `getSiteInfo`,
  `getUserInfo`, `listExtUrlUsage`.

### `listRecentChanges` — recent-changes feed

`GET /w/api.php?action=query&list=recentchanges&rclimit=2&format=json` returns
`{batchcomplete, continue: {rccontinue, continue}, query: {recentchanges[]}}`.
Pagination uses the `tokenBag` style: the `continue` object in each response
contains a bag of continuation keys (`rccontinue` + the generic `continue`
parameter) that are merged into the next request's query params under their
bare key names. Pagination stops when the `continue` object is absent or
empty.

## Terms

Content CC-BY-SA 4.0. API Terms of Use §12:
<https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#12._API_Terms>
