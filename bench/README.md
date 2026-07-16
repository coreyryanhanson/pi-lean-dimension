# bench — Evaluation harnesses for BrowserPlugin backends

This directory contains evaluation harnesses for testing `BrowserPlugin`
backends. The MiniWoB++ deterministic harness lives at `bench/miniwob/`.
(A future agent-driven harness may live under `bench/agent/` when that
work is actually in scope.)

## miniwob/ — MiniWoB++ evaluation harness

**`bench/miniwob/`** is a `plugin.evaluate`-driven MiniWoB++ episode
lifecycle (setup/validate on the plugin's own page), with Node-plugin
`@e`-ref action layer. It provides `runMiniwobTask` and
`registerMiniwobSuite` for benchmarking any `BrowserPlugin` against
the full 130-task MiniWoB++ suite.

### Key invariants

- The plugin is the sole page owner; setup and validate run as
  `plugin.evaluate` calls on its page. There is no second Playwright
  client and no cross-process attach.
- Only the plugin drives actions (click, type, scroll, press, goBack).
- The adapter only runs `setupMiniwobEpisode()` (injects
  `REMOVE_DISPLAY_JS` + `SETUP_JS`, polls `WOB_TASK_READY`, reads the
  utterance) and `validateMiniwob()` (reads `WOB_RAW_REWARD_GLOBAL`,
  `WOB_DONE_GLOBAL`, `WOB_REWARD_REASON`) — all via `plugin.evaluate`.
- No DOM marking touches the page. No vocabulary collision with our
  `@e`-ref model.

### Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│  suite / test file (vitest)                                  │
│    │                                                         │
│    └─► runMiniwobTask()          ┌──────────────────────┐    │
│            │                      │ BrowserPlugin (TS,  │    │
│            ▼                      │  e.g. ChromiumPlugin)│   │
│  ┌─────────────────┐  plugin.    │  click/type/scroll/… │    │
│  │ miniwob-        │  evaluate() │  snapshot → @e refs  │    │
│  │ adapter.ts      │────────────►│  sole page owner     │    │
│  │ (TS wrapper)    │             └──────────┬───────────┘    │
│  │                 │                        │                │
│  │  setupMiniwob   │   REMOVE_DISPLAY_JS,   │ single page    │
│  │  Episode():     │   SETUP_JS,            │  (no second    │
│  │   rm + setup    │   READY_PROBE_JS,      │   Playwright   │
│  │   + ready poll  │   UTTERANCE_JS         │   client)      │
│  │  validateMini   │   ─────────────────►   │                │
│  │  wob():         │   VALIDATE_JS          │                │
│  └─────────────────┘                        │                │
│                                            ▼                 │
│   solvers/                                 Accessibility tree │
│   parser.ts, trivial-solvers.ts,             via @e refs    │
│   register-suite.ts                                         │
└──────────────────────────────────────────────────────────────┘
```

### Subdirs

| Dir | Purpose |
|-----|---------|
| `adapter/` | `runMiniwobTask` wrapper, episode lifecycle JS constants |
| `solvers/` | Trivial solvers, parser, `registerMiniwobSuite` |
| `scripts/` | Setup (`setup-miniwob.mjs`), static server |
| `suites/` | Per-backend test files (chromium, firefox, chromium-py, firefox-py, adapter-smoke, user-backends, inspect-csp-smoke, inspect-eval-smoke) |

### Running the MiniWoB test suite

```bash
# Clone MiniWoB++ content (one-time; idempotent)
npm run setup:miniwob

# Run all MiniWoB browser tests (auto-skips when prerequisites absent)
npm run test:miniwob

# Run a single suite file directly
npx vitest run bench/miniwob/suites/adapter-smoke.test.ts
```

**Preflight gate:** `npm run test:miniwob` runs a preflight check
(`bench/miniwob/scripts/miniwob-preflight.mjs`) that refuses to start
vitest if MiniWoB++ content is missing on disk and no `MINIWOB_URL`
is set. This prevents the suite from silently skipping all 130 tasks
with a green exit code (e.g., after a reboot that cleared `/tmp`). If
the gate fires, run `npm run setup:miniwob` to download the content.

### Prerequisites

- Node.js ≥ 22
- Python 3.10+ with the `playwright` package installed (for Python bridge backends)
- Playwright browsers installed (`npx playwright install chromium firefox`)
- MiniWoB++ content (`npm run setup:miniwob`)

### Public API (re-exports from `bench/miniwob/`)

**Entry-point functions:**

- `runMiniwobTask(opts)` — run one MiniWoB++ task end-to-end
- `registerMiniwobSuite(backend, getBaseUrl)` — register a `describe` block for all 130 tasks

**Types:**

- `TrivialSolver`, `SolverCtx`, `RunMiniwobTaskOptions`, `MiniwobTaskResult`
- `MiniwobBackend`

**Solver helpers:**

- `SOLVERS`, `CONFIDENT_TASKS` (solver registry)
- `clickFirstButton`, `focusFirstTextbox`, `clickButtonNamedInGoal`, etc.
- `parseRefs`, `withRole`, `firstWith`, `goalQuotedTexts`

### Benchmarking your own BrowserPlugin

1. Install your backend under `~/.pi/agent/pi-lean-portal/user-backends/<name>/`
   (or set `PI_USER_BACKENDS_DIR` to a custom path).
2. Create a test file that calls `registerMiniwobSuite` with a
   `MiniwobBackend` descriptor and a `getBaseUrl` resolver for the
   MiniWoB static server.
3. Run via `npx vitest run <your-test-file>`.

See the contributed parity suite at
`packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts` (the discovery
runner that validates any installed user backend) for the contract template.

### Attribution

MiniWoB++ © Farama-Foundation (Apache-2.0).
Pinned commit: `miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838`
