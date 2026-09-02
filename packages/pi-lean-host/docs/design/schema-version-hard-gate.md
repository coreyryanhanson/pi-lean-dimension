# Schema Version Hard Gate — Plan

> Flip `schemaVersion` staleness from a **non-blocking `⚠` warning** to a
> **hard parse refusal**: a guide whose `schemaVersion` is `< current` fails
> to parse and routes to malformed. This is the "fail loudly" policy — we do
> not keep deprecated reading code to support old-schema guides.
>
> This is a plan doc, not a spec. It names the seams to touch, the decision
> points, and the test-fixture ripple. It is the **deferred half** of the
> coordinated `0.5.0` schema bump that Phase 1 already shipped (the
> `AuthConfig` union refactor + `GUIDE_SCHEMA_VERSION` `0` → `1` + nested
> `SecretRef` reshape). The gate was deferred by decision so it could land
> alongside the caritas re-stamp; this doc is the implementation plan for
> that flip.
>
> **Sequencing.** The gate itself is host-only and self-contained; the
> caritas re-stamp is a companion PR in the caritas repo (host cannot do it —
> see the coordination section). The original "after the bluesky follow-up"
> sequencing note is historical — all pre-gate work (Phase 1, api-store, the
> twitch/twitch-user axis guides) has landed.

## Current state (the seams already in place)

The warning path is live today, and the gate is a one-line flip plus a
fixture ripple:

- **`isStaleSchema`** (`core/parse-api-guide.ts:1963`) is a pure predicate:
  `guideSchemaVersion < currentSchemaVersion`. Used by the (future) gate and
  by every warning render site today.
- **`staleSchemaLine`** (`core/parse-api-guide.ts:1976`) renders the
  `⚠ schemaVersion X < current Y` line. Callers: `api-fetch.ts:285,325`,
  `api-guide.ts:179`, `formatGuideListings` (`:2025`), `formatApiGuideCatalog`
  (`:2150`).
- **`formatApiGuideCatalog`** (`:2103`) also appends a `⚠` glyph to an org
  row when any guide in it is stale; **`guide-picker.ts:43`** appends a `⚠`
  to a guide's picker label when stale.
- **`parseApiGuide`** computes `schemaVersion` with the floor default:
  absent → `0`, malformed (non-integer/negative) → `0`, "never rejects a
  guide". `GUIDE_SCHEMA_VERSION` is already `1` (Phase 1).
- **`api-learn` validates before it stamps** (`tools/api-learn.ts:555`
  `parseApiGuide(recipe)` runs, then `:883` `stampFrontmatterField(recipe,
  "schemaVersion", …)`). Under a gate, a recipe without a current
  `schemaVersion` fails validation *before* the stamp — see the api-learn
  decision below.
- **`api-learn`'s placeholder skeleton** (`placeholderSkeleton`) carries no
  `schemaVersion` line (it fails closed on `apiHost: <base url>` today, so
  the missing line is invisible until the gate lands).
- **`api-scaffold`** writes `verify.json` + `helper.ts`, **never `guide.md`**
  — unaffected.
- **The synthetic axis guides** (`api-guides/`) are already re-stamped to
  `schemaVersion: 1` (Phase 1), so they stay green under the gate. The
  github guide's auth block is already the nested shape.
- **`schema-version.test.ts`** is the "never a gate" proof — its assertions
  invert under the flip (see the test plan).

## The flip (the core change)

In `parseApiGuide`, after `schemaVersion` is computed (floor default applied),
add the hard refusal:

```ts
if (isStaleSchema(schemaVersion, GUIDE_SCHEMA_VERSION)) {
  return fail(file, "schemaVersion", `>= ${GUIDE_SCHEMA_VERSION} (current)`,
    String(schemaVersion), {
      fix: `This guide was authored against schema ${schemaVersion}; the current schema is ${GUIDE_SCHEMA_VERSION}. Re-stamp the frontmatter to schemaVersion: ${GUIDE_SCHEMA_VERSION}, or re-author via api-learn.`,
    });
}
```

