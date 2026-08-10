# Wikimedia Action API — Endpoint Coverage Plan

> Drafted 2026-07-22 against <https://www.mediawiki.org/wiki/API:Main_page>
> (verified by web-fetch on 2026-07-22) plus individual module docs at
> `/wiki/API:{Parse,Search,Opensearch,Categorymembers,Allpages,Prefixsearch,Revisions,Lists,Properties}`.
> Implements a curated subset of high-value read-only query modules that
> the current `guide.md` does not yet cover.

## Selection rule

The MediaWiki Action API exposes **dozens** of `list=`, `prop=`, and `meta=`
modules — documenting all of them would make the plan longer than the docs
site. This plan nominates a **curated subset of high-value read-only modules**
useful for a research aide:

- **Search** — full-text, prefix, and OpenSearch title lookup.
- **Page content & properties** — fetch wikitext, parsed HTML, categories,
  links, images, templates, redirects, language links, revision history,
  contributors.
- **Catalog lists** — all pages, category members, all categories,
  backlinks, user contributions, log events, random pages, all users.
- **Site metadata** — general site info.

**Excluded:** write/mutation actions (`edit`, `delete`, `move`, `upload`,
`watch`, `protect`, `rollback`, `block`, `emailuser`, etc.), admin-only
list modules (`alldeletedrevisions`, `deletedrevs`, `filearchive`),
authenticated-user-only modules (`watchlist`, `watchlistraw`), and
low-value list modules (`allfileusages`, `allredirects`, `alltransclusions`,
`blocks`, `embeddedin`, `imageusage`, `iwbacklinks`, `langbacklinks`,
`querypage`, `tags` — useful but niche, can be added later on demand).

## Status quo

`guide.md` declares **1 of ~25+** documented read-only query modules:

| Operation | `list=`/`action=` | Status |
|-----------|---------------------|--------|
| `listRecentChanges` | `list=recentchanges` | ✅ Existing |

## Verification (2026-07-22)

The authoritative docs live at <https://www.mediawiki.org/wiki/API:Main_page>
with individual module pages at `/wiki/API:{ModuleName}`. The automated
`api.php?action=help&modules=query` also serves the canonical parameter
list per module. All operations below cite their module-specific docs page.

### Documented read-only query modules

| Module | Type | Docs page | Status | Notes |
|--------|------|-----------|--------|-------|
| `action=parse` | Non-query | `/wiki/API:Parse` | 🆕 Add | Parse page → HTML |
| `action=opensearch` | Non-query | `/wiki/API:Opensearch` | 🆕 Add | OpenSearch title search |
| `list=search` | List | `/wiki/API:Search` | 🆕 Add | Full-text search |
| `list=prefixsearch` | List | `/wiki/API:Prefixsearch` | 🆕 Add | Prefix title search |
| `list=allpages` | List | `/wiki/API:Allpages` | 🆕 Add | Alphabetical page list |
| `list=categorymembers` | List | `/wiki/API:Categorymembers` | 🆕 Add | Pages in a category |
| `list=allcategories` | List | `/wiki/API:Lists#allcategories` | 🆕 Add | All category names |
| `list=backlinks` | List | `/wiki/API:Lists#backlinks` | 🆕 Add | Pages linking to target |
| `list=usercontribs` | List | `/wiki/API:Lists#usercontribs` | 🆕 Add | User contributions |
| `list=logevents` | List | `/wiki/API:Lists#logevents` | 🆕 Add | Log events |
| `list=random` | List | `/wiki/API:Lists#random` | 🆕 Add | Random pages |
| `list=allusers` | List | `/wiki/API:Lists#allusers` | 🆕 Add | Registered users |
| `list=users` | List | `/wiki/API:Lists#users` | 🆕 Add | User info lookup |
| `list=exturlusage` | List | `/wiki/API:Lists#exturlusage` | 🆕 Add | Pages linking to URL |
| `list=protectedtitles` | List | `/wiki/API:Lists#protectedtitles` | 🆕 Add | Protected titles |
| `prop=info` | Prop | `/wiki/API:Properties#info` | 🆕 Add | Basic page info |
| `prop=revisions` | Prop | `/wiki/API:Revisions` | 🆕 Add | Revision data/content |
| `prop=categories` | Prop | `/wiki/API:Properties#categories` | 🆕 Add | Page categories |
| `prop=links` | Prop | `/wiki/API:Properties#links` | 🆕 Add | Internal links |
| `prop=images` | Prop | `/wiki/API:Properties#images` | 🆕 Add | Images on page |
| `prop=extlinks` | Prop | `/wiki/API:Properties#extlinks` | 🆕 Add | External links |
| `prop=templates` | Prop | `/wiki/API:Properties#templates` | 🆕 Add | Transcluded templates |
| `prop=redirects` | Prop | `/wiki/API:Properties#redirects` | 🆕 Add | Redirects to page |
| `prop=langlinks` | Prop | `/wiki/API:Properties#langlinks` | 🆕 Add | Language links |
| `prop=contributors` | Prop | `/wiki/API:Properties#contributors` | 🆕 Add | Page contributors |
| `prop=categoryinfo` | Prop | `/wiki/API:Properties#categoryinfo` | 🆕 Add | Category statistics |
| `meta=siteinfo` | Meta | `/wiki/API:Meta` | 🆕 Add | General site info |

