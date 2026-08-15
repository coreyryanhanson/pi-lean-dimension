---
kind: api
domains:
  - github.com
shortName: GitHub
icon: 🐙
apiHost: https://api.github.com
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
docs: https://docs.github.com/en/rest
operations:
  - name: searchRepos
    via: paginate
    path: /search/repositories
    accept: json
    pagination:
      # GitHub's ?page=N is a true page index (not a row offset) — the page
      # style advances by +1 per page, unlike offset-limit (row semantics).
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 2
    params:
      q:
        description: Search query (required by the GitHub search endpoint).
        required: true
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 2

  # ── Group A — Repository info ────────────────────────────────────
  - name: listOrgRepos
    via: paginate
    path: /orgs/{org}/repos
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      type:
        description: All, public, private, forks, sources, member, internal.
      sort:
        description: created, updated, pushed, full_name.
      direction:
        description: asc or desc.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getRepo
    via: restGet
    path: /repos/{owner}/{repo}
    accept: json

  - name: getRepoLanguages
    via: restGet
    path: /repos/{owner}/{repo}/languages
    accept: json

  - name: getRepoTopics
    via: restGet
    path: /repos/{owner}/{repo}/topics
    accept: json

  - name: listRepoTags
    via: paginate
    path: /repos/{owner}/{repo}/tags
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listRepoContributors
    via: paginate
    path: /repos/{owner}/{repo}/contributors
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      anon:
        description: Set to 1 to include anonymous contributors.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listPublicRepos
    via: paginate
    path: /repositories
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      since:
        description: A repository ID. Only repositories with an ID greater than this are returned.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listUserRepos
    via: paginate
    path: /users/{username}/repos
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      type:
        description: all, owner, member.
      sort:
        description: created, updated, pushed, full_name.
      direction:
        description: asc or desc.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listRepoActivities
    via: paginate
    path: /repos/{owner}/{repo}/activity
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      direction:
        description: asc or desc (default desc).
      activity_type:
        description: push, force_push, branch_creation, branch_deletion, merge, merge_queue_merge, pull_request_open, pull_request_close, pull_request_merge, release.
      actor:
        description: A GitHub username to filter activities by.
      time_period:
        description: A GitHub username to filter activities by.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  # ── Group B — Repository contents ────────────────────────────────
  - name: getRepoReadme
    via: restGet
    path: /repos/{owner}/{repo}/readme
    accept: json
    params:
      ref:
        description: The name of the commit/branch/tag. Default is the repository's default branch.

  - name: getRepoContent
    via: restGet
    path: /repos/{owner}/{repo}/contents/{path}
    accept: json
    params:
      ref:
        description: The name of the commit/branch/tag. Default is the repository's default branch.

  # ── Group C — Commits & branches ─────────────────────────────────
  - name: listCommits
    via: paginate
    path: /repos/{owner}/{repo}/commits
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      sha:
        description: SHA or branch to start listing commits from.
      path:
        description: Only commits containing this file path.
      author:
        description: GitHub login or email to filter commits by author.
      since:
        description: Only commits after this ISO 8601 timestamp.
      until:
        description: Only commits before this ISO 8601 timestamp.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getCommit
    via: restGet
    path: /repos/{owner}/{repo}/commits/{ref}
    accept: json

  - name: compareCommits
    via: restGet
    path: /repos/{owner}/{repo}/compare/{basehead}
    accept: json

  - name: listCommitBranches
    via: paginate
    path: /repos/{owner}/{repo}/commits/{ref}/branches-where-head
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listCommitPulls
    via: paginate
    path: /repos/{owner}/{repo}/commits/{ref}/pulls
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listBranches
    via: paginate
    path: /repos/{owner}/{repo}/branches
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      protected:
        description: Set to true to return only protected branches.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getBranch
    via: restGet
    path: /repos/{owner}/{repo}/branches/{branch}
    accept: json

  # ── Group D — Issues & comments ──────────────────────────────────
  - name: listRepoIssues
    via: paginate
    path: /repos/{owner}/{repo}/issues
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      state:
        description: open, closed, or all (default open).
      labels:
        description: Comma-separated label names to filter by.
      sort:
        description: created, updated, comments.
      direction:
        description: asc or desc.
      since:
        description: Only issues updated at or after this ISO 8601 timestamp.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getIssue
    via: restGet
    path: /repos/{owner}/{repo}/issues/{number}
    accept: json

  - name: getIssueComment
    via: restGet
    path: /repos/{owner}/{repo}/issues/comments/{id}
    accept: json

  - name: listIssueComments
    via: paginate
    path: /repos/{owner}/{repo}/issues/{number}/comments
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      since:
        description: Only comments updated at or after this ISO 8601 timestamp.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  # ── Group E — Pull requests & comments ───────────────────────────
  - name: listPulls
    via: paginate
    path: /repos/{owner}/{repo}/pulls
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      state:
        description: open, closed, or all (default open).
      head:
        description: Filter by head user or branch (e.g. `user:ref-name`).
      base:
        description: Filter by base branch name.
      sort:
        description: created, updated, popularity, long-running.
      direction:
        description: asc or desc.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getPull
    via: restGet
    path: /repos/{owner}/{repo}/pulls/{number}
    accept: json

  - name: listPullCommits
    via: paginate
    path: /repos/{owner}/{repo}/pulls/{number}/commits
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listPullFiles
    via: paginate
    path: /repos/{owner}/{repo}/pulls/{number}/files
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listPullReviewComments
    via: paginate
    path: /repos/{owner}/{repo}/pulls/{number}/comments
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      since:
        description: Only comments updated at or after this ISO 8601 timestamp.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getPullReviewComment
    via: restGet
    path: /repos/{owner}/{repo}/pulls/comments/{id}
    accept: json

  # ── Group F — Search ─────────────────────────────────────────────
  - name: searchCode
    via: paginate
    path: /search/code
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Search query (required). Code search requires `user:`/`org:`/`repo:` scoping.
        required: true
      sort:
        description: indexed or best-match (default best-match).
      order:
        description: asc or desc (default desc).
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: searchIssues
    via: paginate
    path: /search/issues
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Search query (required).
        required: true
      sort:
        description: comments, reactions, reactions-+1, created, updated (default best-match).
      order:
        description: asc or desc (default desc).
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: searchUsers
    via: paginate
    path: /search/users
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Search query (required).
        required: true
      sort:
        description: followers, repositories, joined (default best-match).
      order:
        description: asc or desc (default desc).
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: searchCommits
    via: paginate
    path: /search/commits
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Search query (required).
        required: true
      sort:
        description: author-date, committer-date (default best-match).
      order:
        description: asc or desc (default desc).
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: searchTopics
    via: paginate
    path: /search/topics
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Search query (required).
        required: true
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: searchLabels
    via: paginate
    path: /search/labels
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      q:
        description: Label search query (required), e.g. `bug`.
        required: true
      repository_id:
        description: The id of the repository to scope the label search to (required).
        required: true
      sort:
        description: created, updated (default best-match).
      order:
        description: asc or desc (default desc).
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  # ── Group G — Users & organizations ──────────────────────────────
  - name: getUser
    via: restGet
    path: /users/{username}
    accept: json

  - name: listUsers
    via: paginate
    path: /users
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      since:
        description: A user ID. Only users with an ID greater than this are returned.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getOrg
    via: restGet
    path: /orgs/{org}
    accept: json

  - name: listOrgs
    via: paginate
    path: /organizations
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      since:
        description: An org ID. Only orgs with an ID greater than this are returned.
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listUserOrgs
    via: paginate
    path: /users/{username}/orgs
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  # ── Group H — Releases ───────────────────────────────────────────
  - name: listReleases
    via: paginate
    path: /repos/{owner}/{repo}/releases
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: getLatestRelease
    via: restGet
    path: /repos/{owner}/{repo}/releases/latest
    accept: json

  - name: getReleaseByTag
    via: restGet
    path: /repos/{owner}/{repo}/releases/tags/{tag}
    accept: json

  # ── Group I — Git database ───────────────────────────────────────
  - name: getGitBlob
    via: restGet
    path: /repos/{owner}/{repo}/git/blobs/{sha}
    accept: json

  - name: getGitTree
    via: restGet
    path: /repos/{owner}/{repo}/git/trees/{sha}
    accept: json
    params:
      recursive:
        description: Set to 1 to return the tree recursively.

  - name: listMatchingRefs
    via: restGet
    path: /repos/{owner}/{repo}/git/matching-refs/{ref}
    accept: json

  - name: getGitRef
    via: restGet
    path: /repos/{owner}/{repo}/git/ref/{ref}
    accept: json

  # ── Group J — Activity / events ──────────────────────────────────
  - name: listPublicEvents
    via: paginate
    path: /events
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listRepoEvents
    via: paginate
    path: /repos/{owner}/{repo}/events
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listRepoNetworkEvents
    via: paginate
    path: /networks/{owner}/{repo}/events
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listUserPublicEvents
    via: paginate
    path: /users/{username}/events
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  - name: listUserReceivedEvents
    via: paginate
    path: /users/{username}/received_events/public
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 30

  # ── Group K — Actions CI / checks / authenticated reads ─────────
  - name: getAuthenticatedUser
    via: restGet
    path: /user
    accept: json

  - name: listWorkflowRuns
    via: paginate
    path: /repos/{owner}/{repo}/actions/runs
    accept: json
    pagination:
      style: page
      itemsPath: workflow_runs
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      owner:
        description: Repository owner. Passed as a path token.
      repo:
        description: Repository name. Passed as a path token.
      branch:
        description: Only returns workflow runs associated with this branch.
      status:
        description: >
          completed | action_required | cancelled | failure | neutral |
          skipped | stale | success | timed_out | in_progress | queued |
          requested | waiting.
      event:
        description: Returns workflow runs by the event that triggered them (push, pull_request, …).
      per_page:
        description: Per-page count.
        default: 30
      page:
        description: 1-based page number.

  - name: getWorkflowRun
    via: restGet
    path: /repos/{owner}/{repo}/actions/runs/{run_id}
    accept: json
    params:
      owner:
        description: Repository owner. Passed as a path token.
      repo:
        description: Repository name. Passed as a path token.
      run_id:
        description: The unique identifier of the workflow run. Passed as a path token.

  - name: listWorkflowRunsForWorkflow
    via: paginate
    path: /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
    accept: json
    pagination:
      style: page
      itemsPath: workflow_runs
      pageParam: page
      pageSizeParam: per_page
      pageSize: 30
    params:
      owner:
        description: Repository owner. Passed as a path token.
      repo:
        description: Repository name. Passed as a path token.
      workflow_id:
        description: The ID of the workflow (or its file name, e.g. `ci.yml`). Passed as a path token.
      branch:
        description: Only returns runs associated with this branch.
      status:
        description: Same status filter as `listWorkflowRuns`.
      per_page:
        description: Per-page count.
        default: 30
      page:
        description: 1-based page number.

  - name: listCheckRunsForRef
    via: restGet
    path: /repos/{owner}/{repo}/commits/{ref}/check-runs
    accept: json
    params:
      owner:
        description: Repository owner. Passed as a path token.
      repo:
        description: Repository name. Passed as a path token.
      ref:
        description: "The commit SHA or branch name whose check runs to list. Passed as a path token."
      filter:
        description: latest (default) | all — filters check runs by their most recent action.
      per_page:
        description: Per-page count.
        default: 30
      page:
        description: 1-based page number.
