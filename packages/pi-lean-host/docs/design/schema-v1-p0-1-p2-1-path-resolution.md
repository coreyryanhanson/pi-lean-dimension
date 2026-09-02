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
(OAI-PMH's final `<resumptionToken/>` is *not* this bug: it's already
expressible today via `tokenPath: "resumptionToken.#text"`, per the
backlog's P2-10 verified-fine list. A bare empty element parses as `""`
and an attribute-only element as an object — neither is a number, so the
planned `typeof === "number"`-only coercion leaves both terminating
cleanly. Out of scope here.)

Both fix variants of the same worst-case failure mode: *silently truncated,
reported as complete*.

## Fix shape (from the backlog, unchanged)

1. **P0-1 (behavior, no YAML change, no bump):** quoted bracket segments
   become atomic keys in `resolveJsonPath` — capture `['…']` segments
   (dots included) *before* dot-splitting. The current regex accepts both
   quote styles (`['…']` and `["…"]`) — the tokenizer must preserve both.
   Tokenize in a single pass so
   quoted content is never exposed to the subsequent rewrites (a quoted
   segment like `['a[3]']` must not have its `[3]` mangled by the
   numeric-index rewrite). Unquoted legacy paths parse identically. Unquoted `@odata.nextLink` keeps failing exactly as today
   — silently (undefined → null → single page, reported complete). The
   guarantee is *no silent **wrong** match*, not loud failure; do not
   "improve" this into a warning later thinking it was already loud.
2. **P2-1 (behavior, no bump):** coerce numbers to strings in
   `advancePagination` exactly like `tokenBag` — but **only** where a
   numeric continuation is meaningful: `typeof === "number"` in the
   `cursor` and `resumptionToken` branches. The coercion must happen
   **before** each branch's type/falsy check — in the `cursor` branch
   before `!next || typeof next !== "string"` (otherwise a numeric `0`
   cursor dies at `!next` and still terminates — inconsistent with string
   `"0"`, which advances today), and in the `resumptionToken` branch
   before its `typeof t !== "string" || t === ""` check (that branch has
   no `!next` guard — do not invent one). The `nextLink`
   branch stays string-strict (a numeric "next URL" is garbage — stop,
   don't send a bogus request), and booleans/objects do not coerce
   (boolean continuation values are P0-3 `hasMorePath` territory). Keep
   `""`/missing as exhaustion. (Constant cursors can't loop forever
   either way — the `gatherAllMax` ceiling bounds the walk.)

## Sprint 1 — Code fix + unit tests (host)

Both fixes land as **one work item** (same function territory, same test
file), before any guide work — no recipe should be written against the
broken behavior.

1. `core/helpers.ts` — `resolveJsonPath`: atomic quoted-bracket segments.
2. `core/helpers.ts` — `advancePagination`: numeric → string coercion
   (`typeof === "number"` only), `tokenBag`-style, in the `cursor` and
   `resumptionToken` branches; `nextLink` stays string-strict. Same
   commit, one line: quote-strip the `tokenBag` param-name derivation
   (`key.split(".").pop()` at `core/helpers.ts:983`). After the P0-1 fix a
   quoted `continuationParams` key like `['continue.rccontinue']`
   resolves (today it misses → skipped); without stripping, the derived
   wire param is the junk `rccontinue']`. Stripping keeps quoted bag keys
   doing the sane thing without full quoted-key bag support.
   Alternative considered: rejecting `['` in `continuationParams` at
   parse time — rejected as a new parse error for something the strip
   handles correctly in one line.
3. Tests, split by subject:
   - **Resolver unit cases** in the existing `describe("resolveJsonPath")`
     block in `__tests__/helpers.test.ts` (alongside their siblings — pure
     path resolution, no paginate machinery):
     - `['@odata.nextLink']` resolves (dotted key, quoted).
     - Unquoted `@odata.nextLink` misses (no silent *wrong* match).
     - Unquoted legacy paths parse identically (regression).
     - Double-quoted segment resolves: `["@odata.nextLink"]` (quote-style
       parity — the legacy regex accepted both).
     - Mixed bracket index + quoted segment: `data[0]['key.name']`.
   - **Paginate-level cases** in `__tests__/axis-units.test.ts` (the file
     the backlog names — mocked transport, inline YAML):
     - Quoted `nextLinkPath: "['@odata.nextLink']"` walks past page 1.
     - Numeric cursors advance (cursor + resumptionToken branches); numeric
       nextLink still terminates; `""`/missing still terminate; numeric `0`
       cursor advances (coercion precedes each branch's type/falsy check).
     - A *constant* numeric cursor terminates via the `gatherAllMax`
       ceiling (`ceilingHit`) — the safety net the coercion leans on;
       one assertion, cheap.
     - `totalCountPath: "['@odata.count']"` resolving to a numeric
       `serverTotal` (OData exposes totals via the same dotted-key family).
4. Authoring docs: document the `['…']` / `["…"]` escape-hatch so caritas recipes
   are written correctly the first time (backlog P0-1's own fix line —
   one paragraph where path syntax is documented).

**Deliverable:** green `npx vitest run packages/pi-lean-host` with the new
cases; no schema bump, no guide-format change.

## Sprint 2 — Comprehensive caritas recipes

Two guides, not one — multiple recipes of different shapes reinforce that
the generalization works rather than fitting one provider:

1. **FROST-Server (OGC SensorThings API)** — the chosen primary candidate. Guide
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
Sprint 1 (code fix + axis-units tests)   [host]
   └─> Sprint 2 (caritas recipes, live)    [caritas]  — production proof
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
- Quoted dotted keys in `tokenBag` `continuationParams` — full support
  (e.g. whole-key-as-param semantics) stays out of v1; the junk-param
  hazard for quoted bag keys is closed by the Sprint-1 quote-strip of the
  param-name derivation (step 2). Keys stay dot-unquoted (the last dotted
  segment is the wire param name, e.g. `"continue.rccontinue"` →
  `rccontinue`). No known API ships a dot-containing key inside a
  continuation bag; if research turns one up, the upgrade is additive.

## Decision log

| Date | Decision |
|------|----------|
| — | Sprint 0 (candidate research) completed and removed from this doc; choice recorded in the decision note below |
| — | Plan review folded in: preserve `["…"]` double-quote parity in the tokenizer; coerce before each branch's type/falsy check (resumptionToken has no `!next` guard — don't invent one); quote-strip the `tokenBag` param derivation in Sprint 1 over parse-time rejection; add double-quoted + constant-numeric-cursor-`gatherAllMax` tests |

Decision note (Sprint 0 outcome, kept for provenance): FROST-Server was
chosen for exhibiting both shapes in one
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