### Out of scope (write / auth-required / admin)

| Module | Reason |
|--------|--------|
| `edit`, `delete`, `move`, `upload`, `watch`, `protect`, `rollback`, `patrol`, `block`, `emailuser`, `import`, `undelete`, `options`, `userrights`, `setpagelanguage` | Write/mutation actions |
| `list=watchlist`, `list=watchlistraw`, `meta=userinfo`, `meta=tokens` | Require authenticated user |
| `list=alldeletedrevisions`, `list=deletedrevs`, `list=filearchive` | Admin/deleted content |
| `list=blocks` | Admin-oriented; low research value |
| `prop=stashimageinfo`, `prop=duplicatefiles`, `prop=globalusage`, `prop=fileusage` | File-repo-specific; niche |
| `list=allfileusages`, `list=allredirects`, `list=alltransclusions`, `list=embeddedin`, `list=iwbacklinks`, `list=langbacklinks`, `list=querypage`, `list=pagepropnames`, `list=pageswithprop`, `list=tags` | Niche; add on demand |
| `prop=iwlinks`, `prop=pageprops`, `prop=pageimages`, `prop=linkshere`, `prop=transcludedin` | Niche; add on demand |

## Grouping for implementation

### Group A — Search (3 ops, highest value)

All single-page lookups; `searchPages` can use `offset-limit` pagination.

| Operation | `action=` | Key params | Pagination |
|-----------|-----------|------------|------------|
| `searchPages` | `action=query&list=search` | `srsearch={q}`, `srnamespace`, `srlimit` | `offset-limit` via `sroffset` |
| `openSearch` | `action=opensearch` | `search={q}`, `limit` | None (single page) |
| `prefixSearch` | `action=query&list=prefixsearch` | `pssearch={q}`, `psnamespace`, `pslimit` | `offset-limit` via `ppsoffset` |

### Group B — Page content & properties (13 ops)

All `prop=` modules keyed by `titles={title}`. Single-page per page (the
continue token paginates across *pages*, not within one page's properties,
so `restGet` is honest).

| Operation | `prop=` | Key params | Notes |
|-----------|---------|------------|-------|
| `parsePage` | `action=parse` (non-query) | `page={title}`, `prop=text` | Returns rendered HTML |
| `getPageContent` | `prop=revisions` | `titles={title}`, `rvprop=content` | Raw wikitext |
| `getPageInfo` | `prop=info` | `titles={title}` | Length, protection, last edit |
| `getPageCategories` | `prop=categories` | `titles={title}` | Categories with sort keys |
| `getPageLinks` | `prop=links` | `titles={title}`, `plnamespace` | Internal links |
| `getPageImages` | `prop=images` | `titles={title}` | Image files used |
| `getPageExtLinks` | `prop=extlinks` | `titles={title}`, `ellimit` | External links |
| `getPageTemplates` | `prop=templates` | `titles={title}` | Transcluded templates |
| `getPageRedirects` | `prop=redirects` | `titles={title}` | Pages redirecting here |
| `getPageLangLinks` | `prop=langlinks` | `titles={title}`, `lllimit` | Interlanguage links |
| `getPageContributors` | `prop=contributors` | `titles={title}`, `pclimit` | Last contributors |
| `getPageCategoryInfo` | `prop=categoryinfo` | `titles={title}` | Category size/stats |
| `getPageRevisions` | `prop=revisions` | `titles={title}`, `rvlimit`, `rvprop` | Revision history |

