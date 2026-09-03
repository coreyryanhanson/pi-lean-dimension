# Plan — P0-1 + P2-1: Dotted JSON Keys, Numeric Cursor Coercion & `[-N]` Negative Indexes

> Status: **Sprint 1 + 1b shipped** (atomic quoted-bracket tokenizer, numeric-cursor
> coercion, and the `[-N]` negative-index lexer slice live in `core/helpers.ts`,
> pinned by `helpers.test.ts` / `axis-units.test.ts`). Sprint 2 is in progress:
> minimal one-op guides for FROST-Server, OpenFoodFacts, and iNaturalist are
> live-verified on caritas; the full guides are pending. Sprint 3 (synthetic
> axis guide for the Sprint-1 axes) is pending; the iNaturalist synthetic axis
> guide is **skipped by design** (folded into P0-3's own axis guide + tripwire).
> Seeds from
> [`schema-v1-pre-release-backlog.md`](./schema-v1-pre-release-backlog.md)
> items **P0-1**, **P2-1**, and **P0-3** (negative-index half only — the
> boolean/`hasMorePath` half stays with the full P0-3 work item and is out of
> scope here). P0-1 and P2-1 were paired in the backlog by design (same
> function, same test file); P0-3a rides the same machinery.
> Scope is locked to those items — P0-2 and the P1/P2 queues are out of scope
> here.
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

**P0-3a — negative indexes.** `tokenizeJsonPath` (`core/helpers.ts`) accepts
only non-negative numeric indexes in unquoted brackets; `results[-1].id` →
malformed → `undefined` → silent miss. This makes the **derived-id cursor
family** inexpressible: APIs whose continuation value is the *last item's*
numeric id/timestamp fed back as a query param. Two research rounds
(~65 APIs live-probed) established this is **the dominant live
numeric-cursor shape** — iNaturalist (`results[-1].id` → `id_above`),
Coinbase Exchange (`trade_id` → `after`), OpenDota (`match_id` →
`less_than_match_id`), ListenBrainz (`listened_at` → `max_ts`), Tumblr v2
(timestamps → `before`/`after`) — while the *dedicated-field* numeric shape
(`{"next_cursor": N}`) is nearly extinct behind auth (legacy Twitter) or
rate-limit walls (Semantic Scholar). The lexer already dot-splits and
indexes; `[-N]` is a bounded extension of exactly the machinery Sprint 1
touched, not a new surface.

**P2-1 live-proof half.** The numeric-coercion fix is unit-proven
(`axis-units.test.ts`) but had **no live recipe for the cursor-branch
coercion**: the canonical dedicated-field candidate (Semantic Scholar
`next` → `offset`) is blocked by a delayed key provisioning and a
hard-429 unauthenticated tier, and every other dedicated-numeric API found
is keyed or dead (TikTok POST+key, Vercel Bearer, Twitter OAuth). The
derived-id family is the proof that's actually available no-auth — and it
exercises the same coercion code path (the cursor branch treats the
resolved value as opaque; field provenance is invisible to
`advancePagination`). The iNaturalist Sprint-2 recipe is that proof.

**Why not a `helper.ts` interim:** the pre-call helper contract is
`(params, ctx) => params` — it never sees a response, so it cannot derive
`id_above` from page 1's last item. Post-response `transform` shapes output
items only; `advancePagination` reads the raw body. There is no hook outside
`core/helpers.ts` in the pagination loop. A static-index workaround
(`results[199].id` with page size pinned at 200) silently truncates on any
short-but-nonempty page — the exact failure class this work stream exists
to kill. Both rejected; the `[-N]` slice is the honest expression.

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
   numeric-index rewrite). A `(.*?)`-style tokenizer cannot match `]` or a
   quote character *inside* a quoted segment — document this as a
   path-syntax limit rather than handling it in code. Note the `['a]b']`
   case is a behavior *change*, not an impossible path: the current regex
   accidentally resolves it today (content `a]b` matches, yielding
   `obj["a]b"]`), and it becomes a miss under the fix — acceptable for a
   pathological key, but the authoring docs must say "accidentally resolves
   today, no longer under the atomic tokenizer" rather than "cannot match". Unquoted legacy paths parse identically. Unquoted `@odata.nextLink` keeps failing exactly as today
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
3. **P0-3a (behavior, no bump):** the unquoted-bracket branch of
   `tokenizeJsonPath` accepts an optional leading `-` before the digits
   (`[-1]`, `[-3]`); a leading `-` whose digit string is all zeros
   (`[-0]`, `[-00]`) is explicitly rejected → malformed (without this
   guard, `parseInt("-0")` is `-0` and the natural `if (idx < 0)` guard
   never fires — `-0 < 0` is `false` in JS — so `current[-0]` would
   silently match element 0, violating the miss-never-wrong guarantee);
   a bare `[-]` or `[-x]` stays malformed. `resolveJsonPath`: on an array,
   a negative index resolves `idx += length`; out-of-bounds negative
   (`[-1]` on an empty array, `[-5]` on a 2-element array) → `undefined` —
   **miss, never a wrong match**, consistent with the Sprint-1 guarantee.
   Note: `[-1]` on a non-empty final page always exists, so a gathered
   walk self-terminates correctly on the partial page. Additive lexer
   acceptance — nothing that parsed before changes (no schema bump).

