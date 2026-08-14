---
kind: api
domains:
  - gitlab.com
shortName: GitLab
icon: 🦊
apiHost: https://gitlab.com
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-11"
docs: https://docs.gitlab.com/api/rest/
operations:
  - name: listProjects
    via: paginate
    path: /api/v4/projects
    accept: json
    gatherAllMax: 1000
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 10
    params:
      page:
        description: >
          1-based page number. Empty array `[]` past the last page
          terminates.
      per_page:
        description: Items per page (default 20, max 100 on GitLab.com; this op's wire value is set by the guide's pageSize — 10).
        default: 10
      search:
        description: Fuzzy name/path search narrows the (otherwise enormous) public project list to a bounded set. Note GitLab.com's `search` can 500 for very sparse terms; prefer distinctive multi-match terms.
      order_by:
        description: Sort field (e.g. `created_at`, `name`, `star_count`).
        default: created_at
      sort:
        description: asc | desc.
        default: desc
      visibility:
        description: 'Filter by visibility: `public`, `internal`, or `private`.'
      topic:
        description: Filter by topic (tag).
      simple:
        description: 'Return only the basic fields (`true`/`false`).'

  - name: getProject
    via: restGet
    path: /api/v4/projects/{id}
    accept: json
    params:
      id:
        description: >
          A project ID (numeric, e.g. `278964`) or a URL-encoded
          namespace path (e.g. `gitlab-org%2Fgitlab`). Prefer the numeric
          ID — the path form must be pre-encoded before insertion.

  - name: listProjectIssues
    via: paginate
    path: /api/v4/projects/{id}/issues
    accept: json
    gatherAllMax: 1000
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 10
    params:
      id:
        description: Project ID or URL-encoded namespace path (e.g. `gitlab-org%2Fgitlab`).
      page:
        description: 1-based page number.
      per_page:
        description: Items per page (wire value set by the guide's pageSize — 10).
        default: 10
      state:
        description: opened | closed | all.
        default: all
      labels:
        description: Comma-separated label names to filter by.
      search:
        description: Search issues for the given text.
      scope:
        description: all | assigned_to_me | created_by_me.
        default: all
      order_by:
        description: created_at | updated_at | priority | due_date | relative_position.
        default: created_at
      sort:
        description: asc | desc.
        default: desc

  - name: getIssue
    via: restGet
    path: /api/v4/projects/{id}/issues/{issue_iid}
    accept: json
    params:
      id:
        description: Project ID or URL-encoded namespace path (e.g. `gitlab-org%2Fgitlab`).
      issue_iid:
        description: Internal issue ID (iid) within the project.
---
# GitLab — GitLab.com REST API (public read-only)

Read-only access to GitLab.com's public data via the REST API
(`https://gitlab.com/api/v4`). Fully unauthenticated for **public**
projects/users data; the guide ships only the anonymous read-only surface.
Root of all paths is `/api/v4`.

## Operations

### `listProjects` — List public projects

Paginated list of public projects. Without `search` this is the *entire*
public project list (millions) — always narrow with `search` (or a
`visibility`/`topic` filter) or page explicitly. Each item is a Project
object (id, `name`, `path_with_namespace`, `description`, `web_url`,
`star_count`, `visibility`, `namespace`, …).

### `getProject` — Get a single project

`GET /api/v4/projects/{id}` returns one Project object. `{id}` is numeric
(ID) or a URL-encoded namespace path.

### `listProjectIssues` — List a project's issues

Paginated list of issues in a public project. Each item carries `iid`,
`title`, `description`, `state`, `labels`, `author`, `created_at`,
`updated_at`, `web_url`, … — a general issue-tracking surface.

### `getIssue` — Get a single issue

`GET /api/v4/projects/{id}/issues/{issue_iid}` returns one issue by its
project-relative `iid`.

## Pagination

Both list ops use GitLab's default **page** style (`page` / `per_page`).
`page` is **1-based** (the framework's page style seeds at 1). GitLab
returns a bare JSON **root array** (`[{...}]`) on every page; the ops'
`itemsPath: $` resolves that root, and pagination **terminates on the empty
array `[]`** past the last page (verified live 2026-08-11). Both list ops
cap `gatherAll` at 1000 items (`gatherAllMax`) so an unfiltered walk cannot
hammer the API or run into the 50k-offset limit below.

> **Header pagination decided, not needed:** GitLab sends `Link: rel="next"`
> and `x-next-page`/`x-page`/`x-total` headers on responses, but because it
> also returns `[]` past the last page, the existing `page` style drives
> pagination with **zero framework change**. No header-aware style is
> introduced (escape-valve decision, recorded 2026-08-11). Note GitLab.com
> refuses offset pagination beyond a 50,000-row window (HTTP 405 with an
> error body, not `[]`) — that only bites unbounded `listProjects` drains,
> which is why `search` narrowing matters.

## Users — deferred (auth-gated on GitLab.com)

The plan scheduled `listUsers` / `getUser` here, but the live probe
(2026-08-11) shows the **Users list family is auth-gated on GitLab.com**:
bare `GET /api/v4/users`, `GET /users?search=…`, and `GET /users/{id}` all
return **403 Forbidden** anonymously. Only an exact `users?username=…`
lookup is anonymous (200, single object). Since this guide is
fully-unauthenticated read-only, the users family is **deferred to the
auth-gated backlog** (Section B), not silently dropped — it becomes a
guide op when token auth lands. Everything the B2 proof needs (page-style
pagination + root-array `itemsPath: $`) is covered by the projects/issues
families.

## Rate / usage notes

- No API key required, but GitLab.com rate-limits anonymous API traffic
  (observed `ratelimit-limit: 500`/min per IP, 2026-08-11). Space requests
  out; prefer narrow `search` and bounded pages.
- Fully read-only: only GET semantics ship. The Search API
  (`/search?scope=…`), members, merge requests, groups, and every
  write/mutation/auth-admin endpoint are out of scope for this no-auth
  guide (auth-gated or mutating).

## Terms

GitLab.com API — see <https://about.gitlab.com/terms/>.