Consequences, deliberately:

- **Absent `schemaVersion` fails** (absent → floor `0` → stale). Every guide
  must carry its vintage. This is the "fail loudly" intent — an unversioned
  guide is treated as pre-v1.
- **Malformed values fail** (malformed → floor `0` → stale). The old
  "malformed falls back to 0, never a gate" contract is gone. The `fix` above
  is slightly generic for a malformed value ("authored against schema 0")
  — acceptable; the message names the field and the current version, which
  is what an author needs. (Optional refinement: detect malformed separately
  and emit a distinct `fix` — decide during implementation, not required.)
- **Forward-stamped guides (`schemaVersion: 999`) still parse** —
  `isStaleSchema(999, 1)` is false. A guide authored against a *newer* schema
  is not stale.
- **Stale guides route to malformed** via the existing
  `loadApiGuidesFromDir` → `pushMalformed` path, so the `⚠ malformed`
  catalog line + per-guide error already surface them with the `fix`.

## Decision points

### D1 — Remove the stale-warning render paths (recommended) vs keep as dead code

Once the gate is in, no *parsed* guide can be stale, so every `⚠` render site
is dead code. The "fail loudly" policy argues for removing them:

- `staleSchemaLine` — delete (no callers left).
- `formatGuideListings` / `formatApiGuideCatalog` — drop the `staleSchemaLine`
  call and the org-row `⚠` glyph.
- `guide-picker.ts` — drop the `⚠` label on `buildGuidePickerItems`.
- `api-fetch.ts` / `api-guide.ts` — drop the `staleNote` append.

Keep `isStaleSchema` (the gate predicate + the pure truth-table test).

**Recommendation: remove.** It is the honest reading of "we do not keep
deprecated reading code." The alternative (keep the renders) leaves
unreachable branches that a future reader will assume are live. The removal
is mechanical; the `current` params on the format functions become unused and
should be dropped with them. (They are **optional with defaults**
(`current = GUIDE_SCHEMA_VERSION`) and no call site passes them today, so
dropping them is zero-caller-edit — see the touch list.)

### D2 — api-learn: stamp-before-validate (recommended) vs skeleton line only

Under the gate, `api-learn`'s validate-then-stamp order breaks the authoring
loop: a hand-written recipe without a current `schemaVersion` fails
validation at `:555` before the stamp at `:883`.

**Recommendation: stamp before validate.** Move the
`stampFrontmatterField(recipe, "schemaVersion", …)` call ahead of
`parseApiGuide(recipe, …)` and parse the stamped string. This is safe
(stamp is a line-level text edit; the write still only happens on
validation success) and consistent with the existing save behavior
(api-learn already re-stamps every saved guide to current). It also means a
recipe carrying an old `schemaVersion: 0` is *upgraded on save* — the
authoring tool is the upgrade path; the hard gate governs the *loader*, not
the writer.

**Plus** add `schemaVersion: 1` to the placeholder skeleton so a fresh
template starts current (belt-and-suspenders; the stamp-before-validate
change alone covers it, but a visible line in the skeleton is the honest
teaching).

### D3 — Keep the floor default, let the gate catch it (recommended)

Do not add a special "malformed" branch — absent/malformed both fall to the
floor `0` and the gate rejects. One code path, one message. (The optional
malformed-specific `fix` from the flip section is the only refinement on the
table.)

## Touch list (exhaustive — verify against the codebase before starting)

### Core