---
# GitHub — REST API metadata & search

GitHub's REST API exposes repo/user/org metadata, code, issues, PRs, commits,
releases, Actions CI status, and activity, with **optional auth** (see Auth
below): 60/hr unauthenticated (10/min for search), 5000/hr with a PAT. GitHub
ToS permits API access; this recipe reads metadata + CI status only.

## Auth

`Authorization: Bearer <PAT>` header, **optional** (`auth.optional`):
60 requests/hr unauthenticated → 5000/hr with a PAT. Provision the PAT once:

```sh
/api secrets github.com api_key "Bearer ghp_..."
```

The store value is injected **verbatim** as the `Authorization` header, so it
must include the `Bearer` scheme prefix (a bare token is rejected with 401).
When absent, calls proceed unauthenticated under the 60/hr rate with the
`auth: ok (optional … not provisioned)` footer; when present, **every op** gets
the injected header (SSRF-guarded redirects + cache-skip) and the 5000/hr rate
with the `auth: ok (optional provisioned)` footer. The value never enters agent
context. `searchCode` requires auth scoping; `getAuthenticatedUser` and the
Actions/checks ops (Group K) need a token — the rest work either way.

## Operations

### Group A — Repository info

- `listOrgRepos` — `GET /orgs/{org}/repos` (paginated flat array).
- `getRepo` — `GET /repos/{owner}/{repo}` single repo details.
- `getRepoLanguages` — `GET /repos/{owner}/{repo}/languages` flat `language → bytes` map.
- `getRepoTopics` — `GET /repos/{owner}/{repo}/topics` returns `{names: []}`.
- `listRepoTags` — `GET /repos/{owner}/{repo}/tags` (paginated).
- `listRepoContributors` — `GET /repos/{owner}/{repo}/contributors` (paginated; `anon`).
- `listPublicRepos` — `GET /repositories` (paginated; `since`).
- `listUserRepos` — `GET /users/{username}/repos` (paginated; `type`/`sort`/`direction`).
- `listRepoActivities` — `GET /repos/{owner}/{repo}/activity` (paginated; 2025 repo-activity endpoint).

