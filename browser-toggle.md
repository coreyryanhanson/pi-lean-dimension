# browser-toggle — Browser Tool Toggle (integrated into pi-browser)

The `/web on`, `/web off`, and `/web status` commands toggle all browser automation
tools in pi's system prompt. When disabled, the LLM cannot see the tools — no
descriptions, parameter schemas, or guidelines — saving roughly 1500–2000 tokens
per turn.

## Files

| File | Purpose |
|------|---------|
| `pi-browser/browser-toggle.ts` | Module with helpers + `initBrowserToggle()` (integrated into pi-browser) |
| `pi-browser/__tests__/browser-toggle.test.ts` | 41 unit tests (part of pi-browser's test suite) |
| `pi-browser/index.ts` | Calls `initBrowserToggle(pi)` during startup |

## What It Does

- **`/web on`** — Adds all 11 browser tools (`web-fetch` + 10 `browser-*`) back into the active tool set
- **`/web off`** — Removes all 11 browser tools from the active tool set
- **`/web`** (or `/web status`) — Shows current state and help text
- **Persistence** — Toggle state is saved via `pi.appendEntry()` and restored across `/reload`, `/resume`, `/fork`, and `/tree` navigation

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

## Edge Cases Handled

- **No pi-browser installed** — graceful no-op with a notification (though toggle is bundled with pi-browser, so this is defensive)
- **Idempotent** — `/web off` when already off does nothing
- **Partial registration** — only toggles the browser tools that are actually registered
- **Stale persisted state** — saved state referencing now-uninstalled tools is safely ignored
- **Branch-aware restoration** — the last toggle in the branch wins (handles on→off→on sequences)

## Testing

41 tests in `pi-browser/__tests__/browser-toggle.test.ts`:

```
getRegisteredBrowserTools ........... 7 tests  (empty, partial, full, case, metadata)
isBrowserEnabled .................... 5 tests  (all/off/partial/vacuous/empty)
applyBrowserState(true) ............. 5 tests  (add, preserve, dedupe, union, no-op)
applyBrowserState(false) ............ 5 tests  (remove, preserve, no-op x3, repeat)
persistState ........................ 3 tests  (customType, on shape, off shape)
restoreFromBranch ................... 6 tests  (none found, apply T/F, last wins, no tools, stale)
factory + command handler .......... 10 tests  (registration, on/off dispatch, idempotency, missing, garbage)
```

Run with: `cd pi-browser && npx vitest run browser-toggle`

## Related

- Part of the `pi-browser` extension (`~/.pi/agent/extensions/pi-browser/`)
- Modeled after the `/tools` extension pattern in `@earendil-works/pi-coding-agent/examples/extensions/tools.ts`