### Group C — Catalog lists (9 ops)

All `list=` modules. Most use token-bag continuation (one exception noted).
Now that the `tokenBag` pagination style is supported, these can use
`via: paginate style: tokenBag` for full pagination. A reasonable default
`limit` param controls per-page count.

| Operation | `list=` | Key params | Pagination |
|-----------|---------|------------|------------|
| `listAllPages` | `allpages` | `apprefix`, `apnamespace`, `aplimit` | Token-bag → `paginate style: tokenBag` |
| `listCategoryMembers` | `categorymembers` | `cmtitle={category}`, `cmtype`, `cmlimit` | Token-bag → `paginate style: tokenBag` |
| `listAllCategories` | `allcategories` | `acfrom`, `aclimit` | Token-bag → `paginate style: tokenBag` |
| `listBacklinks` | `backlinks` | `bltitle={title}`, `blnamespace`, `bllimit` | Token-bag → `paginate style: tokenBag` |
| `listUserContribs` | `usercontribs` | `ucuser={user}`, `uclimit`, `ucnamespace` | Token-bag → `paginate style: tokenBag` |
| `listLogEvents` | `logevents` | `letype`, `lelimit`, `leuser` | Token-bag → `paginate style: tokenBag` |
| `listRandom` | `random` | `rnnamespace`, `rnlimit` | Token-bag → `paginate style: tokenBag` |
| `listAllUsers` | `allusers` | `augroup`, `aulimit` | Token-bag → `paginate style: tokenBag` |
| `listProtectedTitles` | `protectedtitles` | `ptnamespace`, `ptlimit` | Token-bag → `paginate style: tokenBag` |

### Group D — Site metadata + user lookup (3 ops)

| Operation | Module | Key params | Notes |
|-----------|--------|------------|-------|
| `getSiteInfo` | `meta=siteinfo` | `siprop=general` | Wiki name, URL, etc. |
| `getUserInfo` | `list=users` | `ususers={user}`, `usprop=groups\|editcount` | Public user info |
| `listExtUrlUsage` | `list=exturlusage` | `euquery={url}`, `eulimit` | Pages linking to URL |

## Implementation phases

### Phase 0 — Live shape probe

Probe the `searchPages` and `prefixSearch` `offset` params to confirm
`offset-limit` pagination works as expected. Also probe `parsePage` to
confirm the response shape (it lives outside the `query` wrapper — it's
at `{parse: ...}` not `{query: {parse: ...}}`).

### Phase 1 — Group A (Search)

Add 3 operations: `searchPages` (paginate offset-limit), `openSearch`
(restGet), `prefixSearch` (paginate offset-limit).

This is the highest-value addition — searching Wikipedia is the primary
research use case.

### Phase 2 — Group B (Page content & properties)

Add 13 operations. Start with `getPageContent`, `getPageInfo`, and
`parsePage` (the most-used page reads), then the remaining 10.

### Phase 3 — Group C (Catalog lists)

Add 9 operations. Start with `listCategoryMembers` and `listAllPages`
(the most common catalog queries), then the rest.

### Phase 4 — Group D (Site metadata + user lookup)

Add 3 operations: `getSiteInfo`, `getUserInfo`, `listExtUrlUsage`.

## Framework note — `action=parse` response shape (no helper needed)

Unlike `action=query` which nests every sub-module under `query`, the
`action=parse` module returns its result at `{parse: {...}}`. The guide's
`responseShape` describes `format: json` at the top level; individual
operations' `path` declarations (which all point at `/w/api.php`) share
 the common params `action` and `format`. For `parsePage`, the output is
`{parse: {title, pageid, text: {*}}, ...}` — the `text` key contains the
rendered HTML. This shape difference is handled naturally by the recipe
framework (each operation's response docs in `guide.md` describe the
expected output).

## Token-bag continuation — now supported

The existing `listRecentChanges` and most proposed `list=` modules use
MediaWiki's **token-bag continuation** (a dict of keys like
`{rccontinue, continue}`) rather than a single cursor string. This is
now supported by the `tokenBag` pagination style added to the framework.

The existing `listRecentChanges` operation has been updated from
`via: restGet` to `via: paginate style: tokenBag` with
`continuationParams: [continue.rccontinue, continue.continue]`. The
tokenBag style reads each continuation key from the response (via
dot-delimited JSON paths) and merges them into the next request's query
params under their bare key names (e.g. `rccontinue`, `continue`),
matching MediaWiki's continuation protocol. Pagination stops when the
`continue` object is absent or empty.

