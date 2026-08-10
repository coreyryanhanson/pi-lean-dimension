# AGENTS.md — pi-lean-host (package)

> Declarative HTTP API client leaf of the
> [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is a stub.** For the suite overview, dev commands, registered
> tools/commands summary, testing strategy, and TypeScript quirks, see
> [`../../AGENTS.md`](../../AGENTS.md). For the design docs, see
> [`../../docs/design/pi-lean-host.md`](../../docs/design/pi-lean-host.md) and
> [`../../docs/design/api-helper-escape-valve.md`](../../docs/design/api-helper-escape-valve.md).

## What this package is

- Registers **`api-guide`**, **`api-fetch`**, and **`api-learn`** tools
  (Sprint 4) for declarative HTTP API interaction.
- Registers the **`/api`** command namespace (Sprint 6) with
  `on|off|learn|status|helpers` subcommands — an independent peer toggle
  that composes freely with portal's `/web`.
- Manages the **`api` status bar glyph** (Sprint 6), shown only when `/api`
  is on and a host guide is active for the current domain. Off-state: `○ api`.
- Declares `pi-lean-portal` as an **optional peer dependency**. Host-only
  installs are valid — the tools work standalone. When co-installed, host
  registers a recipe-stripped `projectToGuide()` projection with portal's
  guide provider registry (Sprint 7) for surfacing in the navigation footer.

## Key architectural properties

- **Host-only**: zero static imports from `pi-lean-portal` or `pi-lean-search`.
  Enforced by `__tests__/host-only-boundary.test.ts`.
- **One parser, two call sites**: `parseApiGuide()` (Sprint 2) validates
  before write (`api-learn`) and before use (loader).
- **No mutations v1**: only `restGet` and `paginate` helpers; `via` accepts
  only those two.
- **Post-response transform (gated)**: an op may declare `transform: true` to
  run a named `transform(data, ctx)` export from its `helper.ts` after
  `parseResponse` (`restGet`) or per-item (`paginate`), shaping the parsed
  body before it is returned. Graceful by contract — a throw is caught
  per-call and the agent gets the raw untransformed data with a warning,
  never a disabled op (`paginate` routes failed items to a `failedItems`
  group; no item dropped). Cannot inspect response headers. Classified
  built-in in `api-helper-escape-valve.md` §12.
- **Multi-recipe domains**: a domain may claim multiple guides (each in its
  own directory, e.g. `archive.org` + `archive.org-wayback`). `buildDomainMap`
  is multi-valued (`Record<string, string[]>`); `api-fetch` resolves the
  operation by name across all matching guides (helper routed by directory
  name, not the routing `domain`); `api-guide` shows a disambiguation menu and
  accepts a `guide` selector. Optional `organization:` (catalog grouping) and
  `description:` (disambiguation summary) fields are recipe-slice only.
- **Peer toggle**: `/api` additive-on / filter-off contract verified against
  `/web` being active.

## Files

- `index.ts` — entry: registers tools (Sprint 4), `/api` toggle (Sprint 6),
  and optional portal provider registration (Sprint 7).
- `core/ssrf-guard.ts` — minimal SSRF guard: blocks loopback, private
  RFC1918 ranges, and cloud metadata endpoints on **server-supplied** `nextLink`
  URLs in `paginate` only. Agent-supplied `restGet` URLs are not guarded (the
  agent has bash; see the design doc's "SSRF guard" section).
- `core/guide-loader.ts` — Guide type + multi-valued domain map (`buildDomainMap` → `Record<string, string[]>`).
- `core/guide-store.ts` — guide store; `findGuidesByDomain(domain)` returns `{ guide, dirName }[]` (directory name is the guide identity + helper-routing key).
- `core/api-guide-types.ts` — Sprint 2: `ApiGuide extends Guide` recipe schema types (incl. optional `organization` / `description`), `ParseError`, constants (`GATHER_ALL_MAX_FALLBACK`).
- `core/parse-api-guide.ts` — Sprint 2: the single `parseApiGuide()` parser (one parser, two call sites), `projectToGuide()`, `loadApiGuidesFromDir()`, `formatApiGuideCatalog()`.
- `README.md` — user-facing docs.
- `core/verify-ship-manifest.ts` — Sprint 8: vendored ship-manifest helper
  (host-only safe copy of the portal utility) for the package manifest test.
- `api-guides/` — Sprint 8: bundled reference recipes (GitHub-only, not in
  npm tarball; inert — copy to use). Recipe-validity tests co-located
  alongside their recipe under `api-guides/<domain>/` are auto-discovered
  by vitest and excluded from the tarball.
- `__tests__/host-only-boundary.test.ts` — structural: no portal/search
  source imports.
- `__tests__/smoke.test.ts` — Sprint 1 loads + vendored primitives work.
- `__tests__/parse-api-guide.test.ts` — Sprint 2 schema/parser/projection/catalog tests.
- `__tests__/ship-manifest.test.ts` — Sprint 8: tarball manifest verification
  (files coverage + negative assertions for api-guides/ exclusion).
- `__tests__/axis-units.test.ts` — framework axis tests
  (nextLink, XML, cursor, ETag) via mocked transport layer. Runs in bare CI
  (no network). Fixtures in `__tests__/fixtures/axis/`. Recipe-validity tests
  domains live in `api-guides/<domain>/`.
- `api-guides/boe.es/endpoint-coverage.test.ts` — BOE recipe-validity
  tests (operations A/B/C + baseline). Skipped in bare CI; opt in via
  HOST_INTEGRATION=1.
- `api-guides/boe.es/helper.test.ts` — BOE helper transform tests
  (bare CI, always runs) + live endpoint compose tests (HOST_INTEGRATION=1).

## Design docs

- [`../../docs/design/pi-lean-host.md`](../../docs/design/pi-lean-host.md) — full design doc (what and why; includes refactor boundaries and scope discipline).
- [`../../docs/design/api-helper-escape-valve.md`](../../docs/design/api-helper-escape-valve.md) — escape-valve policy (built-in vs local-helper classification, the 15-recipe spread, and rejected candidates).
