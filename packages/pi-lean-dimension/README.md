# pi-lean-dimension

The full web-tools suite for Pi — interactive web browsing and SearXNG search,
unified under `/web`.

**This is an umbrella meta-package.** It bundles
[`pi-lean-portal`](https://www.npmjs.com/package/pi-lean-portal) (browser) and
[`pi-lean-search`](https://www.npmjs.com/package/pi-lean-search) (SearXNG search)
into a single `pi install` command.

## Install

```bash
pi install npm:pi-lean-dimension
```

### Prerequisites

- **Playwright browsers** (for browsing):

  ```bash
  npx playwright install chromium firefox
  ```

- **SearXNG instance** (for search, optional): configure the URL in settings:

  ```json
  { "searxng": { "url": "https://searxng.example.com" } }
  ```

The browser works immediately after `npx playwright install`. The search tool
self-documents its setup on first call if SearXNG isn't configured.

## What you get

| Tool | Purpose |
|---|---|
| `browser-navigate` | Navigate to a URL, get an accessibility tree with `@e` element refs |
| `browser-snapshot` | Re-extract the current page's accessibility tree (`@e` refs) and capture a screenshot to a temp file |
| `browser-click` | Click an element by `@e` ref |
| `browser-type` | Type text into an input by `@e` ref |
| `browser-scroll` | Scroll the page |
| `browser-back` | Navigate back |
| `browser-press` | Press a key |
| `browser-console` | Read console messages from the page |
| `browser-inspect` | Query and extract text from elements |
| `web-fetch` | Stateless fetch → Markdown (no JS) |
| `web-guide` | Navigation guidance for a site or pattern |
| `web-learn` | Save/update navigation guidance |
| `web-search` | Web search via SearXNG |

### Commands

- `/web on|off|learn|cookies|profile|status` — unified toggle and management

## License

AGPL-3.0-only
