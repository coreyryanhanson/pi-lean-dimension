# pi-lean-host

> BrowserGym evaluation harness for `BrowserPlugin` backends.
> Adapter-driven MiniWoB++ (and future WebArena / WorkArena / etc.)
> task pipeline: Python bridge via CDP attach, Node-plugin `@e`-ref
> action layer, TypeScript `runMiniwobTask` / `benchPlugin` / public
> API for third-party plugin benchmarking.

**pi-lean-host** is the behavioral evaluation package for
[pi-lean-portal](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-portal)
`BrowserPlugin` backends. It depends on
[BrowserGym](https://github.com/ServiceNow/BrowserGym) purely as a
**task/reward source** — we never use BrowserGym's DOM marking (`bid`
injection) or action layer. Our `BrowserPlugin` drives the page with
its own `@e`-ref accessibility snapshots; BrowserGym only sets up
episodes and reads rewards via CDP attach.

This package is **research tooling** — not a pi extension, not in the
`pi-lean-dimension` umbrella meta-package, independently versioned.

---

## Table of Contents

- [Architecture](#architecture)
- [Setup](#setup)
- [Usage](#usage)
  - [Running a MiniWoB task](#running-a-miniwob-task)
  - [Benchmarking a plugin](#benchmarking-a-plugin)
  - [User-owned parity test files](#user-owned-parity-test-files)
- [Public API](#public-api)
- [Test suites](#test-suites)
- [Browser-ownership modes](#browser-ownership-modes)
- [Adding a new benchmark (WebArena, WorkArena, etc.)](#adding-a-new-benchmark)
- [Attribution](#attribution)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  suite / test file               ┌─────────────────────────┐│
│  (vitest)                        │  benchPlugin()           ││
│    │                             │  - Mode A (plugin owns) ││
│    └─► benchPlugin() or          │  - Mode B (host owns)   ││
│        runMiniwobTask()          └─────────┬───────────────┘│
│            │                                │                │
│            ▼                                ▼                │
│  ┌─────────────────┐          ┌──────────────────────────┐  │
│  │ browsergym-     │          │ BrowserPlugin (TS,       │  │
│  │ adapter.ts      │◄────────►│   e.g. ChromiumPlugin)   │  │
│  │ (TS wrapper)    │  CDP     │   click/type/scroll/…    │  │
│  │                 │  attach  │   snapshot → @e refs     │  │
│  └────────┬────────┘          └──────────────────────────┘  │
│           │                                                  │
│    spawns │ JSON-RPC over stdio                              │
│           ▼                                                  │
│  ┌──────────────────┐         ┌─────────────────────────┐   │
│  │ browsergym-      │         │ Chromium (Node-launched) │   │
│  │ bridge.py        │◄───────►│ Single shared page       │   │
│  │ (Python, venv)   │  CDP    │                          │   │
│  │                  │  attach │ Node drives actions;     │   │
│  │ setup(page)      │         │ Python only sets up      │   │
│  │ validate(page)   │         │ episodes & reads rewards │   │
│  └──────────────────┘         └─────────────────────────┘   │
│                                            ▲                 │
│   solvers/                                │                 │
│   parser.ts, trivial-solvers.ts,           │ @e refs        │
│   register-suite.ts                        ▼                 │
│                                    Accessibility tree        │
└──────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- Only the Node plugin drives actions (click, type, scroll, press, goBack).
- The Python bridge only runs `setup(page)` (injects JS, calls `startEpisodeReal`) and `validate(page)` (reads `WOB_REWARD_GLOBAL`, `WOB_DONE_GLOBAL`).
- No BrowserGym `bid` stamping touches the page. No vocabulary collision with our `@e`-ref model.
- Two Playwright clients share one Chromium via CDP — a standard, supported configuration.

## Setup

### Prerequisites

- Node.js ≥ 22
- Python 3.10–3.12 (greenlet 3.0.3 does not build on 3.13)

### Install

```bash
# From the monorepo root:

# 1. Install Node dependencies (includes pi-lean-portal as a peer/workspace dep)
npm ci

# 2. Install Playwright browsers (chromium is required for Phase 1)
npx playwright install chromium

# 3. Create the dedicated browsergym venv (Pip installs browsergym-miniwob + playwright)
npm run setup:venv -w pi-lean-host

# 4. Clone MiniWoB++ HTML content at the pinned commit
npm run setup:miniwob
```

The venv is created at `packages/pi-lean-host/venv/` (gitignored). It's isolated
from the portal's `chromium-py`/`firefox-py` venv so `browsergym`'s own
`playwright==1.44` pin and `gymnasium`/`numpy` don't collide with the
portal backends' deps.

If your system Python is 3.13+, point `setup:venv` at a compatible interpreter:

```bash
PI_LEAN_HOST_VENV_BASE_PYTHON=python3.12 npm run setup:venv -w pi-lean-host
```

### Run the suite

```bash
# Structural tests + MiniWoB live-browser tests (auto-skips when browser/venv/content absent)
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
import { ChromiumPlugin } from "pi-lean-portal/backends/chromium/index.js";

const plugin = new ChromiumPlugin();
await plugin.init({});

const result = await runMiniwobTask({
  plugin,
  taskName: "click-test",
  seed: 42,
  baseUrl: "http://localhost:8080",
  actor: "trivial",
  solver: (snapshot) => {
    // A trivial solver: find the first clickable button, return its @e ref
    const lines = snapshot.split("\n");
    for (const line of lines) {
      const m = line.match(/@e(\d+)\b/);
      if (m) return { action: "click", target: `@e${m[1]}` };
    }
    return null;
  },
  maxSteps: 10,
});

console.log(`Reward: ${result.rawReward}`); // > 0 for click-test
```

`solver` receives the accessibility-tree snapshot string and must return
`{ action: "click" | "type" | "press" | "scroll", target, value? }` or
`null` to end the episode.

### Benchmarking a plugin

`benchPlugin` is the high-level entry point — it handles mode
negotiation (plugin-owns-browser vs host-owns-browser), task iteration,
and result aggregation.

```ts
import { benchPlugin } from "pi-lean-host";
import { ChromiumPlugin } from "pi-lean-portal/backends/chromium/index.js";

const results = await benchPlugin(new ChromiumPlugin(), {
  backendName: "chromium",
  tasks: ["click-test", "click-button"],   // subset of 125 MiniWoB tasks
  seed: 42,
  baseUrl: "http://localhost:8080",
  mode: "plugin-owns-browser",             // Mode A — uses getCdpEndpoint()
  skipIf: () => !process.env.CI,           // skip guard
});

for (const [taskName, r] of Object.entries(results)) {
  console.log(`${taskName}: reward=${r.rawReward} done=${r.done}`);
}
```

`benchPlugin` returns a `Record<string, MiniwobResult>` keyed by task
name. Each result contains `reward`, `rawReward`, `done`, `reason`,
`steps`, and `goal`.

### User-owned parity test files

Third-party plugin authors can register their own MiniWoB parity suite
without modifying `pi-lean-host` source:

```ts
// my-browser-plugin/__tests__/miniwob-parity.test.ts
import { describe } from "vitest";
import { registerMiniwobSuite } from "pi-lean-host";
import { MyWebKitPlugin } from "../src/index.ts";

describe("MyWebKitPlugin — MiniWoB parity", () => {
  registerMiniwobSuite({
    plugin: new MyWebKitPlugin(),
    backendName: "my-webkit",
    mode: "host-owns-browser",   // plugin must implement connectOverCDP
    skipIf: () => !process.env.MY_WEBKIT_AVAILABLE,
  });
});
```

The suite registers 125 `it` blocks (13 with trivial solvers asserting
`reward > 0`, 77 skipped as `needs goal-aware solver`, 35 skipped as
`missing tool`). The output matrix shows exactly which tasks pass, skip,
or fail.

## Public API

`pi-lean-host` exports from `src/index.ts`:

| Export | Source | Description |
|---|---|---|
| `runMiniwobTask` | `adapter/browsergym-adapter.ts` | Drive one episode; accepts `"trivial"` or `{type:"pi", config}` actor |
| `benchPlugin` | `adapter/bench.ts` | Run one or more tasks against a plugin with mode negotiation |
| `registerMiniwobSuite` | `solvers/register-suite.ts` | Register a vitest suite of 125 MiniWoB tasks for a backend |
| `trivialSolvers` | `solvers/trivial-solvers.ts` | Map of task name → trivial solver (13 entries) |
| `CONFIDENT_TASKS` | `solvers/trivial-solvers.ts` | Set of 3 task names with confident assertions |
| `parseRefs` | `solvers/parser.ts` | Parse `@e`-ref lines from a snapshot |
| `withRole` | `solvers/parser.ts` | Filter parsed refs by ARIA role |
| `firstWith` | `solvers/parser.ts` | Find the first `SnapEl` matching a predicate |
| `goalQuotedTexts` | `solvers/parser.ts` | Extract quoted strings from the task goal |
| `SnapEl` | `solvers/parser.ts` | Parsed snapshot element type |
| `MinwobResult`, `MiniwobTaskOpts`, `TrivialSolver`, `BenchOpts`, `BenchResult` | adapter & bench | TypeScript types |

### Types

```ts
interface MinwobResult {
  reward: number;
  rawReward: number;
  done: boolean;
  reason: string;
  steps: number;
  goal: string;
}

type TrivialSolver = (snapshot: string, goal: string) => TrivialAction | null;
// TrivialAction = { action: "click" | "type" | "press" | "scroll", target: string, value?: string }

interface BenchOpts {
  backendName: string;
  tasks?: string[];           // default: all 125
  seed?: number;              // default: 42
  baseUrl: string;
  mode: "plugin-owns-browser" | "host-owns-browser";
  skipIf?: () => boolean;
}
```

## Test suites

| Suite file | What it tests |
|---|---|
| `suites/miniwob-trivial.test.ts` | 125 MiniWoB tasks × chromium — 13 trivial solvers pass, 112 skip. The real Phase 1 delivery. |
| `suites/miniwob-helper.test.ts` | BridgeClient spawn, `listTasks` returns 125, ping/shutdown handshake. ~40 lines. |
| `suites/adapter-smoke.test.ts` | End-to-end `runMiniwobTask(click-test)` through real ChromiumPlugin + BrowserGym. Verifies rawReward > 0. Runs standalone (excluded from `test:miniwob` to avoid resource contention). |

All suites auto-skip when prerequisites (venv, browser, MiniWoB++ content) are absent.

## Browser-ownership modes

`benchPlugin` negotiates two modes via the `mode` option:

### Mode A — plugin-owns-browser (default for shipped backends)

The plugin launches its own browser and exposes `getCdpEndpoint(): string | null`.
`pi-lean-host` passes that CDP endpoint to the BrowserGym Python adapter,
which attaches via `connect_over_cdp`. This tests the plugin's real launch path.

Used by: `chromium` (Phase 1), `firefox` (Phase 1.5 via `launchServer`).

**Required on the plugin:** implements `getCdpEndpoint()` returning the CDP
endpoint URL. The caller must guard with `typeof plugin.getCdpEndpoint === "function"`
(a truthiness check would be incorrect under `exactOptionalPropertyTypes`).

### Mode B — host-owns-browser (for plugins that can't launch their own)

`pi-lean-host` launches a reference Chromium with `--remote-debugging-port`
and passes the endpoint to both BrowserGym (Python) and the user plugin.
The plugin implements `connectOverCDP(endpoint: string): Promise<void>` instead
of `launchBrowser()`. Does NOT test the plugin's launch path — only its
snapshot/click/type/etc. methods.

**Required on the plugin:** implements `connectOverCDP(endpoint)`. Guard with
`typeof plugin.connectOverCDP === "function"`.

### `BrowserPlugin` interface additions (Phase 1)

Two optional methods were added to the `BrowserPlugin` interface in
`pi-lean-portal/core/plugin-api.ts`. Both default to absent, so existing
plugins and tests are unaffected:

```ts
export interface BrowserPlugin {
  // ... existing 18 required + 1 optional methods ...

  /** CDP/ws endpoint for BrowserGym to attach (Mode A). null if the
   *  plugin doesn't expose one (host will use Mode B or skip). */
  getCdpEndpoint?(): string | null;

  /** Connect to an externally-launched browser (Mode B). Plugins that
   *  implement this can be benched without launching their own browser. */
  connectOverCDP?(endpoint: string): Promise<void>;
}
```

## Adding a new benchmark (WebArena, WorkArena, etc.)

The point of the Option C architecture: adding a new benchmark family is
a `pip install` + one new adapter method.

1. Add the pip extra to `requirements.txt`:

   ```txt
   browsergym-webarena==0.14.3
   ```

2. Add a setup script (Docker containers for WebArena, etc.) at
   `scripts/setup-webarena.mjs`.

3. Add a `{benchmark}.setup(page)` / `.validate(page)` call in
   `adapter/browsergym-bridge.py` — all BrowserGym tasks subclass
   `AbstractBrowserTask`, so the shape is uniform.

4. Add a wrapper method in `adapter/browsergym-adapter.ts` or generalize
   `runMiniwobTask` to `runBgymTask(benchmark, taskName, ...)`.

The existing CDP attach, `@e`-ref action layer, and solver harness are
benchmark-agnostic and require no changes.

## Attribution

- **BrowserGym** © ServiceNow — Apache-2.0.
- **MiniWoB++** © Farama-Foundation — Apache-2.0, pinned at
  [`miniwob-plusplus@7fd85d71`](https://github.com/Farama-Foundation/miniwob-plusplus/tree/7fd85d71a4b60325c6585396ec4f48377d049838).
- **browsergym-miniwob** PyPI package — pinned at `==0.14.3` in
  [requirements.txt](requirements.txt).

See the header in [`adapter/browsergym-bridge.py`](adapter/browsergym-bridge.py) for full attribution.

## License

AGPL-3.0-only
