# Decision Record: BrowserGym Migration Plan (Option C — superseded)

**Status:** Superseded — BrowserGym dropped as a runtime dependency.
**See also:** [`browsergym-removal.md`](./browsergym-removal.md) for the replacement decision.

## Context

During the `cleanup/use-benchmarking-libraries` branch, a plan was drafted to
adopt `browsergym[miniwob]` as a dev-only Python dependency for MiniWoB++
task evaluation (Option C), replacing the hand-ported Option D implementation.
The plan proposed using BrowserGym purely as a task/reward source while
keeping our `@e`-ref accessibility model and `BrowserPlugin` action layer
untouched, with cross-process page sharing via CDP attach.

Key architectural decisions from the plan that survived:

- **New `pi-lean-host` package** — host is a consumer of `pi-lean-portal`,
  separate release cadence, not in the umbrella meta-package.
- **Chromium-first attach** — CDP attach for chromium was the primary path;
  Firefox `launchServer` deferred.
- **Integration-test split** — behavioral evaluation moves to `pi-lean-host`;
  portal framework-internals stay in `pi-lean-portal` as mocked unit tests.
- **User-plugin benchmarking as first-class** — `pi-lean-host` exports a
  public API (`benchPlugin`, `registerMiniwobSuite`, etc.) for any
  `BrowserPlugin`.
- **`getCdpEndpoint?()` and `connectOverCDP?()`** added to `BrowserPlugin`
  interface.

## Why Superseded

After integration, three structural problems emerged:

1. **Playwright version pin (`==1.44`)** — BrowserGym pins Playwright at 1.44,
   structurally incompatible with a browsing tool that must stay current.
2. **In-process design overhead** — complexity without benefit to the
   core mission.
3. **WebArena not the right justification** — separate concern.

BrowserGym was replaced with a hand-rolled MiniWoB driver (~50 lines Python)
using only stdlib + Playwright, paired with a simplified TypeScript adapter.
See [`browsergym-removal.md`](./browsergym-removal.md) for full details.

## Attribution

This document originally contained the full 1058-line migration plan
(Option C architecture, phase breakdowns, package layout, CI wiring, and
roadmaps). It was trimmed to this decision record as part of Phase 0 cleanup
once the plan was superseded.
