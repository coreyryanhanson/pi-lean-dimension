# pi-lean-dimension

> Web browsing and search tools for [Pi](https://github.com/earendil-works/pi-coding-agent), the AI coding agent.

A monorepo housing three Pi extension packages that give your AI agent the
ability to browse the web interactively, fetch static pages as Markdown, save
navigation guides, and search via SearXNG — all toggled from a single `/web`
command.

## Quick start (recommended)

```bash
pi install npm:pi-lean-portal
npx playwright install chromium firefox
```

That's it. The AI agent now has 12 browser tools and the `/web` command. It can
navigate, click, type, scroll, screenshot, inspect elements, read console
messages, fetch static pages, and recall navigation guides.

---

## Install options

| Mode | Command | What you get | Requires |
|---|---|---|---|
| **A — Browser** (recommended) | `pi install npm:pi-lean-portal` | 12 browser tools + `/web` command | `npx playwright install chromium firefox` |
| **B — Full suite** | `pi install npm:pi-lean-dimension` | 13 tools (browser + search) + `/web` | Playwright browsers + SearXNG server |
| **B-search — Search only** | `pi install npm:pi-lean-search` | `web-search` tool only | SearXNG server |

### Mode A — Browser (recommended)

```bash
pi install npm:pi-lean-portal
npx playwright install chromium firefox
```

The browser works immediately. The AI agent navigates, clicks, types, scrolls,
takes screenshots, fetches static pages as Markdown, and saves/recalls
navigation guides. All controllable via `/web on|off|learn|profile|status`.

The Playwright browser binaries are **not** downloaded during `npm install`
(configured via `.npmrc`). The first `browser-navigate` call will prompt you
to run `npx playwright install chromium firefox` if browsers are missing.

### Mode B — Full suite (power-user)

```bash
pi install npm:pi-lean-dimension
npx playwright install chromium firefox
```

Adds SearXNG web search alongside browsing. Requires a running SearXNG
instance. After install, configure your SearXNG URL in Pi settings:

```json
{ "searxng": { "url": "http://localhost:8888" } }
```

The browser works immediately even without SearXNG configured. If you call
`web-search` without setting up SearXNG, it returns a clear setup message
pointing you to the documentation.

### Mode B-search — Search only

```bash
pi install npm:pi-lean-search
```

SearXNG search without the browser. No `/web` command — a single tiny tool
has nothing to toggle. Configure `searxng.url` in settings per Mode B above.

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
| `browser-snapshot` | portal | Refresh the current page snapshot |
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

## Development

```bash
git clone https://github.com/coreyryanhanson/pi-lean-dimension.git
cd pi-lean-dimension
npm install
npm test                    # vitest run — all workspace tests
```

See [`AGENTS.md`](./AGENTS.md) for the full developer guide, architecture
documentation, test layout, and debugging tips.

## License

AGPL-3.0-only
