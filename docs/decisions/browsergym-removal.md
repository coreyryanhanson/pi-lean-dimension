# Decision: Drop BrowserGym as a Runtime Dependency

**Date:** 2026-07-06
**Status:** Executed — see [`refactor/seperate-host-module`](../../REVIEW-FOLLOWUP-PLAN.md)

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
  consumer. Kept `getCdpEndpoint?` and `connectOverCDP?` as general
  external-attach hooks.

## Remaining Architecture

```
pi-lean-host/
├── adapter/
│   ├── miniwob-driver.py       ← Hand-rolled Python driver (replaces BrowserGym)
│   └── miniwob-adapter.ts      ← TS wrapper (renamed from browsergym-adapter)
├── solvers/
│   ├── parser.ts               ← @e-ref parsing (unchanged)
│   ├── trivial-solvers.ts      ← Trivial solvers (unchanged)
│   └── register-suite.ts       ← Suite registration (updated import)
├── generated/
│   └── subdomains.ts           ← Generated task list (replaces Python round-trip)
├── suites/
│   ├── miniwob-trivial.test.ts
│   ├── miniwob-firefox.test.ts
│   └── adapter-smoke.test.ts
└── src/index.ts                ← Public API
```

## Attribution

The MiniWoB driver's episode-setup protocol paraphrases the approach from
BrowserGym's `base.py` (ServiceNow, Apache-2.0) and MiniWoB++
(Farama-Foundation, Apache-2.0). The code is original and short enough to
be independently written; attribution is for the protocol design.
