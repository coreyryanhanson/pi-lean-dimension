# AGENTS.md — pi-lean-host (package)

> Declarative HTTP API client leaf of the
> [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> For the suite overview and TypeScript quirks (nodenext `.js` imports,
> `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedModules`,
> `moduleDetection: force`), see [`../../AGENTS.md`](../../AGENTS.md). For the
> design docs, see [`docs/design/api-secrets-roadmap.md`](docs/design/api-secrets-roadmap.md)
> and [`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md).
>
> Note: the monorepo root `AGENTS.md` predates this package and does not yet
> list it — trust this file for host-specific commands and structure.

## What this package is

- Registers **4 tools**: `api-guide`, `api-fetch`, `api-learn`, `api-probe`.
  `api-probe` is the shape-discovery tool for the authoring loop (fetch an
  exploratory path, summarize the JSON shape, emit a draft YAML op block);
  it never writes the guide.
- Registers the **`/api`** command with `on|off|learn|status/helpers`
  subcommands — an independent peer toggle that composes freely with
  portal's `/web` (additive-on / filter-off semantics).
- Manages the **`api` status bar glyph**, shown as `● api` when `/api` is on
  (colored by learn state) and `○ api` when off.
- Declares `pi-lean-portal` as an **optional peer dependency**. Host-only
  installs are valid. When co-installed, host registers a recipe-stripped
  `projectToGuide()` projection with portal's guide provider registry
  (runtime feature-detect — no static portal import) for surfacing in the
  navigation footer.

## Developer commands

There is no host-specific CI script; tests run via the monorepo vitest config
(`packages/*/**/*.test.ts`). Run from the **monorepo root**:

```bash
npm test                                              # all workspace tests, incl. host
npm run test:ci                                       # excludes chromium/firefox/bench; keeps host
npx vitest run packages/pi-lean-host                  # this package only
npx vitest run packages/pi-lean-host/__tests__/tools.test.ts   # one file
HOST_INTEGRATION=1 npx vitest run packages/pi-lean-host/api-guides/<domain>/  # live endpoint tests
```

`HOST_INTEGRATION=1` opts into live-endpoint recipe-validity tests (co-located
under `api-guides/<domain>/`). Without it they `it.skip`; bare CI stays green.

## Toggle states & focus-mode guard

`/api` has three states, mirroring portal's browser toggle:

- **on** — `api-guide` + `api-fetch` enabled (`api-learn` + `api-probe` off)
- **learn** — on + `api-learn` + `api-probe` (authoring mode)
- **off** — all four disabled

Starts **on**. Defaults are overridable via the `toolsetDefaults` settings tier
read by `pi-tool-masking` (persistKey on the `ToolsetSpec`).

**Focus-mode guard:** actuating subcommands (`on`/`off`/`learn`) are refused
while `pi-tool-masking` holds focus (inclusion mode or allowlist focus) — a
sibling toggle must not write a focus-indistinguishable `{enabled}` entry.
Read-only subcommands (`status`, `helpers`, bare `/api`) stay unguarded.

## Key architectural properties

- **Host-only boundary**: zero static imports from `pi-lean-portal` or
  `pi-lean-search`. Enforced by `__tests__/host-only-boundary.test.ts`.
  Portal integration is a runtime feature-detect (`registerPortalProjection()`),
  re-attempted on `session_start` in case host loads before portal.
- **One parser, two call sites**: `parseApiGuide()` validates before write
  (`api-learn`) and before use (loader). Don't add a second parser.
- **No mutations v1**: `via` accepts only `restGet` and `paginate`.
- **Two distinct transform mechanisms** — do not conflate:
  - **Built-in post-response transform** (gated): an op declares `transform: true`
    to run a named `transform(data, ctx)` export from its `helper.ts` after
    `parseResponse` (`restGet`) or per-item (`paginate`). Graceful by contract —
    a throw is caught per-call and the agent gets the raw data with a warning,
    never a disabled op (`paginate` routes failed items to a `failedItems`
    group; no item dropped). Cannot inspect response headers.
  - **Local user helpers** (`core/local-helpers.ts`): a **pre-call** transform.
    User-authored `helper.ts` lives alongside its guide at
    `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts`, loaded on demand
    via dynamic `import()` when an op sets `helper: true`. It receives the
    agent-supplied params and returns the params the executor uses for URL
    templating / query assembly. One helper per domain is the v1 contract. A
    load failure or execution throw disables the helper for the rest of the
    session. See `api-helper-escape-valve.md` for the built-in vs local-helper
    classification.
- **Multi-recipe domains**: a domain may claim multiple guides (each in its own
  directory, e.g. `archive.org` + `archive.org-wayback`). `buildDomainMap` is
  multi-valued (`Record<string, string[]>`); `api-fetch` resolves the operation
  by name across all matching guides (helper routed by **directory name**, not
  the routing `domain`); `api-guide` shows a disambiguation menu and accepts a
  `guide` selector. Optional `organization:` (catalog grouping) and
  `description:` (disambiguation summary) fields are recipe-slice only.
- **SSRF guard** (`core/ssrf-guard.ts`): blocks loopback, private RFC1918
  ranges, and cloud metadata endpoints on **server-supplied** `nextLink` URLs
  in `paginate` only. Agent-supplied `restGet` URLs are **not** guarded (the
  agent has bash).
- **Response spill** (`core/response-spill.ts`): when `api-fetch` truncates,
  the full JSON is spilled to disk (max 8 files/session, oldest evicted;
  `cleanupAllSpill()` on `session_shutdown`).

## Files

- `index.ts` — entry. Resets module singletons (`resetToggleModuleState`,
  `resetDisabledHelpers`) on every invocation so `/resume` re-loads are
  idempotent — pi reuses the cached extension factory and re-invokes this
  function with the same module-level state.
- `core/` — `api-guide-types.ts` (recipe schema types, `ParseError`,
  `GATHER_ALL_MAX_FALLBACK`), `parse-api-guide.ts` (the parser +
  `projectToGuide()` + `loadApiGuidesFromDir()` + `formatApiGuideCatalog()`),
  `guide-loader.ts` + `guide-store.ts` (multi-valued domain map,
  `findGuidesByDomain` returns `{ guide, dirName }[]`), `helpers.ts`
  (built-in executor helpers), `local-helpers.ts` (user helper loader),
  `helpers-command.ts` (`/api helpers`), `transport.ts` (shared fetch
  pipeline: UA, charset, 429-retry, ETag cache — the sanctioned way to reach
  even WAF'd hosts), `path-template.ts`, `ssrf-guard.ts`, `response-spill.ts`,
  `api-toggle.ts` (`/api` toggle), `portal-projection.ts`,
  `verify-ship-manifest.ts` (vendored host-only copy of the portal utility).
- `tools/` — `api-guide.ts`, `api-fetch.ts`, `api-learn.ts`, `api-probe.ts`,
  `utils.ts`, `index.ts`.
- `__tests__/` — framework structural tests (no network): `smoke`,
  `parse-api-guide`, `all-guides-parse` (every bundled `guide.md` parses
  cleanly), `tools`, `helpers`, `local-helpers`, `api-toggle`,
  `portal-projection`, `render-result`, `response-spill`, `host-only-boundary`,
  `axis-units` (nextLink/XML/cursor/ETag via mocked transport; fixtures in
  `__tests__/fixtures/axis/`), `transform-{restget,paginate,render}`,
  `api-probe`, `ship-manifest` (tarball coverage + asserts `api-guides/` is
  excluded from the npm tarball).

## api-guides/ — bundled reference recipes

`api-guides/<domain>/` holds **reference recipes** (GitHub-only, **not in the
npm tarball**, inert — copy to `~/.pi/agent/pi-lean-host/api-guides/` to use).
Each guide dir ships its own co-located tests (`endpoint-coverage.test.ts`,
`helper.test.ts` when a helper exists) — recipe tests do **not** live in
`__tests__/`; that dir holds framework structural tests only.

- `api-guides/_shared/test-harness.ts` — `itWhen` (live-gate: runs only under
  `HOST_INTEGRATION=1`, else `it.skip`) and the live-gate helper.
- `api-guides/CONTRIBUTING.md` — guide + test layout; **`boe.es` is the
  reference template** — read it first, then copy its pattern.
- `api-guides/WAF-NOTES.md` — central tracker for WAF / rate-limit / bot-detection
  quirks observed against endpoints during coverage-plan drafting.

## Design docs

- [`docs/design/api-secrets-roadmap.md`](docs/design/api-secrets-roadmap.md)
  — deferred secrets-store track: the two-threat model (at-rest vs
  transcript/output-channel exfiltration), the Secret Service primary / plaintext
  fallback decision, and the checklist for the first keyed-guide build.
- [`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md)
  — escape-valve policy (built-in vs local-helper classification, the 18-recipe
  spread, rejected candidates).
- [`docs/design/api-hardening-and-proof-recipes.md`](docs/design/api-hardening-and-proof-recipes.md)
  — hardening + proof-recipe work.
