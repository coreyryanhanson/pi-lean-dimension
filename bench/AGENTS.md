# AGENTS.md — bench/

Evaluation harnesses for `BrowserPlugin` backends. Today this is just
`miniwob/`; a future `agent/` harness may land here when in scope.

**This is research tooling, not a pi extension and not an npm workspace
package.** It ships no tools, has no `package.json`, and is excluded
from `npm run test:ci` (`--exclude='**/bench/**'`). It runs only under
`npm run test:miniwob`.

## Commands

```bash
npm run setup:miniwob     # one-time clone of pinned MiniWoB++ html (idempotent; default /tmp/miniwob-plusplus/miniwob/html)
npm run test:miniwob      # preflight gate + vitest run bench/miniwob/suites/
npx vitest run bench/miniwob/suites/adapter-smoke.test.ts   # one suite file
```

Run these from the **repo root** (`/root/pi-browser`), not from
`bench/` — the npm scripts and the relative imports
(`../../../packages/pi-lean-portal/...`) are rooted there.

## Preflight gate (don't bypass)

`npm run test:miniwob` runs `miniwob-preflight.mjs` first, which
**exits non-zero** if MiniWoB++ content is missing on disk and no
`MINIWOB_URL` is set. This is deliberate: without it the suite silently
`it.skip`s all 130 tasks and exits green (e.g. after `/tmp` is cleared
by a reboot). If the gate fires, run `npm run setup:miniwob` — do not
work around it.

## Prerequisites

- Node ≥ 22
- Playwright browsers: `npx playwright install chromium firefox`
- Python 3.10+ with `playwright` (for the `*-py` bridge backends)
- MiniWoB++ content via `npm run setup:miniwob` (or `MINIWOB_URL`)
- User-managed stealth backends (Camoufox etc.) live under
  `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/` (or
  `PI_USER_BACKENDS_DIR`); never shipped, never auto-downloaded

Every suite file **independently auto-skips** when its own prereqs are
absent. That keeps `npm test` / `test:ci` green in bare CI and is why a
green run with all skips means nothing without the preflight gate.

## Env overrides

- `MINIWOB_HTML_ROOT` — path to the `miniwob/html` dir on disk (default
  `/tmp/miniwob-plusplus/miniwob/html`)
- `MINIWOB_URL` — URL of an already-running MiniWoB static server; skips
  the content check and the local static server
- `CONTRIB_RUN=1` — gates contributed/Camoufox opt-in suites
- `PI_USER_BACKENDS_DIR` — override user-backends root

## Architecture (what's actually wired together)

The plugin is the **sole page owner**. There is no second Playwright
client and no cross-process attach. The full episode lifecycle runs as
`plugin.evaluate()` calls on the plugin's own page:

- `adapter/miniwob-adapter.ts` — `runMiniwobTask()`: navigate → setup
  → solver → validate, all via the plugin. Exports `TrivialSolver`,
  `SolverCtx`, `RunMiniwobTaskOptions`, `MiniwobTaskResult`.
- `adapter/miniwob-episode.ts` — the JS constants injected via
  `plugin.evaluate` (`SETUP_JS`, `VALIDATE_JS`, `READY_PROBE_JS`,
  `UTTERANCE_JS`, `REMOVE_DISPLAY_JS`). No DOM marking touches the
  page — keeps it vocabulary-clean for the `@e`-ref model.
- `solvers/register-suite.ts` — **public extension point.**
  `registerMiniwobSuite(backend, getBaseUrl)` registers one `describe`
  over all 130 tasks. Task classification is a static 35-entry
  `NON_ELEMENT_TASKS` set (coord/drag/hover/select); everything else is
  treated as element-reachable. Of element tasks, only 13 have
  registered trivial solvers (3 confident, 10 best-effort); the other
  82 `it.skip` with "needs goal-aware solver".
- `solvers/trivial-solvers.ts` — dumb per-subdomain solvers that test
  the **plugin pipeline**, not agent intelligence. Exports `SOLVERS`,
  `CONFIDENT_TASKS`, and helpers like `clickFirstButton`.
- `solvers/parser.ts` — `@e`-ref extraction + role-keyword filtering.
  The `withRole` regex is deliberately tightened to match only in the
  prefix before the first `"` so a button named `"click the button"`
  doesn't false-match the `button` keyword.
- `solvers/contributed-parity.ts` — shared helper for contributed
  (user-managed) backend templates; gated by `CONTRIB_RUN=1`.
- `scripts/miniwob-server.ts` — static HTTP server for the html dir,
  reusing `test-server.js` from the portal package.
- `scripts/setup-miniwob.mjs` — clones `miniwob-plusplus` at the frozen
  pin `7fd85d71a4b60325c6585396ec4f48377d049838`.

## Suite files (`miniwob/suites/`)

- `miniwob-trivial` — Chromium (Node), the canonical suite.
- `miniwob-firefox`, `miniwob-chromium-py`, `miniwob-firefox-py` —
  other shipped backends.
- `miniwob-user-backends` — discovers any user-managed
  `<name>-py/bridge.py` and registers a suite per backend. No-op in
  bare CI (no describe registered at all, nothing reported).
- `adapter-smoke` — single-task end-to-end canary (`click-test`,
  asserts `rawReward > 0`).
- `inspect-eval-smoke`, `inspect-csp-smoke` — `browser-inspect`
  regression nets. **Why two:** MiniWoB pages have no CSP, so eval-smoke
  alone missed the class of bug where patched-Firefox stealth binaries
  route `page.evaluate` through `eval()` in the page's main world and
  CSP-strict sites break it. `inspect-csp-smoke` covers that. Shared
  scaffolding lives in `inspect-smoke-harness.ts`.
- `miniwob-suite-helper.ts` — shared content-availability gate +
  `createSharedMiniwobServer()` factory used by the **shipped** suite
  files. User-owned parity files do **not** use this helper — they own
  their own server lifecycle per the `registerMiniwobSuite` doc.

## Adding a backend

1. Install under `~/.pi/agent/pi-lean-portal/user-backends/<name>/`
   (or set `PI_USER_BACKENDS_DIR`).
2. Write a test file calling `registerMiniwobSuite(backend, getBaseUrl)`
   with a `MiniwobBackend` descriptor and a base-URL resolver. The
   caller owns the MiniWoB server lifecycle (`beforeAll`/`afterAll`).
3. `npx vitest run <your-test-file>`.

The contract template is
`packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts`.
A parity template that cares about the identity test's `engine` read
should set `capabilities.engine` explicitly in its own factory — the
shipped `PythonPluginAdapter` defaults it to `chromium`, which is
wrong for a Firefox-based backend but engine-agnostic for the
auto-skip + task-classification logic.

## Coverage ceiling (don't try to extend past this here)

MiniWoB does **not** cover canvas/coord/drag/hover/slider/select tasks
(no such tool on `BrowserPlugin`) — those are the 35 `it.skip`
non-element tasks. It also does not cover any framework/structural
concern; that lives in `packages/pi-lean-portal/__tests__/`. See
`docs/decisions/miniwob-and-host-setup.md`.

`bench/miniwob/results/` is a CI artifact upload destination
(`.gitignore`d) — not committed.
