---
kind: api
domains:
  - gitlab.com
shortName: GitLab
icon: 🦊
apiHost: https://gitlab.com
auth:
  kind: static-key
  secretRefs:
    Authorization: api_key
  optional:
    - api_key
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-15"
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

  - name: getAuthenticatedUser
    via: restGet
    path: /api/v4/user
    accept: json

  - name: listUsers
    via: paginate
    path: /api/v4/users
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 10
    params:
      username:
        description: >
          Look up a single user by exact username (returns a one-element
          array).
      search:
        description: Search users by name/path substring.
      order_by:
        description: id (default) | username | created_at.
      sort:
        description: asc | desc.
      active:
        description: Return only active users (true/false).
      blocked:
        description: Return only blocked users (true/false).
      per_page:
        description: Items per page.
        default: 10
      page:
        description: 1-based page number.

  - name: getUser
    via: restGet
    path: /api/v4/users/{id}
    accept: json
    params:
      id:
        description: User ID. Passed as a path token.
---
# GitLab — GitLab.com REST API (read-only)

Read-only access to GitLab.com via the REST API (`https://gitlab.com/api/v4`).
**Optional auth** (see Auth below): unauthenticated 10/min for public
projects/data; with a PAT, 60/min plus the users family (which is **auth-gated
on GitLab.com** — 403 Forbidden anonymously). Root of all paths is `/api/v4`.

## Auth

`Authorization: Bearer <PAT>` header, **optional** (`auth.optional`):
10 requests/min unauthenticated → 60/min with a PAT. Provision the PAT once:

```sh
/api secrets gitlab.com api_key "Bearer glpat-..."
```

The store value is injected **verbatim** as the `Authorization` header, so it
must include the `Bearer` scheme prefix (a bare token is rejected with 401).
When absent, calls proceed unauthenticated with the
`auth: ok (optional … not provisioned)` footer; when present, **every op** gets
the injected header (SSRF-guarded redirects + cache-skip) and the 60/min rate
with the `auth: ok (optional provisioned)` footer. The value never enters agent
context.

> **Reading users needs user-read scope.** The users ops below
> (`getAuthenticatedUser`, `listUsers`, `getUser`) require a token with
> permission to read users — a classic `read_api`/`read_user` scope, or a
> **fine-grained PAT with the `User: Read` permission**. Without it they
> return `403 insufficient_granular_scope`; the project ops work with any
> valid token.

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

### `getAuthenticatedUser` — The authenticated user (auth-gated)

`GET /api/v4/user` returns the profile of the token's owner (`id`,
`username`, `name`, `state`, `web_url`, …). **Requires the token** (401
without it) — the crisp auth-gated proof.

### `listUsers` — List users (auth-gated)

`GET /api/v4/users` (paginated root array) — list users, optionally narrowed
by `search` or an exact `username`; terminates on the empty array `[]` past
the last page. **Auth-gated** (403 anonymously; see the Auth section's scope
note).

### `getUser` — Get a single user (auth-gated)

`GET /api/v4/users/{id}` returns one user by numeric `id`. **Auth-gated** (403
anonymously).

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

## Users family

The users ops (`getAuthenticatedUser`, `listUsers`, `getUser`) were
originally deferred here as auth-gated (verified 2026-08-11: `GET /api/v4/users`,
`GET /users?search=…`, and `GET /users/{id}` all return 403 Forbidden
anonymously), and now ship with the optional token. Only an exact
`users?username=…` lookup worked anonymously; with the token the whole family
is reachable (subject to the user-read scope note in Auth).

## Rate / usage notes

- No key required for the project ops; the optional token lifts 10/min →
  60/min and unlocks the users family. GitLab.com rate-limits anonymous API
  traffic (observed `ratelimit-limit: 500`/min per IP, 2026-08-11). Space
  requests out; prefer narrow `search` and bounded pages.
- Fully read-only: only GET semantics ship. The Search API
  (`/search?scope=…`), members, merge requests, groups, and every
  write/mutation/auth-admin endpoint are out of scope (auth-gated or mutating).

## Terms

GitLab.com API — see <https://about.gitlab.com/terms/>.