### Group B — Repository contents

- `getRepoReadme` — `GET /repos/{owner}/{repo}/readme` (optional `ref`).
- `getRepoContent` — `GET /repos/{owner}/{repo}/contents/{path}` file or directory listing (optional `ref`).

### Group C — Commits & branches

- `listCommits` — `GET /repos/{owner}/{repo}/commits` (paginated; `sha`/`path`/`author`/`since`/`until`).
- `getCommit` — `GET /repos/{owner}/{repo}/commits/{ref}`.
- `compareCommits` — `GET /repos/{owner}/{repo}/compare/{basehead}` (`{base}...{head}`).
- `listCommitBranches` — `GET /repos/{owner}/{repo}/commits/{ref}/branches-where-head` (paginated).
- `listCommitPulls` — `GET /repos/{owner}/{repo}/commits/{ref}/pulls` (paginated).
- `listBranches` — `GET /repos/{owner}/{repo}/branches` (paginated; `protected`).
- `getBranch` — `GET /repos/{owner}/{repo}/branches/{branch}`.

### Group D — Issues & comments

- `listRepoIssues` — `GET /repos/{owner}/{repo}/issues` (paginated; `state`/`labels`/`sort`/`since`).
- `getIssue` — `GET /repos/{owner}/{repo}/issues/{number}`.
- `getIssueComment` — `GET /repos/{owner}/{repo}/issues/comments/{id}`.
- `listIssueComments` — `GET /repos/{owner}/{repo}/issues/{number}/comments` (paginated; `since`).

