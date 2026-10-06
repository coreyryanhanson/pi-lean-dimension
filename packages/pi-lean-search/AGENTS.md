# AGENTS.md — pi-lean-search (package)

> SearXNG search leaf of the [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> **This file is a stub.** For the suite overview, install matrix, dev
> commands, registered tools/commands summary, testing strategy, and
> TypeScript quirks, see [`../../AGENTS.md`](../../AGENTS.md). For portal
> internals, see [`../pi-lean-portal/AGENTS.md`](../pi-lean-portal/AGENTS.md).

## What this package is

- Registers the **`web-search`** tool (SearXNG-backed web search) and the
  **`/searxng-status`** diagnostic command.
- Registers **no `/web` command** — portal owns `/web` outright. Search is a
  silent leaf; portal discovers `web-search` by exact-name `Set.has()`
  membership and toggles it via `/web on|off|learn`.
- Manages the **`search` status bar slot** (see "Status Bar" below).

## Files

- `index.ts` — entry: tool registration, health probe, `/searxng-status` command, search slot management.
- `web-search-tool.ts` — `defineTool` for `web-search` (execute + TUI rendering).
- `search-config.ts` — settings reader for `searxng.url`.
- `__tests__/ship-manifest.test.ts` — production `.ts` coverage check (reuses the portal helper at `pi-lean-portal/__tests__/helpers/ship-manifest.ts`).
- `__tests__/web-search.test.ts` — config reader, tool structure, and glyph-sync tests (co-activation is portal-owned; search listens to no web events — see `index.ts` glyph-sync comment).
- `README.md` — user-facing docs (install, config, graceful degradation).

## Configuration

Search reads **exclusively** from Pi settings — never environment variables:

**`~/.pi/agent/settings.json`** (global) or **`.pi/settings.json`** (project-local):

```json
{
  "searxng": { "url": "http://localhost:8888" }
}
```

## Status Bar (`search` slot)

Search owns the `search` status bar slot, shown only when `pi-lean-search` is installed:

- `● searxng` (accent/blue) — healthy and reachable
- `● searxng` (warning/yellow) — server up but pipeline degraded
- `● searxng` (error/red) — unreachable
- `○ searxng` — search tools off
- *(no slot)* — unconfigured: no `searxng.url` in settings; a one-time warning notify on Pi process boot (`session_start` `reason: "startup"` only, not `/new`/`/resume`/`/fork`) points at the setting

Search probes SearXNG reachability on `session_start` and `/searxng-status` and sets the glyph color. The `○ searxng` off state follows `changed`/`restored` on search's own `pi-lean-dimension.search` id: when portal's `/web off` batch disables the toolset, the resulting `changed` event re-renders the glyph; the health-colored glyph returns on the next probe. (The `browser` slot is owned by `pi-lean-portal`; see that package's `AGENTS.md`.)

## Graceful degradation

If `searxng.url` is unset or SearXNG is unreachable, `web-search` returns a
clear setup message on call (not a thrown error, not a silent empty result).
This keeps `pi-lean-dimension` (the umbrella) safe to install before SearXNG
is ready — the browser works immediately, and `web-search` self-documents
its setup. The status bar slot is hidden while unconfigured; a one-time warning
notify at Pi startup (boot only, not `/new`/`/resume`/`/fork`) points at the
`searxng.url` setting.

## Peer relationship

`pi-lean-search` declares `pi-lean-portal` as a **soft peer**
(`peerDependencies` + `peerDependenciesMeta.optional: true`). Search-only
installs are valid — the tool works standalone, it just doesn't get a `/web`
toggle. Co-activation is **portal-owned**: portal's `/web on|off|learn`
handler issues one `toggleBatch` that names `pi-lean-dimension.search`
directly (as a string constant in portal's `browser-toggle.ts` — portal
imports nothing from search), so `/web` sets search's toolset
unconditionally, even when web itself hasn't drifted. On a portal-only
install the search op is filtered out via masking's
`getRegisteredToolsets()`. Search itself listens to no web events:
non-`/web` paths (`/tbox`, groups, focus, restore) affect only the
toolsets they name, and search remains independently togglable via
`/tbox +pi-lean-dimension.search on|off`.
