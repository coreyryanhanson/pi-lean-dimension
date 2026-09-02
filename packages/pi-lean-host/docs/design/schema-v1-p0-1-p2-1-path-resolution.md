# Plan — P0-1 + P2-1: Dotted JSON Keys & Numeric Cursor Coercion

> Status: planned (not yet started). Seeds from
> [`schema-v1-pre-release-backlog.md`](./schema-v1-pre-release-backlog.md)
> items **P0-1** and **P2-1** (paired there by design: same function, same
> test file). Scope is locked to those two items — P0-3, P0-2, and the P1/P2
> queues are out of scope here.
>
> **Standing constraints (from the review brief, apply to every step):**
> read-only forever (GET-only transport), one parser / two call sites,
> host-only boundary, 1 local helper per domain.

## Problem (one paragraph each)

**P0-1 — dot-containing JSON keys.** OData v4 services (Microsoft Graph,
SharePoint REST, Dynamics 365, SAP OData) paginate via a literal top-level
key `@odata.nextLink` — the dot is part of the key name, not a path
separator. `resolveJsonPath` (`core/helpers.ts`) dot-splits every path, so
`@odata.nextLink` → `["@odata", "nextLink"]` → `undefined` →
`advancePagination` returns null → **gatherAll silently terminates after
page 1 reporting success**. The bracket-quote form `['@odata.nextLink']`
degrades into the same bug (regex rewrite → dot-split). No workaround
exists: local helpers are pre-call params-only; `transform` runs post-parse
and never sees pagination advance. Hits `itemsPath`, `nextLinkPath`,
`cursorPath`, `tokenPath`, `totalCountPath` alike.

**P2-1 — numeric cursor coercion.** All three value branches in
`advancePagination` require `typeof === "string"` and otherwise return
`null` — indistinguishable from genuine exhaustion. A numeric continuation
value (integer `next_cursor`, numeric page token) yields a
**silently truncated result reported as a complete list**. `tokenBag`
already coerces via `String(v)` — the codebase disagrees with itself.
(OAI-PMH's final `<resumptionToken/>` is *not* this bug: it parses as an
attribute-only object, which coercion would mangle into
`"[object Object]"` — it's already expressible today via
`tokenPath: "resumptionToken.#text"`, per the backlog's P2-10
verified-fine list. Out of scope here.)

Both fix variants of the same worst-case failure mode: *silently truncated,
reported as complete*.

## Fix shape (from the backlog, unchanged)

1. **P0-1 (behavior, no YAML change, no bump):** quoted bracket segments
   become atomic keys in `resolveJsonPath` — capture `['…']` segments
   (dots included) *before* dot-splitting. Unquoted legacy paths parse
   identically. Unquoted `@odata.nextLink` keeps failing exactly as today
   — silently (undefined → null → single page, reported complete). The
   guarantee is *no silent **wrong** match*, not loud failure; do not
   "improve" this into a warning later thinking it was already loud.
2. **P2-1 (behavior, no bump):** coerce numbers to strings in
   `advancePagination` exactly like `tokenBag` — but **only** where a
   numeric continuation is meaningful: `typeof === "number"` in the
   `cursor` and `resumptionToken` branches. The `nextLink` branch stays
   string-strict (a numeric "next URL" is garbage — stop, don't send a
   bogus request), and booleans/objects do not coerce (boolean
   continuation values are P0-3 `hasMorePath` territory). Keep `""`/
   missing as exhaustion.

## Sprint 0 — Candidate research (caritas recipe selection)

**Goal:** pick the real-world API that will carry the comprehensive caritas
recipe *before* anything is built, so the axis guide (Sprint 3) can be
modeled on it — selected cleanly and minimally — and so the fix is proven
against a production shape, not a synthetic one.

**Task:** research and enumerate candidate APIs exhibiting the target
shape(s), then present a shortlist so the human can choose one that:

- **maximizes user impact** — an API our users actually hit, with real
  pagination volume (deep listing, not one-page curiosities);
- **fits the brand** — consistent with the kind of read-only data sources
  caritas already covers;
- **exercises the shape cleanly** — ideally dotted-key pagination
  (`@odata.nextLink` family) and/or a numeric cursor, over plain
  unauthenticated or static-key GET (read-only);
- **is testable live** — stable docs, no auth wall beyond the store's
  scope, pagination observable in a handful of requests.

**Candidate families to survey** (starting points, not the limit):

- OData v4: Microsoft Graph, SharePoint REST, Dynamics 365, SAP OData
  (`@odata.nextLink` / `@odata.count` — the canonical P0-1 shape).
- Numeric-cursor APIs (the P2-1 shape) — to be identified during research;
  note any API exhibiting *both* shapes, which would be the strongest
  single candidate.

**Deliverable:** a shortlist (2–4 candidates) with evidence links, endpoint
shape, auth requirements, and a one-line impact/brand assessment each —
presented for the human to pick the winner. Record the choice (and the
runners-up) in this doc before Sprint 1 starts, so the axis guide's shape
is pinned before code lands.

## Sprint 1 — Code fix + unit tests (host)

Both fixes land as **one work item** (same function territory, same test
file), before any guide work — no recipe should be written against the
broken behavior.

1. `core/helpers.ts` — `resolveJsonPath`: atomic quoted-bracket segments.
2. `core/helpers.ts` — `advancePagination`: numeric → string coercion
   (`typeof === "number"` only), `tokenBag`-style, in the `cursor` and
   `resumptionToken` branches; `nextLink` stays string-strict.