## Sprint 1 — Code fix + unit tests (host)

All three fixes land as **one work item** (same function territory, same
test file), before any guide work — no recipe should be written against the
broken behavior.

1. `core/helpers.ts` — `resolveJsonPath`: atomic quoted-bracket segments.
2. `core/helpers.ts` — `advancePagination`: numeric → string coercion
   (`typeof === "number"` only), `tokenBag`-style, in the `cursor` and
   `resumptionToken` branches; `nextLink` stays string-strict. Same
   commit, one line: quote-strip the `tokenBag` param-name derivation
   (`key.split(".").pop()` at `core/helpers.ts:983`). After the P0-1 fix a
   quoted `continuationParams` key like `['continue.rccontinue']`
   resolves (today it misses → skipped); without stripping, the derived
   wire param is the junk `rccontinue']`. The strip must run
   **unconditionally** — before any dot check — because the existing
   derivation only strips when `key.includes(".")`, and a quoted
   non-dotted key like `['next']` would then produce the junk wire param
   `['next']` (post-P0-1 that key resolves; note it already resolves
   today — the regex rewrite turns it into `.next` — and the derivation
   at :983 already produces the junk wire param `['next']` pre-fix, so
   the strip corrects an existing wart as well as a post-fix one). Stripping keeps quoted bag keys doing the sane thing
   without full quoted-key bag support.
   Alternative considered: rejecting `['` in `continuationParams` at
   parse time — rejected as a new parse error for something the strip
   handles correctly in one line.
3. `core/helpers.ts` — `tokenizeJsonPath`: the `[-N]` lexer slice (see fix
   shape item 3).
4. Tests, split by subject:
   - **Resolver unit cases** in the existing `describe("resolveJsonPath")`
     block in `__tests__/helpers.test.ts` (alongside their siblings — pure
     path resolution, no paginate machinery):
     - `['@odata.nextLink']` resolves (dotted key, quoted).
     - Unquoted `@odata.nextLink` misses (no silent *wrong* match).
     - Unquoted legacy paths parse identically (regression).
     - Double-quoted segment resolves: `["@odata.nextLink"]` (quote-style
       parity — the legacy regex accepted both).
     - Mixed bracket index + quoted segment: `data[0]['key.name']`.
     - `items[-1]` resolves the last element; `[-1]` on an empty array
       misses; out-of-bounds negative misses; `[-0]` is malformed;
       `[-1].id` composes with quoted-bracket and numeric-index siblings.
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
     - A cursor-style op with `cursorPath: "results[-1].id"`,
       `cursorParam: id_above`, numeric ids in the body walks past page 1,
       coerces the number to the wire param, and terminates on the empty
       page (iNat-shaped inline YAML). **This test is the always-on
       pinning that Sprint 3b would have provided** — see the skip
       decision under Sprint 3.
