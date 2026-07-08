# pi-lean-host

> MiniWoB++ evaluation harness for `BrowserPlugin` backends.
> `plugin.evaluate`-driven MiniWoB++ episode lifecycle (setup /
> validate), Node-plugin `@e`-ref action layer, TypeScript
> `runMiniwobTask` / `registerMiniwobSuite` public API for
> third-party plugin benchmarking.

**pi-lean-host** is the behavioral evaluation package for
[pi-lean-portal](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-portal)
`BrowserPlugin` backends. The plugin is the **sole page owner**:
its own `@e`-ref accessibility snapshots drive actions, and the
episode lifecycle (setup + reward validation) runs as
`plugin.evaluate()` calls on the plugin's own page. There is no
second Playwright client and no cross-process attach.

This package is **research tooling** — not a pi extension, not in the
`pi-lean-dimension` umbrella meta-package, independently versioned.

---

## Table of Contents

- [Architecture](#architecture)
- [Setup](#setup)
- [Usage](#usage)
  - [Running a MiniWoB task](#running-a-miniwob-task)
  - [Writing a trivial solver](#writing-a-trivial-solver)
  - [User-owned parity test files](#user-owned-parity-test-files)
- [Public API](#public-api)
- [Test suites](#test-suites)
- [Browser-ownership model](#browser-ownership-model)
- [Adding a new benchmark (WebArena, WorkArena, etc.)](#adding-a-new-benchmark)
- [Attribution](#attribution)

---

## Architecture

```
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

**Key invariants:**

- The plugin is the sole page owner; setup and validate run as
  `plugin.evaluate` calls on its page. There is no second Playwright
  client and no cross-process attach.
- Only the plugin drives actions (click, type, scroll, press, goBack).
- The adapter only runs `setupMiniwobEpisode()` (injects
  `REMOVE_DISPLAY_JS` + `SETUP_JS`, polls `WOB_TASK_READY`, reads the
  utterance) and `validateMiniwob()` (reads `WOB_RAW_REWARD_GLOBAL`,
  `WOB_DONE_GLOBAL`, `WOB_REWARD_REASON`) — all via `plugin.evaluate`.
- No DOM marking touches the page. No vocabulary collision with our `@e`-ref model.

## Setup

### Prerequisites

- Node.js ≥ 22
- Python 3.10+ with the `playwright` package installed (any modern version).

### Install

```bash
# From the monorepo root:

# 1. Install Node dependencies (includes pi-lean-portal as a peer/workspace dep)
npm ci

# 2. Install Playwright browsers (chromium is required for Phase 1)
npx playwright install chromium

# 3. Clone MiniWoB++ HTML content at the pinned commit
npm run setup:miniwob
```

**Python requirement:** Python is only needed to **run** the
chromium-py / firefox-py bridge backends (each bridge is a Python
process spawned by `PythonPluginAdapter`). It is **not** needed to
drive MiniWoB — the episode lifecycle now runs as `plugin.evaluate`
calls on the plugin's own page, so there is no `miniwob-driver.py`
subprocess. The `playwright` Python package is required for the
python bridge backends; no dedicated virtualenv is needed — each
bridge reuses the `pythonPath` configured on its
`PythonPluginAdapter`.

### Run the suite

```bash
# Structural tests + MiniWoB live-browser tests (auto-skips when browser/content absent)
npm run test:miniwob -w pi-lean-host

# Or from the monorepo root:
npm run test:miniwob
```

## Usage

### Running a MiniWoB task

The lowest-level API — `runMiniwobTask` — drives one episode against a
BrowserPlugin backend:

```ts
import { runMiniwobTask } from "pi-lean-host";
import type { BrowserPlugin } from "pi-lean-portal";

// Your own BrowserPlugin drives the page via @e-ref accessibility snapshots.
// The episode lifecycle (setup + validate) runs as plugin.evaluate calls on
// the plugin's own page — there is no second Playwright client.
const plugin: BrowserPlugin = new MyPlugin();
await plugin.init({});

const result = await runMiniwobTask({
  plugin,
  taskName: "click-test",
  seed: 42,
  baseUrl: "http://localhost:8080",
  actor: "trivial",
  solver: async (ctx) => {
    // Find the first button in the snapshot and click it.
    const { parseRefs, withRole } = await import("pi-lean-host");
    const els = parseRefs(ctx.snapshot);
    const btn = withRole(els, "button")[0];
    if (btn) await ctx.plugin.click(ctx.taskId, btn.ref);
  },
  maxSteps: 20,
});

console.log(`Reward: ${result.rawReward}`); // > 0 for click-test
console.log(`Done: ${result.done}, steps: ${result.steps}, bail: ${result.bailReason}`);
```

The solver receives a `SolverCtx` (`{ plugin, taskId, goal, snapshot, snapshotNow() }`)
and drives the plugin directly — it does **not** return an action
descriptor. Return `void`; the harness polls `validate()` afterwards
until the episode signals `done` or the done-poll bails.

### Writing a trivial solver

A `TrivialSolver` is `(ctx: SolverCtx) => Promise<void>`. The shipped
solvers in `solvers/trivial-solvers.ts` are the reference
implementations — 6 solvers covering 13 task subdomains:

| Solver | Tasks | Strategy |
|---|---|---|
| `clickFirstButton` | `click-test`, `click-dialog` | Click the first `button` in the snapshot. |
| `focusFirstTextbox` | `focus-text`, `focus-text-2` | Click the first `textbox`. |
| `clickButtonNamedInGoal` | `click-test-2`, `click-button`, `click-dialog-2` | Click the button whose name matches a quoted string in the goal. |
| `clickLinkNamedInGoal` | `click-link` | Click the link whose name matches a quoted string in the goal. |
| `typeQuotedIntoTextbox` | `enter-text`, `enter-password`, `enter-text-dynamic` | Type the first quoted string from the goal into the first textbox. |
| `loginUser` | `login-user`, `login-user-popup` | Type the first quoted string into the username field, the second into the password field, then click the submit button. |

The parsing helpers (`parseRefs`, `withRole`, `firstWith`,
`goalQuotedTexts`) are exported from this package so user solvers can
reuse them. `withRole` uses a hardcoded role-keyword allowlist to keep
`@e`-ref matching ReDoS-safe.

### User-owned parity test files

Third-party plugin authors can register their own MiniWoB parity suite
without modifying `pi-lean-host` source:

```ts
// my-browser-plugin/__tests__/miniwob-parity.test.ts
import { registerMiniwobSuite, type MiniwobBackend } from "pi-lean-host";
import { MyWebKitPlugin } from "../src/index.ts";

const backend: MiniwobBackend = {
  name: "my-webkit",
  available: Boolean(process.env.MY_WEBKIT_AVAILABLE),
  initPlugin: async () => new MyWebKitPlugin(),
};

// The caller owns the MiniWoB server lifecycle — start it in a
// file-level beforeAll, stop it in afterAll, and pass the base URL
// resolver here.
registerMiniwobSuite(backend, async () => process.env.MINIWOB_URL ?? "http://localhost:8080");
```

`registerMiniwobSuite` registers one `describe` block driving all 125
MiniWoB tasks through the backend. The block `describe.skip`s when
`backend.available` is false. Task classification is automatic:

- **13 tasks** with registered trivial solvers run; the 3 in
  `CONFIDENT_TASKS` assert `rawReward > 0`, the other 10 are
  best-effort pipeline smoke tests.
- **77 element tasks** without a registered solver skip with
  `needs goal-aware solver`.
- **35 non-element tasks** (coord/drag/hover/select — capabilities
  `BrowserPlugin` does not expose) skip with a missing-tool reason.

The output matrix shows exactly which tasks pass, skip, or fail.

## Public API

`pi-lean-host` exports from `src/index.ts`:

| Export | Source | Description |
|---|---|---|
| `runMiniwobTask` | `adapter/miniwob-adapter.ts` | Drive one episode; accepts a `TrivialSolver`. |
| `registerMiniwobSuite` | `solvers/register-suite.ts` | Register a vitest suite of 125 MiniWoB tasks for a backend. |
| `SOLVERS` | `solvers/trivial-solvers.ts` | `Map` of task name → trivial solver (13 entries across 6 solver functions). |
| `CONFIDENT_TASKS` | `solvers/trivial-solvers.ts` | `Set` of 3 task names with confident `rawReward > 0` assertions. |
| `clickFirstButton`, `focusFirstTextbox`, `clickButtonNamedInGoal`, `clickLinkNamedInGoal`, `typeQuotedIntoTextbox`, `loginUser` | `solvers/trivial-solvers.ts` | The 6 shipped solver functions. |
| `parseRefs` | `solvers/parser.ts` | Parse an `@e`-ref snapshot into `SnapEl[]`. |
| `withRole` | `solvers/parser.ts` | Filter parsed refs by an allowlisted ARIA role keyword. |
| `firstWith` | `solvers/parser.ts` | Find the first `SnapEl` matching any of the given role keywords. |
| `goalQuotedTexts` | `solvers/parser.ts` | Extract double-quoted strings from a task goal. |
| `SEED`, `TEST_TIMEOUT` | `solvers/register-suite.ts` | Fixed seed (12345) and per-test timeout (60s) used by the shipped suite. |

### Types

```ts
interface SolverCtx {
  plugin: BrowserPlugin;
  taskId: string;
  goal: string;
  snapshot: string;
  snapshotNow(): Promise<string>;
}

type TrivialSolver = (ctx: SolverCtx) => Promise<void>;

interface RunMiniwobTaskOptions {
  plugin: BrowserPlugin;
  taskName: string;
  seed: number;
  baseUrl: string;
  actor: "trivial";
  solver?: TrivialSolver;
  maxSteps?: number;            // hard safety cap (default 20)
  episodeMaxTimeMs?: number;    // default 30_000
  navigateTimeoutMs?: number;   // default 15_000
  donePollIntervalMs?: number;  // default 200
  donePollTimeoutMs?: number;   // default 10_000 — primary bail
}

interface MiniwobTaskResult {
  goal: string;
  reward: number;        // 1 if rawReward > 0, else 0
  rawReward: number;
  done: boolean;
  reason: string;
  steps: number;         // reported count, not a bail condition
  timedOut: boolean;
  bailReason: "wall-clock" | "max-steps" | null;
  setupFailed: boolean;
  error?: string;
}

interface MiniwobBackend {
  name: string;
  available: boolean;
  initPlugin: () => Promise<BrowserPlugin>;
}

// registerMiniwobSuite(backend: MiniwobBackend, getBaseUrl: () => Promise<string>): void
```

## Test suites

| Suite file | What it tests |
|---|---|
| `suites/miniwob-trivial.test.ts` | 125 MiniWoB tasks × chromium — 13 trivial solvers pass, 112 skip. |
| `suites/miniwob-firefox.test.ts` | 125 MiniWoB tasks × firefox — 13 trivial solvers pass, 112 skip. |
| `suites/miniwob-chromium-py.test.ts` | 125 MiniWoB tasks × chromium-py (Python bridge) — 13 trivial solvers pass, 112 skip. |
| `suites/miniwob-firefox-py.test.ts` | 125 MiniWoB tasks × firefox-py (Python bridge) — 13 trivial solvers pass, 112 skip. |
| `suites/adapter-smoke.test.ts` | End-to-end `runMiniwobTask(click-test)` through real Chromium + `plugin.evaluate` episode lifecycle. Asserts `rawReward > 0`. |

All suites auto-skip when prerequisites (browser, MiniWoB++ content) are absent.

## Browser-ownership model

`pi-lean-host` uses **Mode A — plugin-owns-browser** exclusively, and
now implements it **without** external attach. The plugin is the
sole page owner: it drives actions (`click`, `type`, `scroll`,
`press`, `goBack`) via its own `@e`-ref accessibility snapshots,
**and** runs the episode lifecycle JS (`REMOVE_DISPLAY_JS`,
`SETUP_JS`, `READY_PROBE_JS`, `UTTERANCE_JS`, `VALIDATE_JS`) as
`plugin.evaluate()` calls on its own page. There is no second
Playwright client, no `getAttachEndpoint()`, no `"cdp"` /
`"firefox-ws"` attach kind, and no `launchServer()` / `connect()`
hop.

The episode-lifecycle JS string constants live in
[`adapter/miniwob-episode.ts`](adapter/miniwob-episode.ts); the
adapter orchestrates them via the `setupMiniwobEpisode()` and
`validateMiniwob()` helpers in
[`adapter/miniwob-adapter.ts`](adapter/miniwob-adapter.ts).

There is no "Mode B" (host-owns-browser) path — a host-managed
browser interface hook was considered and dropped as YAGNI; it will
be re-added alongside a real consumer that needs it (e.g. a future
WebArena adapter that manages its own browser lifecycle).

## Adding a new benchmark (WebArena, WorkArena, etc.)

The existing `plugin.evaluate` episode lifecycle, `@e`-ref action
layer, and solver harness are benchmark-agnostic. Adding a new
benchmark family would follow the pattern established by MiniWoB:
a TypeScript adapter that calls `plugin.evaluate()` for setup /
validate (no Python subprocess, no attach plumbing, no JSON-RPC
transport). If the benchmark's setup/validate JS is non-trivial,
factor it into a sibling `*-episode.ts` module of string constants,
the way `miniwob-episode.ts` does.

## Attribution

- **MiniWoB++** © Farama-Foundation — Apache-2.0, pinned at
  [`miniwob-plusplus@7fd85d71`](https://github.com/Farama-Foundation/miniwob-plusplus/tree/7fd85d71a4b60325c6585396ec4f48377d049838).
- **BrowserGym** © ServiceNow — Apache-2.0. The `REMOVE_DISPLAY_JS`
  constant in [`adapter/miniwob-episode.ts`](adapter/miniwob-episode.ts)
  is copied verbatim from `browsergym/miniwob/base.py` (no changes);
  see the attribution header in that file for details.

The episode-setup protocol is paraphrased from BrowserGym's
`base.py`; the `removeDisplay` block is copied verbatim per the
"no changes" commitment in the implementation plan.

## License

AGPL-3.0-only
