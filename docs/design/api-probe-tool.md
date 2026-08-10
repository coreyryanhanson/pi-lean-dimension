# API Probe — a phase-0 shape-discovery tool

> Proposed, not yet built. Evaluate before committing. Implements **R1** of
> [`api-streamlining.md`](./api-streamlining.md) as the first-class guide-tool
> command it prescribes, and the dev-time probe hammered out in
> [`friction.md`](./friction.md). Companion to the authoring loop in
> [`api-guide-implementation-rollout.md`](./api-guide-implementation-rollout.md).
>
> A working **sketch** already exists at
> `packages/pi-lean-host/api-guides/_shared/probe.ts` (self-check passes, CI
> green). This plan promotes it from a dev script into a shipped tool and
> refines its contract (see "Contract change vs the sketch").

## What we're building

A new host tool, **`api-probe`**, that answers the question driving the whole
authoring loop: *"what does this endpoint actually return?"* One tool call
that, for a not-yet-guided API:

- fetches a path over the real transport (UA, charset, 429-retry, ETag —
  no reinvention),
- on 404, auto-tries `/v1/` `/v2/` version prefixes and reports which mount
  works,
- flags 401/403 as "requires authentication?" (caught `listRepoTeams` /
  `searchCode` up front in the GitHub build),
- summarizes the JSON shape (top-level type, keys, pagination markers),
- **suggests** `via` + `itemsPath` and echoes a **representative record id**
  for reuse as a detail-lookup param,
- emits a **draft YAML operation block** to paste into `guide.md`.

It **suggests; it never writes the guide.** The rollout's cross-cutting rule
("cite the source, don't invent endpoints") stays a human gate — the probe
only surfaces evidence faster. For re-probing an endpoint that already has a
guide, get the `apiHost` from `api-guide({domain})` first; `api-probe` takes
the bare URL because it's pre-guide.

## Why a tool, not a script

The consumer is the **agent doing the rollout** (one guide per turn), and the
agent works through tools, not bash. A script risks: an undiscoverable
filepath + arg shape the model must re-derive each turn; unstructured stdout
to re-parse instead of a structured result to lift into the recipe; and
api-learn's output being a transient response, a poor home for "how to run a
script." A tool returns the shape summary + draft as a structured result and
completes the existing authoring family:

```
api-probe (discover shape → draft)   — pre-guide, takes apiHost
api-learn (validate schema + save)   — post-draft, takes recipe
api-fetch (execute a saved op)       — post-guide, takes domain + operation
```

## Design

### Tool contract

```
api-probe({
  apiHost:      string,   // base URL incl version prefix, e.g. https://api.github.com
  path:         string,   // templated, e.g. /repos/{owner}/{repo}/branches
  params?:      Record<string, unknown>,  // fills {tokens} + query params
  tryPrefixes?: boolean,  // default true: on 404, try /v1/ and /v2/
})
```

Returns (text content + structured `details`):

- `status`, `ok`
- `shape`: `{ topLevel, isArray, keys, arrayLen, suggestedVia,
  suggestedItemsPath, paginationMarkers, representativeId? }`
- `draft`: a YAML `- name: … / via: … / path: … / accept: json / pagination:
  … / params: …` block, copy-paste ready
- `raw`: truncated body for eyeballing
- `note`: auth-required, non-JSON, version-prefix hit, etc.

### Contract change vs the sketch

The sketch took a **literal path** (`/repos/octocat/Hello-World/branches`) +
separate params. The tool takes a **templated path** with the recipe's `params`
dict, so `path` and `params` are exactly what the recipe will declare: `{token}`
path params are inferred and **not** re-declared in the emitted `params`, query
params come from the rest — mirroring the parser's rule (path params not
re-declared). This makes the draft a true copy-paste (the sketch's literal-path
draft would have hardcoded `octocat/Hello-World`, which the author would have
had to re-template by hand).

**Implementation note:** the sketch's `buildUrl` passes the path through
`new URL(p, base)` unchanged — it does **not** substitute `{token}`
placeholders, so a templated path would fetch literal `%7Bowner%7D`. Promoting
to the templated contract requires `buildUrl` to substitute `{token}` →
`params[token]` *before* constructing the URL. `emitDraft` already extracts
the same tokens for draft exclusion; reuse that extraction so the two stay
in lockstep.

### Shape logic (`summarize` — pure, unchanged from the sketch)

- **bare array** → `via: paginate`, `itemsPath: $` (root sentinel; confirms the
  flat-array convention from the GitHub build)
- **envelope** with an array-valued key (`results`/`items`/`search`/`docs`/…)
  → `paginate`, `itemsPath: <key>`
- **single object / bare number / string** → `restGet`, no `itemsPath`
- pagination markers (`offset`/`limit`/`page`/`per_page`/`continue`/`next`/…)
  drive the suggested style (`page` if `page`/`per_page` present, else
  `offset-limit`) — a 2-way heuristic the author confirms
- representative ID picked from `id|key|sha|usageKey|node_id|number|uuid|_id`
  on the first record

## Files touched