5. Authoring docs: document the `['…']` / `["…"]` escape-hatch so caritas recipes
   are written correctly the first time (backlog P0-1's own fix line —
   one paragraph where path syntax is documented). Include the two syntax
   limits from the review in one paragraph: quoted segments may not contain
   `]` **or quote characters** (either ends the `(.*?)` capture), and
   unquoted dot-keys keep failing silently (miss ≠ wrong match). State the
   `['a]b']` case accurately: it accidentally resolves today via the legacy
   regex and becomes a miss under the atomic tokenizer. Add one sentence on
   negative indexes: they address from the end (`results[-1].id` = last
   item's `id`), out-of-bounds is a clean miss (pagination terminates),
   `[-0]` is malformed. Also note the numeric-`0` caveat from P2-1: an API that uses
   `0` as an *end marker* (legacy Twitter-style `next_cursor: 0`) now
   walks to the `gatherAllMax` ceiling and surfaces the
   `⚠ Ceiling reached` warning for a *complete* list — recipes against
   such APIs should not use `cursorPath` for the end-marker field, or
   should treat the ceiling signal as normal completion.

**Deliverable:** green `npx vitest run packages/pi-lean-host` with the new
cases; no schema bump, no guide-format change.

## Sprint 2 — Comprehensive caritas recipes

Three guides, not one — multiple recipes of different shapes reinforce that
the generalization works rather than fitting one provider. Convention:
minimal-endpoint-first (land one op, live-verify, then build out the full
guide).

1. **FROST-Server (OGC SensorThings API)** — the chosen primary candidate. Guide
   exercises the dotted-key / numeric-count shape end-to-end via the
   Sprint-1 fix: `pagination` block using quoted-bracket paths (e.g.
   `nextLinkPath: "['@iot.nextLink']"`), plus
   `totalCountPath: "['@iot.count']"`. Live-verify the paginate loop
   actually walks past page 1 and terminates correctly (the exact behavior
   that was silently broken). Minimal endpoint live-verified on caritas.
2. **OpenFoodFacts Search API v2** — the second recipe, shape B only
   (numeric `page` echoed in the body, fed back as `?page=N`; AGPL-3.0,
   community-run non-profit, no auth). Proves the numeric-cursor coercion
   fix against a second, structurally different provider. Minimal endpoint
   live-verified on caritas.
3. **iNaturalist** (`api-guides/inaturalist/` — folder = `slug("iNaturalist")`,
   one word; the slug lowercases but does not split camelCase) — the
   derived-id cursor recipe and the P2-1 cursor-branch live proof. One op
   so far: `listObservations` — `via: paginate`, `style: cursor`,
   `cursorParam: id_above`, `cursorPath: "results[-1].id"`,
   `itemsPath: results`, `totalCountPath: total_results`,
   `auth.kind: none`, `pageSize: 30`. Params: `per_page` (≤200 documented),
   plus `order_by: id` + `order: asc` as **declared op defaults** (see
   decision log), `q`/`taxon_name`/`place_id` filters. Guide prose
   documents: the derived-id cursor shape (cursor = last item's id, the
   dominant live numeric-cursor pattern), the `[-1]` path syntax, the
   empty-`results` end marker, and the payload-weight warning (observations
   embed full taxon/user objects — keep pages small). Live-verified on
   caritas: first page + numeric `serverTotal`; **page-2 echo** (cursor
   value is an unquoted JSON integer ~3.9×10⁸, `id_above` walk verified
   non-overlapping); gatherAll walk (`gatherAllMax`-bounded, terminates on
   empty `results`); pacing per the community etiquette. All shapes
   re-verified by the author (research-lane probes are evidence, not
   proof).

**Remaining Sprint 2 work:** build out the full guide for each of the three
domains — remaining endpoints per provider, co-located `endpoint-coverage`
tests per the caritas conventions (parse assertions always-on, live tier
under `HOST_INTEGRATION=1`, pacing per community etiquette).

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
- **iNaturalist synthetic axis guide: SKIPPED (folded into P0-3).** P0-3
  proper (booleans/`hasMorePath` + any remaining negative semantics) lands
  soon and without an intervening version release; it will add its own axis
  guide + tripwire update covering the full P0-3 surface in one commit.
  Writing the tripwire twice — once for the `[-1]` slice, again for P0-3 —
  is duplicate work against an unpinned interim state. The interim gap
  (nothing always-on proves the guide-driven derived-id cursor shape) is
  closed by the Sprint 1 axis-units paginate-level mocked test, which
  exercises itemsPath + `results[-1].id` + numeric coercion through the
  guide→parser→resolver→paginate path without a browser or network.
  **This skip is only safe with that test in place** — it is not optional.
  When P0-3 lands, its axis guide must include the derived-id
  numeric-cursor axis (iNat-shaped fixture) in the kept union.

**Deliverable:** axis guide + tripwire update green; the Sprint-1 axes are
now pinned against regression the same way `resumptionToken` / `tokenBag`
are. The derived-id axis is deliberately deferred to P0-3's deliverables.

## Order & dependencies

```
Sprint 1 (code fix + axis-units tests)   [host]
   └─> Sprint 2 (caritas recipes, live)    [caritas]  — production proof
         └─> Sprint 3 (axis guide + tripwire) [host]   — regression pin
```

Sprint 2 before Sprint 3 is deliberate: the axis fixture is derived from
the chosen real recipe, not invented in parallel. The `[-N]` lexer slice
before the iNat recipe was load-bearing: the recipe's `cursorPath` is
malformed without the slice, which would have shipped the
silent-page-1-stop bug into the library.

## Out of scope (recorded, not re-litigated)

- P0-3's boolean/`hasMorePath` half and any other negative-index semantics
  beyond `[-N]` array addressing — the full P0-3 work item (which also owns
  the deferred axis guide + tripwire update for the derived-id axis).
- P0-2 (`secretPathRefs`) — auth surface, unrelated to this fix.
- `stopWhen: "cursorUnchanged"` (Solr equality-with-sent) — documented
  upgrade path only; the boolean `hasMorePath` case is P0-3 territory.
- Weasyl — the only live-proven *dedicated-field* no-auth numeric
  continuation (`nextid` → `nextid`, verified page-2 echo and `null` end
  marker); rejected for the library on community optics. Recorded as the
  escape hatch if a dedicated-field proof is ever needed.
- Semantic Scholar — canonical `next`-offset shape; blocked by delayed key
  provisioning and a 429-flaky unauth tier. Optional future second recipe
  (dedicated-field shape) if a key materializes; no longer a dependency —
  the iNat recipe proves the same coercion path.
- Tumblr — timestamp walk is derived-id (docs-attested only; demo key
  401s); candidate for a future keyed recipe exercising
  `secretQueryRefs`. int64 post ids carry JS-precision risk; the
  timestamp walk avoids it but the verification cost stands.
- Coinbase Exchange / OpenDota / ListenBrainz — live-verified derived-id
  siblings; interchangeable alternates if iNat ever drifts. OpenDota's
  `match_id` (~7.5×10⁹, int32-overflow) is the best coercion stressor.
- Schema version bump — neither fix changes the YAML schema; both are
  behavior-level. `[-N]` accepts paths that were previously malformed (a
  parse-relaxing addition); no guide that parsed before fails now.
  Non-event per the bump rule.
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
| — | Post-review findings folded in (review verdict: sound-with-issues, merge OK): (1) tokenBag quote-strip runs unconditionally, before the `key.includes(".")` gate — quoted non-dotted keys like `['next']` would otherwise wire a junk param post-P0-1; (2) authoring docs record the numeric-`0`-end-marker caveat (legacy Twitter `next_cursor: 0` walks to the `gatherAllMax` ceiling with a false-alarm ⚠ on a complete list); (3) authoring docs record the tokenizer limit — quoted segments cannot contain `]` or quotes |
| — | Second review pass (verdict: sound, no blockers) folded in as two nitpicks: (1) the `['a]b']` tokenizer limit is a behavior *change*, not an impossible path — it accidentally resolves today via the legacy regex and becomes a miss under the fix; authoring docs must state it that way; (2) the tokenizer limits paragraph names both constraints — quoted segments may not contain `]` **or quote characters** (either ends the `(.*?)` capture) — and the `['a]b']` case is stated accurately there |
| — | Sprint 1b (second research round, ~65 APIs live-probed across mainstream/scholarly-gov/long-tail lanes plus an exact-shape sweep) completed: dedicated-field numeric cursors are all keyed/blocked in the live no-auth world; derived-id is the dominant live shape. iNaturalist chosen over Coinbase/OpenDota/ListenBrainz on end-marker cleanliness (empty `results`, not a `0` sentinel), zero auth, `total_results` as a free `totalCountPath`, and optics; Weasyl (exact-shape fit) rejected on community optics; Semantic Scholar demoted to optional future recipe (key delay + unauth 429 flake). `helper.ts` bridging rejected (pre-call contract cannot see responses — verified against `core/helpers.ts`); static-index workaround rejected (silently truncates on short-but-nonempty pages — reintroduces the failure class under fix). Negative indexes scoped to the `[-N]` array slice only; `hasMorePath`/booleans stay with P0-3 proper. `[-0]` malformed; out-of-bounds negative = miss, never wrong. Sprint 3's derived-id axis guide skipped by design (folded into P0-3's deliverables); Sprint 1's axis-units mocked test (iNat shape, inline YAML) is the mandatory interim pinning that makes the skip safe. |
| — | Sprint 2 live verification (2026-09-03) corrected two research-lane findings before the iNat recipe shipped: (1) **`order: desc` + `id_above` double-counts** — "id above the cursor" is the newest-rows region, which is where page 1 lives; the stable `results[-1].id` walk needs **`order_by: id` + `order: asc` + `id_above`** (declared op defaults, so they serialize on every page — undeclared sort params are silently dropped by the executor and the walk degenerates into a moving newest-items feed); (2) the sparse-fieldset params (`fields`, `only_id`) are **not honored** on `/v1/observations` (live-probed, full payloads regardless) — the payload-weight mitigation is page size only, so the recipe pins `pageSize: 30`. The sort-declaration rule was added to `docs/authoring.md` as a general rule for sorted keyset walks, and the `api-learn` placeholder skeleton gained a commented hint for authoring agents. |
| — | Sprint 2b doc (`schema-v1-p0-3a-neg-index-p2-1-derived-cursor.md`) folded into this doc: P0-3a's lexer slice ships as part of Sprint 1, the iNaturalist recipe joins Sprint 2 as recipe 3, and the derived-id synthetic axis guide stays skipped (P0-3 owns it). Standalone doc removed. |

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
caritas's `wikimedia-action` guide. The second research round
(derived-id lane) selected **iNaturalist** from the live-verified
derived-id set (Coinbase Exchange, OpenDota, ListenBrainz as interchangeable
alternates if iNat ever drifts; OpenDota's ~7.5×10⁹ `match_id` is the best
coercion stressor). Verified non-fits, do not re-investigate: FEC
(19-digit **string** `last_index`), HN Algolia (client-side page), College
Scorecard / openFDA (echo the caller's page/skip, not a next-value),
crates.io (base64 seek string), Quay.io (Fernet string), npm `_changes`
(numeric `last_seq` → `since` but a stream, no end marker), all OAI-PMH
(string tokens), OpenAlex/Crossref/Europe PMC/Slack (string cursors),
RAWG/INSPIRE-HEP/ScienceBase (URL nexts), Tumblr v2 (timestamp walk is
derived-id, docs-attested only — demo key 401s; candidate for a future
keyed recipe exercising `secretQueryRefs`).