| File | Change |
|------|--------|
| `core/api-guide-types.ts` | Update the `GUIDE_SCHEMA_VERSION` + `ApiGuide.schemaVersion` doc comments ("NEVER gates" → "hard gate"). |
| `core/parse-api-guide.ts` | Add the gate after `schemaVersion` computation; update the `schemaVersion` parsing comment block ("never rejects a guide" → "rejects when stale"); per D1, delete `staleSchemaLine` + the `⚠` renders in `formatGuideListings`/`formatApiGuideCatalog` (and drop their `current` params). |
| `core/guide-picker.ts` | Per D1, drop the `⚠` label (and the `isStaleSchema` import if unused). |
| `core/guide-store.ts` | If the format functions' `current` params are dropped, update the `formatApiGuideCatalog` call site. |

### Tools

| File | Change |
|------|--------|
| `tools/api-learn.ts` | Per D2, stamp-before-validate (move the `stampFrontmatterField` call ahead of `parseApiGuide`); add `schemaVersion: 1` to the skeleton. |
| `tools/api-fetch.ts` | Per D1, drop the `staleSchemaLine` note + import. |
| `tools/api-guide.ts` | Per D1, drop the `staleSchemaLine` note + import. |
| `tools/api-scaffold.ts` | No change expected (writes `verify.json`/`helper.ts`, not `guide.md`) — verify only. |

### Commands (call sites of the format functions)

No edits needed — the `current` params are optional-with-default and no call
site passes them today (`delete-command`, `verify-command`, `oauth-command`,
`api-learn`, `api-fetch`, `api-guide`, `api-scaffold` all call
`formatGuideListings` bare; `guide-store` calls `formatApiGuideCatalog`
bare). Dropping the params is definition-site only.

### Tests

