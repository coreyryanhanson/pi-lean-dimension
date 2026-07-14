# AGENTS.md — pi-lean-dimension (package)

> Umbrella meta-package of the [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is a stub.** For the suite overview, install matrix, dev
> commands, and testing strategy, see [`../../AGENTS.md`](../../AGENTS.md).
> For the bundled children's internals, see
> [`../pi-lean-portal/AGENTS.md`](../pi-lean-portal/AGENTS.md) and
> [`../pi-lean-search/AGENTS.md`](../pi-lean-search/AGENTS.md).

## What this package is

**A codeless manifest package.** It bundles `pi-lean-portal` and
`pi-lean-search` into a single `pi install` command via
`bundledDependencies` + `node_modules/...` paths in `pi.extensions`:

```jsonc
{
  "pi": {
    "extensions": [
      "./node_modules/pi-lean-portal/index.ts",
      "./node_modules/pi-lean-search/index.ts"
    ]
  },
  "bundledDependencies": ["pi-lean-portal", "pi-lean-search"]
}
```

One `pi install npm:pi-lean-dimension` loads both extensions under a single
settings entry. `/web` registers **once** (owned by the bundled
`pi-lean-portal` — no `/web:1`/`/web:2` suffix). This is the full-suite
power-user install; it requires a running SearXNG server + URL config for
search to function (the browser works immediately; `web-search`
self-documents its setup on first call if SearXNG isn't configured).

## Files

- `package.json` — the manifest. No code, no dependencies beyond the bundled children.
- `README.md` — user-facing docs (install, prerequisites, full tool list).

There is nothing to maintain here beyond the manifest. Changes to the suite
happen in the bundled children; this package only ships when the bundled set
or version range changes.