| File | Change |
|------|--------|
| `packages/pi-lean-host/tools/api-probe.ts` | **new** — `defineTool` (`api-probe`) + `summarize`/`probe` logic moved here from the sketch |
| `packages/pi-lean-host/api-guides/_shared/probe.ts` | **delete** — sketch superseded |
| `packages/pi-lean-host/tools/index.ts` | export `apiProbeTool` |
| `packages/pi-lean-host/index.ts` | `pi.registerTool(apiProbeTool)` |
| `packages/pi-lean-host/package.json` | add `tools/api-probe.ts` to `files[]` |
| `packages/pi-lean-host/core/api-toggle.ts` | add `"api-probe"` to `HOST_API_LEARN_SPEC.names` (the learn spec, alongside `api-learn` — see Q1 resolution); **update the `/api learn` help text** (module comment line 7, the `"enable all three tools"` string at line 174, and the learn status flag at line 137) to name `api-probe` so the learn set isn't misrepresented |
| `packages/pi-lean-host/tools/api-learn.ts` | one-line pointer in the worked-example: "discover the shape with `api-probe` first" |
| `packages/pi-lean-host/__tests__/api-probe.test.ts` | **new** structural test: `summarize` pure-logic cases (no network) |

`renderCall`/`renderResult` mirror `api-fetch` (TUI-consistent). The `demo()`
self-check moves with the logic into the new file.

## Testing / verification

- **`summarize` unit test** (`__tests__/api-probe.test.ts`, bare CI, no
  network): envelope→paginate+itemsPath, bare-array→`$`, single-object→restGet,
  representative-ID pick, marker→style guess.
- **`all-guides-parse` / `ship-manifest`**: unchanged — `api-probe.ts` added to
  `files[]`; `_shared/probe.ts` deleted so it stops being a stray non-shipped
  core-importing file.
- **`npm run test:ci`** green.
- **Live path is a request-spender** (see Risks) — the tool's *tool* tests stay
  unit-only; no `HOST_INTEGRATION` live suite for it, matching its role as a
  dev/discovery aid (its live behavior is exercised by the rollout agent).

## Out of scope / deferred

- **R2** (OpenAPI spec-diff) and **R3** (`api-learn validate: "live"`) — the
  docs' own build order says layer these on only when R1 proves recurring.
- **Mid-path version segments** (GBIF's `/v1/occurrence` vs `/v2/match`
  separate mounts) — prefix auto-try only inserts at the root; add a
  `tryPrefixes?: string[]` opt when a guide needs custom candidates.
- **Auto-authoring `guide.md` / token-templating of the draft** — the draft
  echoes the templated path already passed in; author confirms. No `{token}`
  inference beyond what `path` already carries.
- **Any executor change** — `api-fetch`/the paginator are untouched (the doc's
  "no runtime change" rule).

## Risks / caveats

- **Rate limits.** `api-probe` makes live requests. It does **not** fix the
  GitHub 60/hr verification budget — discovery is a build-phase win. Since it
  is opt-in (the agent calls it deliberately) and pre-guide, it doesn't
  balloon a verification run; but each probe call spends budget, so the agent
  should probe sparsely (the whole point: one probe replaces 2–4 curl batches).
- **"Cite the source" gate.** Suggestions (via/itemsPath/draft) are advisory;
  the operation must still be traceable to the plan file. The tool surfaces
  evidence, not authority — documented in the tool's description.
- **WAF'd APIs** (`datos.gob.es`, `www.federalregister.gov`). `api-probe` runs
  the same `transport.ts` pipeline as `api-fetch` (UA/headers), which is the
  sanctioned way to reach those — no new WAF exposure. But the tool's
  description should note that probing a WAF'd host is best done once the
  API-guide surface is reachable; bare probing may still hit Imperva/reCAPTCHA.
- **Ship surface.** A shipped tool adds registration + toggle + tarball entry
  - TUI render. Modest, but it's real surface — the reason this is a plan to
  review, not a done deal.

## Resolved decisions

1. **Toolset membership — group with `api-learn`, not base-on.** `api-probe`
   is an authoring-loop tool: it discovers shape *before a guide exists*.
   Once a guide exists you use `api-fetch`; a `/api on` user consuming APIs
   has no use for a shape-discovery tool. The authoring family is two phases:
   **probe + learn** (author) → **fetch** (runtime), so probe and learn are
   co-enabled. Add `"api-probe"` to `HOST_API_LEARN_SPEC.names`; `/api on`
   stays `api-guide + api-fetch`, `/api learn` adds `api-learn + api-probe`.
2. **Templated-path contract — yes.** Accept the templated path + `params`
   dict so drafts are true copy-paste; `buildUrl` substitutes `{token}`
   → `params[token]` before fetching (see the implementation note above).
3. **Timing — build now.** Batch D (~87 ops across 3 guides) is still pending
   and the probe loop recurs on every future guide, so this outlives the
   current rollout either way. The sketch is already validated and the diff
   is small; building now pays back immediately.
4. **`api-learn` pointer — in scope.** Add the one-line worked-example
   pointer ("discover the shape with `api-probe` first") so the probe→learn
   flow is discoverable in-tool, not just in this doc.

---

*Status: **greenlit** — decisions resolved. The implementation diff is small:
one new tool file, one deleted sketch, and the registration/toggle/tarball
wiring above.*
