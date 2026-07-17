# pi-lean-dimension

> Web browsing and search tools for [Pi](https://github.com/earendil-works/pi), the AI coding agent.

A monorepo housing three Pi extension packages that give your AI agent the
ability to browse the web interactively, fetch static pages as Markdown, and
search via SearXNG — all toggled from a single `/web` command. When the toggle
is off, the tools are removed from the agent's context entirely, so web browsing
doesn't consume tokens or attention on sessions that aren't doing web work.
The same surfaces are user-extensible: author navigation guides that resurface
by domain, or drop in a stealth browser backend like [Camoufox](https://github.com/daijro/camoufox)
when a site blocks the shipped Chromium/Firefox.

## Quick start (recommended)

```bash
pi install npm:pi-lean-portal
npx playwright install chromium firefox
```

That's it — the tools are registered and start enabled by default. Control
them with `/web on|off|learn` (`on` = browser tools, `learn` = browser tools
plus guide-saving via `web-learn`, `off` = everything off). The state persists
per session. To set a different default for **new** sessions, add this to your
Pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{ "browserToggle": { "defaultEnabled": false } }
```

---

## Install options

| Mode | Command | What you get | Requires |
|---|---|---|---|
| **A — Browser** (recommended) | `pi install npm:pi-lean-portal` | 12 browser tools + `/web` command | `npx playwright install chromium firefox` |
| **B — Full suite** | `pi install npm:pi-lean-dimension` | 13 tools (browser + search) + `/web` | Playwright browsers + SearXNG server |
| **C — Search only** | `pi install npm:pi-lean-search` | `web-search` tool only | SearXNG server |

Notes the table doesn't cover:

- **Browser binaries aren't downloaded during `npm install`** (configured via `.npmrc`). The first `browser-navigate` call prompts you to run `npx playwright install chromium firefox` if they're missing.
- **SearXNG is optional for Mode B.** The browser works immediately without it; `web-search` returns a clear setup message on first call. When you do run it, point the suite at your instance in Pi settings:

  ```json
  { "searxng": { "url": "http://localhost:8888" } }
  ```

- **Search-only has no `/web` command** — a single tiny tool has nothing to toggle.

---

## What's included

### Packages

| Package | Type | Description |
|---|---|---|
| `pi-lean-portal` | Extension | Interactive browser + `/web` command owner. **12 tools + 1 command.** |
| `pi-lean-search` | Extension | SearXNG search tool (`web-search`). **1 tool + 1 command** (`/searxng-status`). |
| `pi-lean-dimension` | Umbrella meta-package | Bundles portal + search for one-command install. |

### Tools (13 total with search)

| Tool | Package | Purpose |
|---|---|---|
| `browser-navigate` | portal | Navigate to a URL, get an accessibility tree with `@e` element refs |
| `browser-snapshot` | portal | Re-extract the current page's accessibility tree (`@e` refs) and capture a screenshot to a temp file |
| `browser-click` | portal | Click an element by `@e` ref |
| `browser-type` | portal | Type text into an input by `@e` ref |
| `browser-scroll` | portal | Scroll the page |
| `browser-back` | portal | Navigate back |
| `browser-press` | portal | Press a key |
| `browser-console` | portal | Read console messages from the page |
| `browser-inspect` | portal | Query and extract text from elements |
| `web-fetch` | portal | Stateless fetch → Markdown (no JS) |
| `web-guide` | portal | Navigation guidance for a site or pattern |
| `web-learn` | portal | Save/update navigation guidance |
| `web-search` | search | Web search via SearXNG |

### Commands

| Command | Owner | Description |
|---|---|---|
| `/web on\|off\|learn\|cookies\|profile\|status` | portal | Unified toggle and management |
| `/searxng-status` | search | Test SearXNG connection and update status glyph |

### Status bar

When search is installed, two independent glyphs appear:

- `● idle` (browser) — browser tools enabled
- `● searxng` (search) — SearXNG health (accent=healthy, yellow=degraded, red=unreachable)

---

## Extending it

Beyond the `/web` toggle, two surfaces are user-driven rather than hardcoded:

- **Navigation guides** — `web-learn` saves site-specific playbooks that auto-match by domain and resurface in later sessions.
- **Custom browser backends** — if a site blocks the shipped Chromium/Firefox, drop a `bridge.py` subclass into `~/.pi/agent/pi-lean-portal/user-backends/` and drive a patched engine like [Camoufox](https://github.com/daijro/camoufox) yourself. A quirks schema declares how the engine diverges from base Playwright, and `launch` options flow from `settings.json` to the subprocess at runtime. This is user-authored, user-audited code that the extension never auto-downloads. Most installs never need it; the [portal README](packages/pi-lean-portal/README.md#stealth--custom-browser-backends) and [`contributed/README.md`](packages/pi-lean-portal/contributed/README.md) cover the full flow when you do.

---

## Development

```bash
git clone https://github.com/coreyryanhanson/pi-lean-dimension.git
cd pi-lean-dimension
npm install
npm test                    # vitest run — all workspace tests
```

## License

AGPL-3.0-only
