# pi-lean-host

> Declarative HTTP API client for Pi. Fetch structured data from REST APIs
> with recipe-based guides — no browser needed. Part of the
> [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite.

## Status

✅ **Sprints 1–8.5 complete.** Tools (`api-guide`, `api-fetch`, `api-learn`)
are functional, local user helpers are loaded on demand, the `/api` toggle
(on|off|learn|status|helpers) provides independent tool visibility with
persisted state, and portal co-install (Sprint 7) surfaces host API guides
in the navigation footer. Bundled reference recipes ship on GitHub
at `packages/pi-lean-host/api-guides/<domain>/{guide.md,helper.ts}`
(inert — copy a domain folder to use it).
See the [design doc](../../docs/design/pi-lean-host.md).

## Quick start

```bash
pi install npm:pi-lean-host               # host-only: api-guide, api-fetch, api-learn
pi install npm:pi-lean-host               # +pi-lean-portal (optional peer) = co-install
pi install npm:pi-lean-dimension          # all three: portal + search + host
```

### Install matrix

| Packages installed | Tools available |
|---|---|
| `pi-lean-host` only | api-guide, api-fetch, api-learn |
| `pi-lean-portal` + `pi-lean-host` | browser tools + web-search + API tools |
| `pi-lean-dimension` | all browser tools + search + API tools |

## Usage

| Command / Tool | Description | Sprint |
|---|---|---|
| `api-guide` tool | Browse or inspect API guides | S4 ✅ |
| `api-fetch` tool | Execute an API operation from a guide | S4 ✅ |
| `api-learn` tool | Write or update an API guide | S4 ✅ |
| `/api helpers` | List local user helpers, view source | S5 ✅ |
| `/api on\|off\|learn` | Toggle API tool visibility | S6 ✅ |
| `/api status` | Show active guides and helpers | S6 ✅ |

## Host-only property

`pi-lean-host` works with neither `pi-lean-portal` nor `pi-lean-search`
installed. All host source files are verified by a structural boundary test
to carry zero static imports from those packages. When co-installed with
`pi-lean-portal`, host API guides surface in portal's navigation footer
via a recipe-stripped projection (Sprint 7).

## Local user helpers

User-authored TypeScript helpers live alongside their guide in a per-guide
subdirectory: `~/.pi/agent/pi-lean-host/api-guides/<dirName>/helper.ts`.
One helper per guide directory (the v1 contract). A single domain may claim
multiple guides (each in its own directory, e.g. `archive.org` and
`archive.org-wayback` both declaring `domains: [archive.org]`); each carries
its own helper. Helpers are loaded via dynamic
`import()` and invoked as a **pre-call transform** — the helper receives the
agent-supplied parameters and returns the parameters the executor should use
for URL templating and query assembly. The same `helper.ts` may also export
a named `transform` that shapes the parsed response after the call — see
[Post-response transform](#post-response-transform) below.

### Helper contract

```ts
export default function(
  params: Record<string, unknown>,
  ctx: { operation: string; domain: string },
): Record<string, unknown> | Promise<Record<string, unknown>>;
```

Sync or async — both are awaited. The returned params replace the original
for that call.

### Post-response transform

The same `helper.ts` may export a named `transform` for shaping the parsed
response **after** `restGet`/`paginate` and before the result is returned to
the agent — zipping an array-of-arrays-plus-header into objects, stripping an
envelope, renaming fields, or projecting fields to keep the agent's context
lean. It is an optional valve a guide uses only when `itemsPath` /
`parseResponse` can't shape the response into what the agent needs.

```ts
export function transform(
  data: unknown,
  ctx: { operation: string; domain: string },
): unknown;
```

- **Gating:** per-operation `transform: true` in the op frontmatter (mirror
  of `helper: true`). Omitted → no transform runs.
- **Hookpoints:** `restGet` (single result) and `paginate` (per item).
- **Graceful, no disable:** a throw is caught per-call — the agent gets a
  warning and the raw untransformed data. Unlike the pre-call helper, a
  failing transform never disables the op (the raw body is always a valid
  fallback). For `paginate`, items whose transform throws go to a
  `failedItems` group (raw, untransformed); no item is dropped.
- **Cannot inspect response headers** (e.g. `Link`-header pagination) — only
  the parsed body.

### Authoring rules (synchronous-pure or fully-awaited, no background work)

The helper must be **synchronous-pure or fully-awaited** — it runs, returns
(or resolves), and is done. Never schedule background work inside a helper:

- `setTimeout(fn, 0)` / `setInterval(fn, interval)` — the callback runs on the
event loop after the helper returns, outside the try/catch guard.
- `process.on("uncaughtException", …)` — similarly escapes.

A throw from one of these callbacks becomes an **uncaughtException** that
cannot be caught by pi and will crash the process.

### Load/call guard — disable-on-failure

Both the `import()` and the helper invocation are wrapped in try/catch:

- **Load failure** (syntax error, missing dep, top-level throw): the helper
  is marked **disabled for the session** and pi keeps running. A subsequent
  `api-fetch` referencing this helper returns a structured error.
- **Execution throw**: the helper is also marked disabled and subsequent
  calls in the same session do not re-attempt the import (disabled cache hit).

This disable-on-failure guard applies to the pre-call `default export`. The
post-response `transform` named export uses per-call `try/catch` only — a
throw returns the raw data with a warning and never disables the op (see
[Post-response transform](#post-response-transform)).

### Visibility

```
/api helpers          — list all persisted helpers
/api helpers <domain> — print the helper source
```

Authoring is done via `api-learn` (in learn mode) or by directly editing
`~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts` — the command is
read-only.

## Bundled recipes

The repository ships reference recipes (and optional accompanying helpers) at
`packages/pi-lean-host/api-guides/` on GitHub. These are **inert reference
material** — they are not in the npm tarball and are never auto-loaded by the
package. To use a bundled recipe:

1. Copy the domain folder:
   `cp -r packages/pi-lean-host/api-guides/<domain> ~/.pi/agent/pi-lean-host/api-guides/`
2. Run `/api on` (or ensure the API toggle is enabled)
3. Call `api-guide({domain: "<domain>"})` to verify the guide is loaded

The recipes are worked examples that pass `parseApiGuide()` and are verified
against their live endpoints via the `HOST_INTEGRATION=1` integration smoke
suite. They do **not** execute until you copy them into your own directories.

### Available

| Domain | Description | Has helper |
|---|---|---|
| [boe.es](packages/pi-lean-host/api-guides/boe.es/) | BOE (Spanish official gazette) open-data API | ✅ |

## Configuration

API guides are authored via `api-learn` and stored in per-domain subdirectories
at `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`. No Pi settings
required.

### Toggle defaults

`/api` starts enabled in every new conversation (api-guide + api-fetch on,
api-learn off). To flip the default for **new** sessions, set a
`toolsetDefaults` block in `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project-local, overrides global):

```jsonc
{
 "toolsetDefaults": {
  "toolset-state:pi-lean-dimension.api": { "enabled": false },
  "toolset-state:pi-lean-dimension.api-learn": { "enabled": false }
 }
}
```

`toolsetDefaults` is read by the
[`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking/)
library on restore, before the toolset's packaged default. Omit a key to
use the packaged default (api on, api-learn off).

## Tests

```bash
npx vitest run packages/pi-lean-host/       # structural tests (always runs)
HOST_INTEGRATION=1 npx vitest run packages/pi-lean-host/  # + live endpoint smokes
```

Recipe-validity tests live alongside their recipe in `api-guides/<domain>/`
and are auto-discovered by vitest's `packages/*/**/*.test.ts` glob (same as
`__tests__/`). They are excluded from the npm tarball by the `files` allowlist
— no registry change needed when adding a new recipe test.

## License

AGPL-3.0-only
