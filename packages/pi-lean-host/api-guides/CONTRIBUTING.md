# Contributing an API guide

> How a guide's tests stay decoupled from framework base code, and the
> shape every guide's test files follow. `boe.es` is the reference
> template — read it first, then copy its pattern.

## Directory layout

Each guide lives in its own directory under `api-guides/<domain>/` and
ships its **own** test files co-located with `guide.md`. Tests do **not**
live in `packages/pi-lean-host/__tests__/` — that dir holds framework
structural tests only.

```
api-guides/<domain>/
├── guide.md                       ← the recipe YAML
├── helper.ts                      ← optional; present when a guide needs a transform
├── endpoint-coverage-plan.md      ← frozen audit deliverable (read-only)
├── endpoint-coverage.test.ts      ← live coverage; HOST_INTEGRATION=1-gated
├── helper.test.ts                 ← only present when helper.ts exists
└── spec/                          ← optional cached docs reference (gitignored
                                     from the npm tarball, local dev only)
```

**Test wiring:** `vitest.config.ts` includes `packages/*/**/*.test.ts`,
so every co-located `*.test.ts` is picked up automatically — no central
registration. `npm run test:ci` runs them; bare CI skips the live ones
(they're `it.skip` unless `HOST_INTEGRATION=1`).

## Two test files, two jobs

- **`endpoint-coverage.test.ts`** — parses the recipe, executes **every**
  defined operation against the live endpoint, asserts each response has
  the expected shape (HTTP 200 + non-empty body / expected `itemsPath`).
  Gated by `HOST_INTEGRATION=1` → `it.skip` in bare CI. **This is the
  file every guide touches.** One assertion per operation (existing +
  new — not just the new ones).
- **`helper.test.ts`** — bare-CI transform checks (run every commit)
  **plus** `HOST_INTEGRATION=1`-gated live compose tests. Present whenever
  `helper.ts` exists; absent otherwise.

## When to add a `helper.ts`

Default to **no helper** — generalize via the recipe surface (`paginate`,
`passthrough`, `itemsPath`, `accept`, `parse`) whenever it can carry the
endpoint's shape. Reach for a `helper.ts` only when the response genuinely
needs a transform the recipe can't express: a positional array that must
be zipped into row objects (MediaWiki `opensearch`, Wayback CDX), a fat
`properties` bag that should be projected to a lean agent-ready set
(USGS GeoJSON), or a structural reshape the parser can't do for you.

Current guides with a helper: `boe.es`, `earthquake.usgs.gov`,
`en.wikipedia.org-action`, `web.archive.org` — each closes a real gap the
recipe surface couldn't. The decision criteria live in
  [`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md);
read it before adding another.

Transform contract: `(data, ctx) => unknown`, declared via `transform: true`
on the op in `guide.md`. Loaded by `loadTransform`, invoked by the
`restGet` (whole-body) or `paginate` (per-item) hookpoint. A throw falls
back to the raw body/item with a warning — graceful, never disables the op.
Pure function, no default export.

## Test harness: shared plumbing, per-file assertions

The `boe.es` recipe-setup pattern is reusable verbatim. Import the
temp-dir plumbing from
[`_shared/test-harness.ts`](./_shared/test-harness.ts):

- **`withTempDirs(domain, fn)`** — copies a guide folder into a temp dir
  and runs the real `apiFetch` pipeline against it. Byte-for-byte
  identical across every guide; never touches any API.
- **`createFetchOp(domain)`** — the generic `fetchOp` bootstrap: load the
  recipe, dispatch on `op.via` (`paginate` → `paginate`, else `restGet`).
- **`itWhen`** — the `HOST_INTEGRATION ? it : it.skip` gate.

`_shared/test-harness.ts` is **peer test plumbing, not framework code**.
It is not under `core/`, the framework never imports it, and a guide
reaches it via a relative path (`../_shared/test-harness.js`). This is
the line the audit drew — **don't couple recipes to base code** — and
sharing temp-dir plumbing between sibling test files is not base-code
coupling.

**Keep per-file, do not share:**

- A per-file `fetchOp` **wrapper** when a domain needs pacing, 503-retry,
  auth overlay, or similar (e.g. `openlibrary.org` 400ms pacing,
  `musicbrainz.org`/`api.gbif.org` 503-retry). Compose it around
  `createFetchOp`. The wrapper encodes domain-specific shape and cannot
  be shared.
- The per-op assertions. These encode domain-specific response shape
  (`restGet` vs `paginate`, `itemsPath`, rate limits) and cannot be
  shared.

A new guide imports `withTempDirs`, `createFetchOp`, and `itWhen` from
`../_shared/test-harness.js`, then swaps the domain + per-op assertions.
See `boe.es/endpoint-coverage.test.ts` for the reference shape.

## Reading the docs when authoring a guide

An endpoint-coverage plan (or a fresh guide) starts from the API's own
documentation, not from probing the live API. **Probe the API to confirm
shapes; read the official docs to know what endpoints exist.** A plan
built from probing alone is guesswork — it invents endpoints and misses
real ones.

- Reach for `browser-navigate` early. Many catalog docs sit behind a
  reCAPTCHA / Imperva WAF that serves a challenge page to `curl` and
  `web-fetch`; a real Chromium session loads the real docs. When the
  docs are a Swagger UI, `browser-console` can pull the full OpenAPI
  spec from the in-memory store
  (`window.ui.specSelectors.specJson().toJS()`) — the single most
  reliable way to get the authoritative endpoint list, paths, params,
  and enums in one shot. Track per-domain bot/WAF quirks in
  [`WAF-NOTES.md`](./WAF-NOTES.md).
- **Cite the source.** Every operation row in a plan must be traceable
  to a docs URL (and, where cached, a `spec/<file>.md` section). Don't
  invent endpoints.
- **Read-only only.** If unsure whether an endpoint mutates, treat it
  as out of scope and note the uncertainty — don't add it.