### Group E — Pull requests & comments

- `listPulls` — `GET /repos/{owner}/{repo}/pulls` (paginated; `state`/`head`/`base`/`sort`).
- `getPull` — `GET /repos/{owner}/{repo}/pulls/{number}`.
- `listPullCommits` — `GET /repos/{owner}/{repo}/pulls/{number}/commits` (paginated).
- `listPullFiles` — `GET /repos/{owner}/{repo}/pulls/{number}/files` (paginated).
- `listPullReviewComments` — `GET /repos/{owner}/{repo}/pulls/{number}/comments` (paginated).
- `getPullReviewComment` — `GET /repos/{owner}/{repo}/pulls/comments/{id}`.

### Group F — Search

All search ops return `{total_count, items[]}` and require `q`. `searchCode`
requires `user:`/`org:`/`repo:` scoping in the query for unauthenticated use.
`searchLabels` also requires `repository_id`.

- `searchCode`, `searchIssues`, `searchUsers`, `searchCommits`, `searchTopics`, `searchLabels`.

### Group G — Users & organizations

- `getUser` — `GET /users/{username}`.
- `listUsers` — `GET /users` (paginated; `since`).
- `getOrg` — `GET /orgs/{org}`.
- `listOrgs` — `GET /organizations` (paginated; `since`).
- `listUserOrgs` — `GET /users/{username}/orgs` (paginated).

