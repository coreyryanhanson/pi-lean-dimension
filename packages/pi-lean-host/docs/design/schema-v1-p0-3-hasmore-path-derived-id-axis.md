# Plan — P0-3 proper: `hasMorePath` Boolean Exhaustion + the Derived-ID Axis Guide

> Status: **not started.** Seeds from
> [`schema-v1-pre-release-backlog.md`](./schema-v1-pre-release-backlog.md)
> item **P0-3** — specifically the **remaining half**. The negative-index
> (`[-N]`) lexer slice already shipped as "P0-3a" inside
> [`schema-v1-p0-1-p2-1-path-resolution.md`](./schema-v1-p0-1-p2-1-path-resolution.md)
> Sprint 1; what is left is (1) the `hasMorePath` stop-condition field and
> (2) the deferred synthetic axis work — the inaturalist derived-id axis
> guide that the path-resolution plan doc explicitly skipped ("folded into
> P0-3's own axis guide + tripwire"), plus a stripe fixture for the new
> boolean-exhaustion axis. Scope locked to those two pieces; P0-2 and the
> P1/P2 queues are out of scope.
>
> **Standing constraints (unchanged):** read-only forever (GET-only
> transport), one parser / two call sites, host-only boundary, 1 local
> helper per domain.

## Problem

Stripe-style list endpoints return `{ data: [...], has_more: bool }` with
**no cursor field anywhere in the envelope**. The documented manual loop is
"if `has_more` is true, take the last object's id and pass it as
`starting_after`" (docs.stripe.com/pagination). Today this is inexpressible:
`advancePagination` defines exhaustion exclusively as "the cursor/next/token
field is absent, empty, or unresolvable" — there is no stop-condition field.
An always-present repeating cursor (or one derived from the last item)
refetches pages until the `gatherAllMax` ceiling, surfacing a false-alarm ⚠
on a complete list; the Solr `cursorMark` variant never even has an absent
state. The `[-N]` half already shipped, so `cursorPath: "data[-1].id"`
resolves — but with no `hasMorePath`, a Stripe walk terminates only via
Stripe's own `data: []` past-the-end behavior (one wasted request) or the
ceiling.

The second problem is regression coverage debt: the derived-id numeric-cursor
axis (iNat-shaped, `results[-1].id`) is currently pinned **only** by an
inline-YAML placeholder test block in `__tests__/axis-units.test.ts`
("derived-id cursor walks, coerces, and terminates") — the mandatory interim
pinning that made the Sprint-3 skip safe. There is no synthetic axis guide
for it, so `axis-coverage.test.ts`'s kept union does not cover the axis,
and guide-level refactors could regress the shape without the tripwire
noticing. The placeholder was always labeled debt to retire once the real
fixture landed; that is Sprint 3 of this plan.

## Fix shape (from the backlog, unchanged in intent)

1. **`pagination.hasMorePath?: string`** — new optional field,
   style-agnostic, mirrors `totalCountPath` one-for-one:
   - TS: optional `hasMorePath?: string` on the pagination block
     (`core/api-guide-types.ts`).
   - Parser: added to **all six** style sets in `PAGINATION_ALLOWLISTS`
     (the allowlist↔parser tripwire in `parse-api-guide.test.ts` enforces
     this mechanically — allowlist and validation land in the same commit),
     validated as a non-empty string exactly like `totalCountPath`.
   - Executor: in the `paginate` loop, after a page's items are collected
     and **before** `advancePagination` — resolve `hasMorePath` against the
     page body; resolved-and-falsy → stop (clean stop, not a ceiling hit);
     unresolvable/absent → current semantics completely unchanged
     (empty-page / absent-cursor stop rules apply as today). The check runs
     even when the style's own cursor still resolves — that is the entire
     point (Solr-family always-present fields).
   - **No coercion.** Booleans do not coerce (the Sprint-1 decision — this
     field *is* the P0-3 territory that decision deferred to). `false`,
     `0`, and `""` all stop; `true` advances.
   - **No schema bump** — additive optional field, non-event per the bump
     rule. Target recipe (the backlog's, verbatim — exercises both shipped
     and new halves in one op):

     ```yaml
     pagination:
       style: cursor
       itemsPath: data
       cursorParam: starting_after
       cursorPath: "data[-1].id"
       hasMorePath: has_more
     ```

2. **Axis test debt + the derived-id axis guide** — see Sprint 3 below
   (which is fed by the Sprint-2 live recipe). The `[-N]` lexer semantics
   themselves need no further code work: shipped and pinned in Sprint 1 of
   the path-resolution plan.

## Axis-model question: can iNaturalist carry the whole P0-3 axis weight?

**No — and it shouldn't try.** iNaturalist's exhaustion signal is structural
(empty `results` array / absent cursor), not a boolean flag; pinning
`hasMorePath` on an iNat-shaped fixture would mean inventing an `has_more`
field iNaturalist does not send — an ungrounded fiction, exactly what the
synthetic-axis convention exists to prevent. The two P0-3 axes live on
different providers in the real world, which is the same reason the previous
Sprint 3 ended up with two guides (`frost-sensorthings` + `wikidata-search`).

The model for the `hasMorePath` half is **Stripe itself**: it is the
spec-canonical shape the whole backlog item is named after, and one Stripe
fixture op exercises *both* P0-3 halves at once (the target recipe above).
Auth is a non-issue for fixtures — the twitch twins are precedent for
fixtures "grounded in real provider facts but never fetched live," and the
auth axes are already carried by `github` (static-key) and `twitch`/`twitch-user`
(oauth2), so the Stripe fixture ships `auth.kind: none` with a prose note
(auth realism is not this fixture's job).

So: **two minimal fixtures**, mirroring the established one-axis-per-provider
pattern — `inaturalist` (derived-id, grounded in the live-verified caritas
recipe) and `stripe` (boolean exhaustion + the full target recipe).

## Sprint 1 — `hasMorePath` code + unit tests (host)

- `core/api-guide-types.ts` — optional `hasMorePath?: string` on the
  pagination block.
- `core/parse-api-guide.ts` — add to all six `PAGINATION_ALLOWLISTS` sets +
  validate like `totalCountPath`; the allowlist↔parser tripwire stays green
  in the same commit.
- `core/helpers.ts` — the page-level stop check in the `paginate` loop
  (before `advancePagination`; semantics per Fix shape 1).
- Tests: `__tests__/axis-units.test.ts` — `hasMorePath: false` stops;
  `hasMorePath: true` advances; absent → semantics unchanged (existing tests
  already pin this, they must stay green); falsy-string/`0` stop; the full
  Stripe target recipe walks and terminates on `has_more: false`.
- `docs/authoring.md` — `hasMorePath` section mirroring the `totalCountPath`
  prose: the Stripe shape, the always-present-cursor (Solr) family it
  rescues from the ceiling false-alarm, the explicit statement that
  equality-with-sent (`stopWhen`) is *not* expressible and stays a
  documented upgrade path.

**Deliverable:** green `npx vitest run packages/pi-lean-host`; no bump;
CHANGELOG folds `hasMorePath` into the existing "Recipe schema and fixed
executor" pagination sentence (unreleased — replacement over addition).

## Sprint 2 — Live proof (caritas) — recipe before fixture, per precedent

**Stripe, authenticated.** Same ordering rationale as the path-resolution
plan ("the axis fixture is derived from the chosen real recipe, not
invented in parallel"): live-verify the recipe first, then derive the
synthetic fixture from what the server actually does — not from docs.
Stripe's pagination (`has_more` + `starting_after` = last item's id) is
*literally* the P0-3 target recipe, so one caritas guide exercises the
derived-id cursor **and** `hasMorePath` against the real provider. Auth via
`secretRefs` (`Authorization: Bearer` static key) — the user provisions a
**read-only restricted key** (server-side scoped), so the read-only-forever
posture is enforced by Stripe, not just by our GET-only transport. Live
tier gated by `HOST_INTEGRATION=1` per caritas convention; pacing trivial
(Stripe's rate limits are generous at read-only volumes).

**Scope discipline:** Stripe's surface is enormous — keep the recipe to the
common list endpoints (balance transactions, charges, invoices,
subscriptions, customers), not the long tail. No-auth boolean-exhaustion
providers were not found in the earlier ~65-API research rounds; a keyed
recipe is strictly better than omitting the live tier (the github guide is
the static-key precedent). Minimal-endpoint-first convention: land one op,
live-verify the `has_more`/`starting_after` walk end-to-end, then build
out. Record the observed exhaustion facts (filtered-query `has_more`
behavior, empty-page shape) in the decision log — the Sprint-3 fixture is
derived from them.

**Deliverable:** merged, live-verified caritas guide. This is the
production proof both new halves work against the real provider.

## Sprint 3 — Synthetic axis guides + tripwire (host) — the axis debt payoff

Derived from the Sprint-2 recipe (not invented in parallel). Two new
fixture dirs under `api-guides/`, each with a co-located
mocked-transport test (always-on, no env gate), consistent with the
`frost-sensorthings` / `wikidata-search` conventions (no `verified:` date,
framework fixture, real captured payload shapes stripped leaner):

1. **`api-guides/inaturalist/`** — the derived-id axis. One op modeled on the
   live-verified caritas recipe: `via: paginate`, `style: cursor`,
   `cursorParam: id_above`, `cursorPath: "results[-1].id"`,
   `itemsPath: results`, numeric-cursor coercion (unquoted JSON integer
   cursor), empty-`results` end marker, guide-level `page`-style sibling op
   optional. Co-located `derived-id.test.ts` absorbs the placeholder's
   assertions at full strength: walk advances with coerced values,
   page-2+ non-overlap, termination on the empty final page.
2. **`api-guides/stripe/`** — the boolean-exhaustion axis. One op derived
   from the live-verified Sprint-2 recipe (captured payloads stripped
   leaner); co-located `has-more.test.ts`: `has_more: true` walks,
   `has_more: false` stops cleanly (no ⚠, no ceiling), absent field
   → unchanged semantics, plus the one-wasted-request-minus-hasMorePath
   contrast (with `hasMorePath` present, the past-the-end empty page is
   never fetched).

**Tripwire (`__tests__/axis-coverage.test.ts`, same commit):** the guide set
goes 11 → 13; the axes 13 → 15 (add **derived-id negative-index cursor**
and **boolean hasMorePath** to the kept union); pagination-style and
auth-kind invariants re-asserted.

**Placeholder removal (same commit):** delete the inline derived-id
placeholder block from `__tests__/axis-units.test.ts`. Its pinning duty
transfers to `api-guides/inaturalist/derived-id.test.ts`, which exercises a
strict superset of the same path (real guide file → parser → resolver →
paginate, versus inline hand-built YAML). Do not land the new guides without
landing the removal — two pins for one axis is the duplicate-work pattern
the original skip decision warned against.

**Deliverable:** green host suite; the derived-id and boolean-exhaustion
axes are pinned in the tripwire the same way `resumptionToken` / `tokenBag`
are. The obligation recorded in the path-resolution plan ("when P0-3 lands,
its axis guide must include the derived-id axis in the kept union") is
discharged; that plan doc can then be deleted.

## Order & dependencies

```
Sprint 1 (hasMorePath code + unit tests)   [host]
   └─> Sprint 2 (Stripe live recipe, read-only restricted key)  [caritas]
         └─> Sprint 3 (inaturalist + stripe fixtures, tripwire, placeholder removal) [host]
```

Sprint 1 first — the Stripe recipe can't parse before the allowlist lands.
Sprint 2 (recipe) before Sprint 3 (fixtures) is deliberate, per the
path-resolution plan: the axis fixture is derived from the chosen real
recipe, not invented in parallel — recipe-first grounds the fixture in
observed server behavior and avoids churn when docs and reality diverge.
The inaturalist fixture is already grounded in its live-verified caritas
recipe, so only the stripe fixture gains from the ordering, but the
tripwire pins both in one commit anyway.

## Out of scope (recorded, not re-litigated)

- `stopWhen: "cursorUnchanged"` (Solr equality-with-sent) — documented
  upgrade path only; `hasMorePath` covers the common boolean-flag case.
- P0-2 (`secretPathRefs`) — auth surface, unrelated.
- Any negative-index semantics beyond the shipped `[-N]` slice.
- Schema version bump — additive optional field; non-event per the bump
  rule.

## Decision log

| Date | Decision |
|------|----------|
| — | Axis-model question resolved up front: iNaturalist cannot carry the boolean-exhaustion axis (no boolean flag in its real payloads — pinning `hasMorePath` on it would be ungrounded); Stripe is the model for that half, per the backlog's own target recipe. Two-fixture split mirrors the frost/wikidata precedent (axes live on different providers in the real world). Stripe fixture ships `auth.kind: none` (auth axes already carried by github/twitch fixtures; grounding, not realism, is the fixture's job). |
| — | Sprint 3 upgraded from optional/research-gated to a committed Stripe recipe: the no-auth boolean-exhaustion search was the only reason it was optional, but caritas recipes are routinely authenticated (github is static-key), and Stripe's `has_more` + `starting_after` pagination is exactly the P0-3 target recipe — the live proof of both new halves in one guide. Read-only enforced by Stripe restricted-key scopes server-side; scope discipline: common list endpoints only, not the long tail. |
| — | Sprint order corrected to recipe-before-fixture (plan review): the initial draft put the synthetic fixtures before the live Stripe recipe, breaking the path-resolution plan's deliberate "fixture derived from the chosen real recipe, not invented in parallel" ordering. Recipe-first grounds the stripe fixture in observed exhaustion facts (filtered-query `has_more` behavior, empty-page shape) with zero churn; the inat fixture is already recipe-grounded, and the tripwire pins both in one commit regardless. Only hard ordering: Sprint 1 before the recipe (parser allowlist). |