- `searchPages` and `prefixSearch` use integer offsets (`sroffset`,
  `ppsoffset`) — these fit the `offset-limit` pagination style and
  should use `via: paginate style: offset-limit`.
- All other `list=` modules can now use `via: paginate style: tokenBag`
  with their module-specific `*continue` key plus the generic `continue`
  key in `continuationParams`.

## Testing

Follow the boe.es pattern — tests are co-located with the guide:

- **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated live
  coverage: parses the recipe, executes **every** defined operation
  against `https://en.wikipedia.org/w/api.php`, asserts each response
  has the expected shape (status 200 + non-empty body with at least the
  expected keys in the JSON). Skipped in bare CI.
- **`helper.test.ts`** — Only needed if a transform is introduced. No
  helper transforms are proposed in this plan, so this file is not
  needed.

## Files touched

| File | Action |
|------|--------|
| `guide.md` | Add 28 new operations |
| `endpoint-coverage.test.ts` | Create with 29 operation assertions (1 existing + 28 new) |
| `helper.ts` | Untouched (no transforms needed) |

## Out of scope / deliberate omissions

- **Write/mutation actions** (`edit`, `delete`, `move`, `upload`, `watch`,
  `protect`, `rollback`, `patrol`, `block`, `emailuser`, `import`,
  `undelete`, `options`, `userrights`, `setpagelanguage`). These are
  explicitly out of scope for a research-aide tool.
- **Authenticated-user modules** (`watchlist`, `watchlistraw`,
  `meta=userinfo`, `meta=tokens`). The guide declares `auth: none`.
- **Niche list/prop modules** (see table above). These can be added when
  a use case demands them.
- **Generator queries** (using one module as a generator for another).
  Powerful but complex; the framework's `params` model doesn't express
  generator wiring naturally. Skip for now.

---

## Implementation notes (shipped 2026-08-07)

All 28 planned operations shipped (+ the existing `listRecentChanges`),
verified live against `https://en.wikipedia.org/w/api.php` (30/30 green with
`HOST_INTEGRATION=1`; bare CI and repo `test:ci` green). **No helper**
(`helper.ts` absent), **no new WAF** — the Action API has no bot wall and is
reachable via plain HTTP.

Deviations from this frozen plan (each from a Phase 0 live probe):

1. **`prefixSearch` offset param is `psoffset`, not `ppsoffset`.** The API
   returns "Unrecognized parameter: ppsoffset" and the continue key is
   `continue.psoffset`. The guide uses `pageParam: psoffset` (the plan's
   Group A table said `ppsoffset`, a doc typo).
2. **`listAllUsers` continuation key is `aufrom`, not a `aucontinue`-style
   key.** Live probe shows `continue.aufrom` (e.g. a cursor string). The
   guide reads `continue.aufrom` + `continue.continue`.
3. **`listExtUrlUsage` continuation key is `eucontinue`** (live probe;
   `continue.eucontinue`), not an `eucfrom` offset style. The guide reads
   `continue.eucontinue` + `continue.continue`.
4. **All other Group C continuation keys confirmed live and match the
   framework's `tokenBag` conventions**: allpages=`apcontinue`,
   categorymembers=`cmcontinue`, allcategories=`accontinue`, backlinks=
   `blcontinue`, usercontribs=`uccontinue`, logevents=`lecontinue`,
   random=`rncontinue`, protectedtitles=`ptcontinue`.
5. **`parsePage` and `openSearch` response shapes confirmed:** `parsePage`
   returns `{parse: {title, pageid, text: {"*": HTML}}}` (outside the
   `query` wrapper, `via: restGet`); `openSearch` returns a bare 4-element
   array (`via: restGet`, test asserts `Array.isArray` + `length === 4`).
6. **All `via: restGet` ops require an explicit `via`** — the 15 non-paginate
   ops are written `via: restGet` (the framework has no default for `via`).

Tests: `endpoint-coverage.test.ts` created with 29 op assertions + 1 parse
baseline (30 total), gated on `HOST_INTEGRATION=1`, using the shared
`withTempDirs` harness and a per-file `fetchOp` dispatching `paginate` vs
`restGet`. Skipped in bare CI (all `it.skip`).