### Group H — Releases

- `listReleases` — `GET /repos/{owner}/{repo}/releases` (paginated).
- `getLatestRelease` — `GET /repos/{owner}/{repo}/releases/latest`.
- `getReleaseByTag` — `GET /repos/{owner}/{repo}/releases/tags/{tag}`.

### Group I — Git database

- `getGitBlob` — `GET /repos/{owner}/{repo}/git/blobs/{sha}` (content base64-encoded).
- `getGitTree` — `GET /repos/{owner}/{repo}/git/trees/{sha}` (`recursive`).
- `listMatchingRefs` — `GET /repos/{owner}/{repo}/git/matching-refs/{ref}`.
- `getGitRef` — `GET /repos/{owner}/{repo}/git/ref/{ref}`.

### Group J — Activity / events

- `listPublicEvents` — `GET /events`.
- `listRepoEvents` — `GET /repos/{owner}/{repo}/events`.
- `listRepoNetworkEvents` — `GET /networks/{owner}/{repo}/events`.
- `listUserPublicEvents` — `GET /users/{username}/events`.
- `listUserReceivedEvents` — `GET /users/{username}/received_events/public`.

### Group K — Actions CI / checks / authenticated reads

- `getAuthenticatedUser` — `GET /user` — the authenticated user's profile.
  **Requires the token** (401 without it).
- `listWorkflowRuns` — `GET /repos/{owner}/{repo}/actions/runs` (paginated
  `workflow_runs`) — recent Actions runs; filter by `branch`/`status`/`event`.
- `getWorkflowRun` — `GET /repos/{owner}/{repo}/actions/runs/{run_id}` — one
  run's full status + timings.
- `listWorkflowRunsForWorkflow` — `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs`
  (paginated) — runs of a single workflow file (e.g. `ci.yml`).
- `listCheckRunsForRef` — `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
  — the check runs attached to a commit `ref`; response is
  `{total_count, check_runs[]}`.

The Actions runs ops are `paginate` (page style, `itemsPath: workflow_runs`);
the rest are `restGet`. `getAuthenticatedUser` is the only one that 401s
unauthenticated — the others serve public-repo data either way (auth raises the
rate limit and enables private-repo reads).

## Pagination

GitHub's canonical next-page signal is the RFC 5988 `Link` header, which the
v1 `pagination.style` set has no style for (see the schema-gap note below).
All paginated ops here use `style: page` with `pageParam: page` /
`pageSizeParam: per_page` — GitHub accepts `?page=N&per_page=M` on every list
endpoint alongside the `Link` header, and `?page=N` is a true **page index**
(advances by +1), so `style: page` — not `offset-limit` (row-offset advance) —
is the correct mapping.

List endpoints that return a **bare top-level JSON array** (repos, commits,
branches, issues, pulls, events, etc.) set `itemsPath: $` — `resolveJsonPath`'s
root sentinel — so the paginator reads the body array directly. The search
endpoints (and `getRepoTopics`' `{names}` envelope is a `restGet`) use
`itemsPath: items` on their `{total_count, items[]}` envelope.

## ⚠ Schema gap — header-based pagination (escape-valve evidence)

**The canonical next-page signal is the RFC 5988 `Link` HTTP header**
(`Link: <…&page=2>; rel="next", <…&page=500>; rel="last"`), **not a body
field**. The v1 `pagination.style` set has no header-based style —
`nextLinkPath` is a JSON body path, not a header path.

This recipe uses `style: page` with `pageParam: page`, which works, but it
does **not** exercise the Link-header path that is the candidate's whole
point. A `paginate` that only reads body fields misses every Link-header API —
the header-aware pagination style is the escape-valve generalization this
recipe evidences.

**G11 (rate-limit headers):** `X-RateLimit-Limit/Remaining/Used/Reset` are
documented signals the transport does not surface; noted as a transport-policy
escape-valve candidate.

## Terms

GitHub Terms of Service permit API access. Recipe reads metadata only — no
re-publishing of repository content.
