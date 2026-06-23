# AGENTS.md — pi-lean-search (package)

> SearXNG search leaf of the [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is a stub.** For the suite overview, install matrix, dev
> commands, registered tools/commands summary, status bar slots, testing
> strategy, and TypeScript quirks, see [`../../AGENTS.md`](../../AGENTS.md).
> For portal internals, see [`../pi-lean-portal/AGENTS.md`](../pi-lean-portal/AGENTS.md).

## What this package is

- Registers the **`web-search`** tool (SearXNG-backed web search) and the
  **`/searxng-status`** diagnostic command.
- Registers **no `/web` command** — portal owns `/web` outright. Search is a
  silent leaf; portal discovers `web-search` by exact-name `Set.has()`
  membership and toggles it via `/web on|off`.
- Manages the **`search` status bar slot** with health-colored glyphs
  (`● searxng` accent/blue when healthy, warning/yellow when degraded,
  error/red when unreachable). Probes SearXNG reachability on `session_start`
  and `/searxng-status`. Portal writes the `○ searxng` off state when
  `/web off` is called — search overrides with the health-colored glyph on
  the next probe.

## Files

- `index.ts` — entry: tool registration, health probe, `/searxng-status` command, search slot management.
- `web-search-tool.ts` — `defineTool` for `web-search` (execute + TUI rendering).
- `search-config.ts` — settings reader for `searxng.url`.
- `verify-ship-manifest.ts` / `ship-manifest.test.ts` — production `.ts` coverage check.
- `__tests__/web-search.test.ts` — config reader + tool structure tests.
- `README.md` — user-facing docs (install, config, graceful degradation).

## Configuration

Search reads **exclusively** from Pi settings — never environment variables:

**`~/.pi/agent/settings.json`** (global) or **`.pi/settings.json`** (project-local):

```json
{
  "searxng": { "url": "http://localhost:8888" }
}
```

## Graceful degradation

If `searxng.url` is unset or SearXNG is unreachable, `web-search` returns a
clear setup message on call (not a thrown error, not a silent empty result).
This keeps `pi-lean-dimension` (the umbrella) safe to install before SearXNG
is ready — the browser works immediately, and `web-search` self-documents
its setup.

## Peer relationship

`pi-lean-search` declares `pi-lean-portal` as a **soft peer**
(`peerDependencies` + `peerDependenciesMeta.optional: true`). Search-only
installs are valid — the tool works standalone, it just doesn't get a `/web`
toggle. Portal lists `"web-search"` in its `SIBLING_TOOL_NAMES` set so
`/web on|off` picks it up automatically when both are installed.