3. Tests, split by subject:
   - **Resolver unit cases** in the existing `describe("resolveJsonPath")`
     block in `__tests__/helpers.test.ts` (alongside their siblings — pure
     path resolution, no paginate machinery):
     - `['@odata.nextLink']` resolves (dotted key, quoted).
     - Unquoted `@odata.nextLink` misses (no silent *wrong* match).
     - Unquoted legacy paths parse identically (regression).
     - Mixed bracket index + quoted segment: `data[0]['key.name']`.
   - **Paginate-level cases** in `__tests__/axis-units.test.ts` (the file
     the backlog names — mocked transport, inline YAML):
     - Quoted `nextLinkPath: "['@odata.nextLink']"` walks past page 1.
     - Numeric cursors advance (cursor + resumptionToken branches); numeric
       nextLink still terminates; `""`/missing still terminate.
     - `totalCountPath: "['@odata.count']"` resolving to a numeric
       `serverTotal` (OData exposes totals via the same dotted-key family).
4. Authoring docs: document the `['…']` escape-hatch so caritas recipes
   are written correctly the first time (backlog P0-1's own fix line —
   one paragraph where path syntax is documented).

**Deliverable:** green `npx vitest run packages/pi-lean-host` with the new
cases; no schema bump, no guide-format change.

## Sprint 2 — Comprehensive caritas recipes

Two guides, not one — multiple recipes of different shapes reinforce that
the generalization works rather than fitting one provider:

1. **FROST-Server (OGC SensorThings API)** — the Sprint-0 winner. Guide
   exercises the dotted-key / numeric-count shape end-to-end via the
   Sprint-1 fix: `pagination` block using quoted-bracket paths (e.g.
   `nextLinkPath: "['@iot.nextLink']"`), plus
   `totalCountPath: "['@iot.count']"`. Live-verify the paginate loop
   actually walks past page 1 and terminates correctly (the exact behavior
   that was silently broken).
2. **OpenFoodFacts Search API v2** — the second recipe, shape B only
   (numeric `page` echoed in the body, fed back as `?page=N`; AGPL-3.0,
   community-run non-profit, no auth). Proves the numeric-cursor coercion
   fix against a second, structurally different provider.

**Deliverable:** merged caritas guides, live-verified. This is the
production proof the fix works against real providers.

(MediaWiki Action API was considered as a third candidate but is already
covered by caritas's existing `wikimedia-action` guide —
`tokenBag` `continue.rccontinue` + offset-limit `sroffset` — and would be
duplicate coverage.)

## Sprint 3 — Synthetic axis guide (host)

Add the axis candidate to the host framework fixture set, modeled minimally
on the Sprint-2 recipe — same shape, synthetic data, mocked transport
(always-on, no env gate), consistent with the existing axis-guide
conventions (no `verified:` date, framework fixture not real recipe).

- New guide dir under `packages/pi-lean-host/api-guides/` exercising the
  dotted-key + numeric-cursor axes end-to-end through the
  guide→parser→resolver→paginate path.
- Update the `axis-coverage.test.ts` tripwire in the same commit (guide
  count is pinned by design; the new guide adds the two axes to the kept
  union).

**Deliverable:** axis guide + tripwire update green; the axes are now
pinned against regression the same way `resumptionToken` / `tokenBag` are.

## Order & dependencies

```
Sprint 0 (research → human picks candidate)
   └─> Sprint 1 (code fix + axis-units tests)   [host]
         └─> Sprint 2 (caritas recipe, live)     [caritas]  — production proof
               └─> Sprint 3 (axis guide + tripwire) [host]   — regression pin
```

Sprint 2 before Sprint 3 is deliberate: the axis fixture is derived from
the chosen real recipe, not invented in parallel.

## Out of scope (recorded, not re-litigated)

- P0-3 (negative indexes / `hasMorePath`) — next work item, builds on
  Sprint 1's `resolveJsonPath` work but is its own doc.
- P0-2 (`secretPathRefs`) — auth surface, unrelated to this fix.
- `stopWhen: "cursorUnchanged"` (Solr equality-with-sent) — documented
  upgrade path only; the boolean `hasMorePath` case is P0-3 territory.
- Schema version bump — neither fix changes the YAML schema; both are
  behavior-level.
- Quoted dotted keys in `tokenBag` `continuationParams` — unsupported in
  v1; keys stay dot-unquoted (the last dotted segment is the wire param
  name, e.g. `"continue.rccontinue"` → `rccontinue`). No known API ships a
  dot-containing key inside a continuation bag; if research turns one up,
  the fix (quote-stripping or whole-key-as-param) is additive. A wrong
  derived name fails loudly (bogus request), not silently, so this can wait
  for a real candidate.

## Decision log

| Date | Decision |
|------|----------|
| — | Sprint 0 candidate chosen: **FROST-Server (OGC SensorThings API)** (see decision note below) |

Decision note: FROST-Server was chosen for exhibiting both shapes in one
recipe (`@iot.nextLink` dotted key + numeric `@iot.count`), LGPL-3.0
Fraunhofer research-institute OSS, live-verified against the public
no-auth instance (`airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1`)
in 2 GETs. Runners-up: **OpenFoodFacts Search API v2** (shape B — promoted
to a second Sprint-2 recipe, see above) and the odata.org TripPin reference
services (shape A, community-run but Microsoft-heritage sample stack).
Microsoft Graph / SAP ranked last per the open-source weighting; fixing
against FROST yields Graph compatibility for free since the shape is
spec-identical. MediaWiki Action API dropped — already covered by
caritas's `wikimedia-action` guide.
