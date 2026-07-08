# AGENTS.md — pi-lean-host (package)

> Benchmarking harness for the [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is a stub.** For the suite overview, install matrix, dev
> commands, registered tools/commands summary, testing strategy, and
> TypeScript quirks, see [`../../AGENTS.md`](../../AGENTS.md). For portal
> internals (the `BrowserPlugin` interface, router dispatch, profile/cookie
> persistence, snapshot cache, etc.), see
> [`../pi-lean-portal/AGENTS.md`](../pi-lean-portal/AGENTS.md).

## What this package is

**pi-lean-host** is the evaluation harness for `BrowserPlugin` backends.
It runs behavioral evaluation (MiniWoB++ tasks) against any
plugin implementation via `plugin.evaluate`-driven episode lifecycle
(setup/validate on the plugin's own page), while staying agnostic to
the plugin internals.

## Status

Phase 1 complete (all four backends — chromium, firefox, chromium-py,
firefox-py — pass the 13 trivial-solver MiniWoB tasks via
`plugin.evaluate`). See the [README](./README.md) for setup, usage,
and public API documentation.
