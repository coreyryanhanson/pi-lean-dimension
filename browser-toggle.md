# browser-toggle — Browser Tool Toggle (integrated into pi-browser)

The `/web on`, `/web off`, and `/web status` commands toggle all browser automation
tools in pi's system prompt. When disabled, the LLM cannot see the tools — no
descriptions, parameter schemas, or guidelines — saving roughly 1500–2000 tokens
per turn.

## Files

| File | Purpose |
|------|---------|
| `pi-browser/browser-toggle.ts` | Module with helpers + `initBrowserToggle()` (integrated into pi-browser) |
| `pi-browser/__tests__/browser-toggle.test.ts` | 62 unit tests (part of pi-browser's test suite) |
| `pi-browser/index.ts` | Calls `initBrowserToggle(pi)` during startup |

## What It Does

- **`/web on`** — Adds all 11 browser tools (`web-fetch` + 10 `browser-*`) back into the active tool set
- **`/web off`** — Removes all 11 browser tools from the active tool set
- **`/web`** (or `/web status`) — Shows current state and help text
- **Persistence** — Toggle state is saved via `pi.appendEntry()` and restored across `/reload`, `/resume`, `/fork`, and `/tree` navigation
- **Config-driven default** — The initial browser state for fresh sessions (no saved toggle history) can be set via `browserToggle.defaultEnabled` in pi's settings.json

## Key APIs Used

| API | Usage |
|-----|-------|
| `pi.registerCommand("web", ...)` | Registers the `/web` slash command |
| `pi.getAllTools()` | Discovers all registered tool names |
| `pi.getActiveTools()` | Reads the current active tool set |
| `pi.setActiveTools(names)` | Switches the active tool set (this is what hides tools from the LLM) |
| `pi.appendEntry(customType, data)` | Persists toggle state in the session |
| `pi.on("session_start")` | Restores state on session start |
| `pi.on("session_tree")` | Restores state on branch navigation |

## Architecture

```
User:  /web off
         │
         ▼
  browser-toggle.ts :: initBrowserToggle(pi)
    pi.registerCommand("web", { handler })
         │
         ▼
    isBrowserEnabled(pi)  →  calls pi.getActiveTools()
         │
         ▼
    applyBrowserState(pi, false)
      → pi.getAllTools()           // discover registered tools
      → pi.setActiveTools(filtered)  // remove browser tools
         │
         ▼
    persistState(pi, false)
      → pi.appendEntry("browser-toggle-state", { enabled: false })
```

The helper functions are exported for testing and take `pi: ExtensionAPI` explicitly, making them fully mockable.

## Config-Driven Default

For fresh sessions (no saved toggle state in the branch — e.g., a brand-new pi
session, a `/new`, or a fresh-context subagent), the extension reads
`browserToggle.defaultEnabled` from pi's settings files:

```json
// ~/.pi/agent/settings.json  (global)
// or .pi/settings.json       (project-local, overrides global)
{
  "browserToggle": {
    "defaultEnabled": false
  }
}
```

### Resolution order

```
session_start
  │
  ├─ Saved state in branch?  ──yes──→ restore that state, done
  │
  └─ No saved state?
       │
       ├─ browserToggle.defaultEnabled found?  ──yes──→ apply value, persist
       │
       └─ No config?  → default: enabled (true, backward compatible)
```

When the config default is applied, it is persisted into the session branch so
that subsequent `/tree` navigation and `/reload` see it as a regular toggle state.

### Settings merge semantics

Project settings (`.pi/settings.json`) override global settings
(`~/.pi/agent/settings.json`), following the same merge rules as pi's own
settings. The `browserToggle` object from the project file wins entirely
over the global one.

## Edge Cases Handled

- **No pi-browser installed** — graceful no-op with a notification (though toggle is bundled with pi-browser, so this is defensive)
- **Idempotent** — `/web off` when already off does nothing
- **Partial registration** — only toggles the browser tools that are actually registered
- **Stale persisted state** — saved state referencing now-uninstalled tools is safely ignored
- **Branch-aware restoration** — the last toggle in the branch wins (handles on→off→on sequences)
- **Config file not present** — silently falls back to default (enabled)
- **Malformed settings JSON** — silently falls back to default
- **`browserToggle.defaultEnabled` is not a boolean** — silently falls back to default
- **Global + project merge** — project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`

## Testing

62 tests in `pi-browser/__tests__/browser-toggle.test.ts`:

```
getRegisteredBrowserTools ........... 7 tests  (empty, partial, full, case, metadata)
isBrowserEnabled .................... 5 tests  (all/off/partial/vacuous/empty)
applyBrowserState(true) ............. 5 tests  (add, preserve, dedupe, union, no-op)
applyBrowserState(false) ............ 5 tests  (remove, preserve, no-op x3, repeat)
persistState ........................ 3 tests  (customType, on shape, off shape)
restoreFromBranch ................... 9 tests  (+3 for boolean return value)
factory + command handler .......... 10 tests  (registration, on/off dispatch, idempotency, missing, garbage)
readBrowserToggleConfig ............ 8 tests  (missing files, no key, true/false, malformed,
                                                non-boolean, non-object, project override)
applyConfigDefault .................. 4 tests  (enable, disable, persist, no-op)
```

Run with: `cd pi-browser && npx vitest run browser-toggle`

## Related

- Part of the `pi-browser` extension (`~/.pi/agent/extensions/pi-browser/`)
- Modeled after the `/tools` extension pattern in `@earendil-works/pi-coding-agent/examples/extensions/tools.ts`
