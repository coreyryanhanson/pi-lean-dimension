# Decision: Drop BrowserGym as a Runtime Dependency

**Date:** 2026-07-06
**Status:** Executed.
**See also:** [`branch-outcome.md`](./branch-outcome.md) for the branch-level summary; [`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md) for the follow-on decision that removed the attach plumbing this doc introduced.

## Background: the BrowserGym Option C plan

During the `cleanup/use-benchmarking-libraries` branch, a plan was drafted
to adopt `browsergym[miniwob]` as a dev-only Python dependency for MiniWoB++
task evaluation (Option C), replacing an earlier hand-ported Option D
implementation. The plan proposed using BrowserGym purely as a task/reward
source while keeping the `@e`-ref accessibility model and `BrowserPlugin`
action layer untouched, with cross-process page sharing via CDP attach.

Five architectural decisions from that plan survived into the shipped branch:

- **New `pi-lean-host` package** — host is a consumer of `pi-lean-portal`,
  separate release cadence, not in the umbrella meta-package.
- **Integration-test split** — behavioral evaluation moves to
  `pi-lean-host`; portal framework-internals stay in `pi-lean-portal` as
  mocked unit tests.
- **User-plugin benchmarking as first-class** — `pi-lean-host` exports a
  public API (`benchPlugin`, `registerMiniwobSuite`, etc.) for any
  `BrowserPlugin`.
- **Chromium-first attach** — CDP attach for chromium was the primary path;
  Firefox `launchServer` deferred. *(The attach model itself was later
  eliminated — see the follow-on decision below.)*
- **`getCdpEndpoint?()` and `connectOverCDP?()` added to `BrowserPlugin`.**
  *(Later deleted by the cross-process-attach elimination.)*

Four of the five survived; the CDP attach hooks and the chromium-first
attach strategy were retired by the subsequent
[`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md).

The Option C plan was superseded before execution when three structural
problems emerged (the Context below), which drove the decision to drop
BrowserGym entirely rather than adopt it.

## Context

The `pi-lean-host` package was initially built on BrowserGym for MiniWoB++
task evaluation. After integration, three structural problems emerged:

1. **Playwright version pin (`==1.44`)** — BrowserGym pins Playwright at 1.44,
   which is structurally incompatible with a browsing tool that must stay
   current for real web interaction.
2. **In-process design overhead** — The in-process design existed solely to
   engineer around BrowserGym's dependency footprint, adding complexity
   without benefit to the core mission.
3. **WebArena is the wrong justification** — BrowserGym's real value
   (WebArena reward computation) requires a standalone Mode B bridge in its
   own venv, which is a separate future decision unrelated to MiniWoB.

## Decision

**Drop BrowserGym entirely as a runtime dependency.** Replace it with a
hand-rolled MiniWoB driver (~50 lines of Python) that uses only stdlib +
Playwright, paired with a renamed and simplified TypeScript adapter.

## What Changed

- **Deleted:** `browsergym-bridge.py` (379 lines), `requirements.txt`,
  `setup-venv.mjs`, dedicated venv machinery.
- **Created:** `miniwob-driver.py` (~50 lines) — JSON-RPC server with
  `connect`, `setup`, `validate`, `teardown`, `ping` over CDP/ws attach.
  *(The driver subprocess itself was later eliminated by the attach
  elimination — the episode lifecycle now runs via `plugin.evaluate()`.)*
- **Renamed:** `browsergym-adapter.ts` → `miniwob-adapter.ts`, stripping
  all BrowserGym RPC surface (venv resolution, task table queries,
  `bridge.setup`/`validate` → `miniwob.setup`/`validate`).
- **Generated task list:** `setup-miniwob.mjs` now writes
  `generated/subdomains.ts` from the filesystem instead of querying a
  Python bridge.
- **No dedicated venv:** The driver runs in whatever venv the plugin's
  `pythonPath` points at (typically the chromium-py/firefox-py venv which
  already has `playwright>=1.50`).
- **Firefox `launchServer`/`_wsEndpoint` reconnect machinery reverted** —
  built for BrowserGym's cross-process ws attach; YAGNI without a named
  consumer. `getCdpEndpoint?` / `connectOverCDP?` were initially retained
  as general external-attach hooks and **later deleted** by the
  cross-process-attach elimination — see
  [`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md).

## Remaining Architecture

After this decision (and before the later attach elimination), the host
package shaped up as:

```
pi-lean-host/
├── adapter/
│   ├── miniwob-driver.py       ← Hand-rolled Python driver (replaces BrowserGym)
│   └── miniwob-adapter.ts      ← TS wrapper (renamed from browsergym-adapter)
├── solvers/
│   ├── parser.ts               ← @e-ref parsing
│   ├── trivial-solvers.ts      ← Trivial solvers
│   └── register-suite.ts       ← Suite registration
├── generated/
│   └── subdomains.ts           ← Generated task list (replaces Python round-trip)
├── suites/
│   ├── miniwob-trivial.test.ts
│   ├── miniwob-firefox.test.ts
│   └── adapter-smoke.test.ts
└── src/index.ts                ← Public API
```

The driver subprocess and the attach plumbing were subsequently removed by
the cross-process-attach elimination; see that decision for the current
shape (`miniwob-episode.ts` + `miniwob-adapter.ts` driving the lifecycle via
`plugin.evaluate`).

## Attribution

The MiniWoB driver's episode-setup protocol paraphrases the approach from
BrowserGym's `base.py` (ServiceNow, Apache-2.0) and MiniWoB++
(Farama-Foundation, Apache-2.0). The code is original and short enough to
be independently written; attribution is for the protocol design. The
later attach elimination copied BrowserGym's `removeDisplay` JS block
verbatim (Apache-2.0); that attribution is recorded in
`packages/pi-lean-host/adapter/miniwob-episode.ts`.
