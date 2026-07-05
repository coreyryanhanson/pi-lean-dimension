# pi-lean-host

> Placeholder for future pi-lean-portal browser benchmarking suite.

**pi-lean-host** is the evaluation harness for
[pi-lean-portal](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-portal)
`BrowserPlugin` backends against [BrowserGym](https://github.com/ServiceNow/BrowserGym)
task suites (MiniWoB, WebArena, WorkArena, etc.).

This package is **research tooling** — it consumes `pi-lean-portal`'s
`BrowserPlugin` interface and runs behavioral evaluation tests (MiniWoB,
WebArena, custom task packages) against any plugin implementation.

## Status

🚧 **Placeholder** — the §1.0 CDP endpoint spike has completed successfully
(see [`docs/cdp-endpoint-spike.md`](docs/cdp-endpoint-spike.md)), proving that
two Playwright clients can share one Chromium instance via CDP attach with
no `@e`-ref contamination. Full implementation follows the
[BrowserGym migration plan](../../browsergym-migration-plan.md).

## Planned contents

- `adapter/browsergym-bridge.py` — Python JSON-RPC adapter for BrowserGym
  task setup/validate
- `adapter/browsergym-adapter.ts` — TypeScript wrapper, CDP attach, task
  lifecycle
- `solvers/` — Trivial solvers for MiniWoB parity validation
- `suites/` — Test files that run BrowserGym tasks against BrowserPlugin
  backends
- `scripts/setup-venv` — Dedicated BrowserGym virtual environment
- `scripts/setup-miniwob` — MiniWoB++ HTML content checkout

## npm namespace

`pi-lean-host` is published to npm as a **placeholder** (`0.0.1`) to
reserve the name. Real content ships under later versions.

## License

AGPL-3.0-only