- **`__tests__/schema-version.test.ts`** — the biggest rewrite. The
  "never a gate" assertions invert:
  - "defaults absent schemaVersion to 0" → "absent schemaVersion fails to
    parse" (with the gate's `fix` naming `schemaVersion: 1`).
  - "a malformed schemaVersion falls back to 0, never a parse gate" →
    "malformed schemaVersion fails to parse".
  - "never gates load — a stale guide still parses and runs" → "a stale
    guide fails to parse" (assert `result.ok === false`, `error.field ===
    "schemaVersion"`).
  - "keeps an explicit valid schemaVersion" / "a forward value (999)
    parses" — stay (current + forward both parse).
  - The detection-surfaces describe (`staleSchemaLine` renders,
    `formatGuideListings` flags, catalog ⚠) — per D1, delete with the render
    paths. `isStaleSchema` truth-table stays.
  - The `SCHEMA_VERSIONED` fixture (`schemaVersion: 0`) becomes the *stale*
    fixture; add a `schemaVersion: 1` twin for the current case. `MINIMAL`
    gains `schemaVersion: 1`.
- **Every other recipe-building test file** — any recipe passed to
  `parseApiGuide` or written as `guide.md` without `schemaVersion: 1` now
  fails to parse. Strategy: add the line to the shared recipe-builder
  helpers first (one edit per file covers most recipes), then sweep the
  standalone inline recipes. Known files (verify by grepping `parseApiGuide(`
  and `guide.md` writes across `__tests__/`): `parse-api-guide`, `auth`,
  `helpers`, `query-secrets`, `tools`, `verify-command`, `secrets-command`,
  `api-probe`, `api-learn-fetch-recipe`, `api-scaffold`, `transform-*`,
  `axis-units`, `status-hint`, `render-result`, `response-spill`,
  `delete-command`, `guide-picker`, `local-helpers`, `portal-projection`,
  `smoke`, `api-toggle`, `verify-stamp`, `secrets-store`, `transport` (post-doc
  landings also covered by the same sweep: `api-learn-multi-file`,
  `api-store`, `ship-manifest`).
- **`__tests__/all-guides-parse.test.ts`** — already green (synthetic guides
  are stamped `1`); no change expected, verify only.
- **`__tests__/axis-coverage.test.ts`** — reads the synthetic guides
  (current); no change expected, verify only.

## Phased plan

### Phase A — Core gate + docs comments

- `core/parse-api-guide.ts`: add the `isStaleSchema` refusal after
  `schemaVersion` computation; update the parsing comment block.
- `core/api-guide-types.ts`: update the two doc comments.
- Run the host suite — expect the fixture ripple (Phase C) to be the only
  failures.

### Phase B — api-learn authoring loop

- `tools/api-learn.ts`: stamp-before-validate; add `schemaVersion: 1` to the
  skeleton.
- This unblocks the authoring path so Phase C's fixture work doesn't fight
  the save path.

### Phase C — Test-fixture sweep

- Rewrite `schema-version.test.ts` (invert the gate assertions, delete the
  detection-surfaces describe, add the current/stale fixture twins).
- Add `schemaVersion: 1` to every recipe-builder + inline recipe across the
  test files. Completeness check: `grep -rn "parseApiGuide(" __tests__/` and
  `grep -rn 'writeFileSync(.*guide.md' __tests__/` — every hit must be
  current-schema.

### Phase D — Dead-render cleanup (D1)

- Delete `staleSchemaLine`; drop the `⚠` renders in `formatGuideListings` /
  `formatApiGuideCatalog` / `guide-picker`; drop the `staleNote` in
  `api-fetch` / `api-guide`; drop the now-unused `current` params.
- The `current` params on `formatGuideListings` / `formatApiGuideCatalog` /
  `buildGuidePickerItems` are **optional with defaults** and no call site
  passes them — dropping them needs no call-site edits (`guide-store.ts:113`
  already calls `formatApiGuideCatalog` bare; other callers:
  `delete-command`, `verify-command`, `oauth-command`, `api-fetch`,
  `api-learn`, `api-guide`, `api-scaffold`).
- This phase is separable — if the diff budget is tight, it can land as a
  follow-up commit, but it should land before the gate is advertised as
  "fail loudly" (dead ⚠ renders contradict the policy).

### Phase E — Docs + caritas coordination

- `AGENTS.md` (host): the `schemaVersion` section flips from "Never a gate"
  to "hard gate"; update the "v1 (0.5.0)" note and the deferred-gate
  sentence added in Phase 1.
- Add a "Gate landed — `0.5.0`" marker to this doc's header.
- **Caritas companion PR**: re-stamp every caritas guide's frontmatter to
  `schemaVersion: 1` (one line per guide) and rewrite any static-key auth
  block still on the flat shape (the Phase-1 reshape). Host cannot do this —
  it is a separate repo. The two PRs ship together under `0.5.0`.

## Exit criteria

- A `schemaVersion: 0` / absent / malformed guide **fails to parse** with a
  `fix` naming `schemaVersion: 1`; a `schemaVersion: 1` or forward-stamped
  guide parses.
- Stale guides route to malformed in `loadApiGuidesFromDir` (catalog `⚠
  malformed` + per-guide error).
- `api-learn` saves a hand-written recipe without a `schemaVersion` line
  (stamp-before-validate); the skeleton carries `schemaVersion: 1`.
- `schema-version.test.ts` asserts the gate; the detection-surfaces tests
  and `staleSchemaLine` are gone (D1).
- No `⚠ schemaVersion` render path remains in `core/` or `tools/`.
- All 9 synthetic axis guides parse (already stamped `1`); `test:ci` +
  `test:py-bridge` green.
- Caritas re-stamped to `1` in the companion PR.

## Deferred / out of scope

- **Auto-upgrade on load** — the loader refuses stale guides; it does not
  rewrite them. Upgrading is the author's job (api-learn save, or a manual
  re-stamp). An auto-migration pass is a separate tool, not part of the gate.
- **Forward-compat guarantees** — a guide stamped `> current` parses but is
  not validated against the newer schema (host doesn't know it). Same as
  today; not changed by the gate.
- **`verified:` / other frontmatter** — untouched.
- **Removing the `schemaVersion` field entirely** — no; it stays as the
  vintage marker the gate reads.
