# Implementation Plan — Guide Identity by `shortName`

> Execution plan for [`guide-identity-by-shortname.md`](guide-identity-by-shortname.md).
> Divides the structural redesign into four sequenced sprints with
> per-sprint acceptance criteria and an overall exit bar. Each sprint is
> independently testable; later sprints depend on the type/keying
> foundations laid in earlier ones.

## Sequencing logic

The redesign has one load-bearing dependency chain: the `slug()` helper
and the `guide.dir` type field must exist before the loader can re-key,
and the loader must re-key before any `dirName` consumer (production or
test) can be audited honestly. The `api-learn` write-path rewrite sits
last because it depends on both `slug()` (write target) and the re-keyed
`findGuidesByDomain` (collision comparison).

```
Sprint 1 (foundation: slug + type)
   └─▶ Sprint 2 (loader re-key + malformed + findGuidesByDomain)
          └─▶ Sprint 3 (dirName consumer audit — production + tests)
                 └─▶ Sprint 4 (api-learn rewrite + migration + docs)
```

Sprints 2 and 3 are mostly mechanical (the audit list is closed — see
the design doc's "dirName consumers" edge case); Sprint 4 carries the
user-visible behavior change and the migration edge cases.

---

## Sprint 1 — Foundation: `slug()` + `guide.dir` type

**Goal.** Land the two prerequisites everything else imports: a
filesystem-safe slugifier and a place to carry the folder on the guide
object. No behavior change yet — nothing reads `guide.dir` and no write
path calls `slug()`.

### Work

1. **`slug()` in `core/path-template.ts`** (the path-safety module
   already owns `assertSafeDomain` — keep one safety surface).
   - Lowercase; replace every non-`[a-z0-9-]` run with `-`; collapse
     repeated `-`; strip leading/trailing `-`.
   - **Reuse `assertSafeDomain` as the single guard** on the slug result —
     the existing traversal/empty protection then covers both domains and
     slugs without a second implementation. (`assertSafeDomain` already
     rejects `/`, `\`, `\0`, `.`, `..` and empty; after the transform the
     only reachable failure is empty, from an empty or all-symbol
     `shortName`.) The empty-`shortName` failure mode from the doc's edge
     cases surfaces as `assertSafeDomain`'s throw here; wrap it in a
     prescriptive message that names `shortName` rather than `domain`.
2. **`guide.dir: string` on `ApiGuide`** (`core/api-guide-types.ts`).
   - Required field on the parsed guide. The parser does **not** set it
     (the parser is call-site-agnostic — it runs both at load and at
     write-validate, and only the loader knows the folder). `loadApiGuidesFromDir`
     sets it in Sprint 2; `api-learn`'s save path sets it implicitly by
     computing the write target from `slug(shortName)`.
   - `Guide` (the projection slice in `guide-loader.ts`) does **not** gain
     the field — `dir` is host-internal, never projected to portal.

### Acceptance criteria

- [ ] `slug()` unit tests cover: lowercase forcing, non-`[a-z0-9-]`
      replacement, repeat-`-` collapse, leading/trailing `-` strip,
      empty/all-symbol input throws, a slug-collision pair
      (`cmc_full` / `cmc-full` → both `cmc-full`), and a traversal-shaped
      input (`..`, `a/b`) producing a result that `assertSafeDomain`
      accepts (i.e. flattened to a single safe segment) or rejects as
      appropriate.
- [ ] `ApiGuide` type carries `dir: string`; `Guide` does not.
- [ ] `npm run test:ci` green (no production code consumes the new
      pieces yet, so no regressions).
- [ ] No behavior change observable from any tool or command.

---

## Sprint 2 — Loader re-key by `shortName` + duplicate-`shortName` malformed

**Goal.** Make the guide's identity its `shortName`, derived from file
content. The record key of `LoadedApiGuides.guides` becomes `shortName`;
the folder rides on `guide.dir`. True identity collisions (two folders,
same `shortName`) surface at load as a malformed entry instead of as a
silent ambiguous-resolution at fetch time.

### Work

1. **`loadApiGuidesFromDir`** (`core/parse-api-guide.ts`):
   - Key `result.guides` by `parsed.guide.shortName` instead of `entry`
     (the folder name).
   - Set `parsed.guide.dir = entry` on every successfully parsed guide.
   - **Duplicate-`shortName` detection:** if a parsed guide's
     `shortName` is already a key in `result.guides` (from an earlier
     folder), push the *second* occurrence to `malformed` with a
     prescriptive error naming both folders and pointing at
     `/api delete <old-folder>`. Which copy wins the live slot is
     `readdirSync` order (documented nondeterminism — both persist on
     disk, cleanup is `/api delete`).
   - `parseApiGuide({filename: name})` stays — `filename` is only the
     `shortName` fallback for frontmatter lacking `shortName:`, which is
     unchanged.
2. **`findGuidesByDomain`** (`core/guide-store.ts`): return
   `dirName: guide.dir` (read off the guide) rather than `dirName: name`
   (the record key, which is now the `shortName`). This is the
   load-bearing fix the doc calls out — without it `dirName` silently
   becomes the `shortName` and breaks every `dirName`-keyed filesystem
   reader.
3. **`buildDomainMap`** (`core/guide-loader.ts`): **no change**. It
   pushes the record key into domain-map arrays for `loaded.guides[key]`
   lookup, which is identity-preserving regardless of whether the key is
   the folder or the `shortName`. Verify with a test, don't edit.

### Test updates in this sprint (loader-owned)

The audit's loader-side entries move with the code they assert against:

- `__tests__/parse-api-guide.test.ts` — the two
  `expect(Object.keys(loaded.guides)).toEqual([...])` assertions (one
  expects `["boe.es"]`, one `["good"]`) now assert the guides'
  `shortName`s, not the folder names. Update to the guides' actual
  `shortName` values; add an assertion that `guide.dir` equals the
  folder.
- Co-located `api-guides/*/{static-key,local-helper,transform,
  resumption-token,token-bag}.test.ts` and the
  `en.wikipedia.org-action`/`services.dnb.de` files — the
  `loaded.guides["<folder-name>"]!` lookups become
  `loaded.guides["<shortName>"]!`. Each is a one-line key change to the
  guide's real `shortName`.
- `__tests__/axis-coverage.test.ts` — the `local-helper` coverage check
  builds a filesystem path from the record key
  (`existsSync(join(GUIDES_DIR, dirName, "helper.ts"))`). Switch to
  `guide.dir` so the path still resolves to the real folder. The
  per-guide ownership spot check (`GUIDES["boe.es"]`) likewise keys by
  `shortName`.
- New test: a two-folder, same-`shortName` fixture asserts the loader
  flags the duplicate as malformed with the prescriptive error and
  keeps exactly one live entry.

### Acceptance criteria

- [ ] `LoadedApiGuides.guides` is keyed by `shortName`; every live
      guide has `guide.dir` set to its folder name.
- [ ] Two folders with the same `shortName` produce one live guide and
      one `malformed` entry whose error names both folders and suggests
      `/api delete <old-folder>`.
- [ ] `findGuidesByDomain` returns `dirName === guide.dir` (the folder),
      never the `shortName` — asserted by a test that reads a guide from
      a folder whose name differs from its `shortName`.
- [ ] `buildDomainMap` is unchanged across the PR (diff verifies no
      edit) and still routes multi-recipe domains correctly.
- [ ] All loader-side and co-located tests updated and green;
      `npm run test:ci` green.
- [ ] No production consumer has broken yet (Sprint 3 audits them, but
      none should regress because every `dirName` reader destructures
      from `findGuidesByDomain`, which now returns the honest folder).

---

## Sprint 3 — `dirName` consumer audit (production + remaining tests)

**Goal.** Walk the closed audit list from the design doc and confirm
every direct record-iteration site reads the folder from `guide.dir`,
not the record key. Most consumers already destructure from
`findGuidesByDomain` (Sprint 2 made those honest transparently); this
sprint is the grep-and-verify pass for the rest.

### Work — production

1. **`tools/api-guide.ts`** — the "Known guides" list renders
   `Object.keys(loadAllGuides().guides)`. After re-keying this shows
   `shortName`s instead of folder names. This is the "cosmetic display
   change" the doc flags as arguably an improvement. **No code change
   required** — confirm the output is still sensible (shortNames are
   more meaningful than folder names) and add/adjust a snapshot-style
   assertion if one exists.
2. **`core/parse-api-guide.ts` `formatApiGuideCatalog`** — the orgless
   fallback renders `guide.domains.join(", ") : name` where `name` is
   the record key. Dead code for `ApiGuide`s (`domains:` is
   parser-required non-empty), so it only matters if a malformed guide
   slips through. Verify the fallback path still renders something
   reasonable; no load-bearing change expected.
3. **`core/portal-projection.ts` `buildProjection`** — keys the portal
   projection by the record key (`out[name] = projectToGuide(guide)`).
   Portal treats the keys as opaque, and `shortName`s are more
   meaningful display values. **Likely benign — verify**, do not edit
   unless a portal-side test asserts a specific key.
4. **Transparent consumers (confirm, no edit):**
   - `tools/api-fetch.ts` — helper routing via `dirName` from
     `findGuidesByDomain`. Unchanged behavior.
   - `core/local-helpers.ts` — `findHelperFile(dirName)` +
     `ctx.domain = dirName`. Unchanged.
   - `core/verify-command.ts`, `core/delete-command.ts`,
     `core/guide-picker.ts`, `core/helpers.ts`, `core/auth.ts` — all
     take `dirName` from `findGuidesByDomain` /
     `selectGuideByShortName`. Unchanged.
   - `core/api-toggle.ts` — `Object.keys(allGuides.guides).length` is a
     count; key identity is irrelevant.

### Work — remaining tests

- `__tests__/delete-command.test.ts` — the
  `loadAllGuides().guides["delete.test"]` assertion and any
  `findGuidesByDomain(...).map((m) => m.dirName)` expectations: the
  `dirName` expectations stay folder-named (correct), the direct
  `guides[<folder>]` lookup switches to the guide's `shortName`.
- `__tests__/transform-paginate.test.ts` / `transform-restget.test.ts`
  — `loaded.guides["fixture.test"]!` → key by the fixture's
  `shortName`.
- `__tests__/api-learn-fetch-recipe.test.ts` — leave for Sprint 4
  (it asserts save/fetch behavior the rewrite changes); only touch
  here if a `dirName`-from-record-key assertion breaks independently.

### Acceptance criteria

- [ ] `grep -rn "guides\[" --include="*.ts"` (excluding `node_modules`)
      returns only lookups keyed by a guide's actual `shortName` — no
      site reads a folder name out of the record key.
- [ ] `grep -rn "Object.entries(.*guides\|Object.keys(.*guides"`
      returns only sites where the key is used as a count, an opaque
      projection key, or a display `shortName` — no site uses it as a
      filesystem path or a folder name. (The one intentional exception,
      `axis-coverage`'s `local-helper` path, was fixed in Sprint 2 to
      read `guide.dir`.)
- [ ] Every transparent consumer confirmed unchanged by reading the
      code (a short audit note in the PR description listing each
      confirmed site).
- [ ] `npx vitest run packages/pi-lean-host` green; `npm run test:ci`
      green.
- [ ] No user-visible regression in `api-guide` catalog rendering
      beyond the folder-name → shortName cosmetic shift, which is
      documented and expected.

---

## Sprint 4 — `api-learn` rewrite + migration (lazy A) + docs

**Goal.** Make the write target a function of `slug(shortName)` so two
guides with different `shortName`s physically cannot share a directory.
Re-key the collision warning and the retained overwrite guard to the new
write target, rewrite the user-visible strings, and lock in the lazy
migration behavior with edge-case tests.

### Work

1. **Save target** (`tools/api-learn.ts` save branch):
   `join(guidesDir, slug(parsed.guide.shortName), "guide.md")`,
   computed from the parsed draft. The `domain` arg becomes purely
   cosmetic on the save branch (error/display context +
   `parseApiGuide({filename: domain})` + the `details.domain` field) —
   it no longer selects the folder and no longer feeds collision
   detection. Compute the slug **once** before the collision loop and
   reuse it for the write path, the collision comparison, and the
   guard.
2. **`stagingPathFor` rekey**: the fetch-recipe case has the
   `shortName` in hand, so stage under `slug(shortName)` — which **is**
   the new `dirName`. The new-template case has only a placeholder
   `shortName`, so templates continue to stage under the requested
   `domain`; staging is a `/tmp` draft concern, never data loss, so
   this partial rekey is acceptable. Pin the fetch-recipe staging
   firmly to `slug(shortName)` (not just "off `shortName`") so the
   staging key and the on-disk `dirName` are the same value.
3. **Collision-warning re-key**: today
   `m.dirName !== domain` means "an existing guide in a different
   folder than the one I'm writing to." That equality held only because
   `domain` *was* the write target. Change to
   `m.dirName !== slug(parsed.guide.shortName)`. Rewrite the warning
   message to render the slug, not `domain`. Without this the warning
   fires false positives (same-folder update flags as collision) and
   false negatives (a different-folder guide matching the `domain` arg
   is treated as same-directory). The lookup loop is unchanged — it
   already iterates `parsed.guide.domains` and calls
   `findGuidesByDomain` per key, so sibling discovery never read the
   `domain` arg.
4. **Overwrite guard — retained, repurposed**: the fail-closed
   `shortName`-mismatch guard (already shipped) compares the incoming
   `shortName` against the `guide.md` in `<guidesDir>/<domain>/`. After
   this redesign the save target is `<guidesDir>/<slug(shortName)>/`,
   so a pre-existing `guide.md` there with a *different* `shortName` is
   only reachable via a slug collision. Keep the guard; it is now a
   slug-collision detector, not dead code. **Rewrite its advice text**:
   today it tells the author to re-call with
   `domain: "${domain}-${shortName}"` — that workaround no longer makes
   sense (the write target is the slug, not the arg). The correct
   guidance for a slug collision is to **rename the `shortName`** so it
   slugs distinctly.
5. **User-visible string rewrites** (the three the doc names):
   - The save result line `"saved to .../${domain}/guide.md"` and the
     `Domain: ${domain}` line beneath it → render `slug(shortName)`.
   - The collision-warning message (covered in step 3).
   - The overwrite-guard advice (covered in step 4).
   - Remove the fetch-recipe advice "pass the directory name as
     `domain` on re-save so a sibling guide is not clobbered" — a
     re-save now self-keys off its own `shortName` and naturally lands
     back in the same folder.
6. **`invalidateCache()` after save** — already present; confirm it
   stays so the next read re-scans (the ghost-folder condition depends
   on a fresh scan).
7. **Lazy migration (option A) — no auto-migration code**: existing
   guides at `<domain>/guide.md` still load (the loader reads
   `shortName` from content, ignoring the old folder). A re-save
   relocates to `<slug(shortName)>/guide.md`, leaving the old
   `<domain>/` folder as a ghost that double-registers the same
   `shortName` — which is exactly the new duplicate-`shortName`
   malformed condition from Sprint 2, so the loader flags it
   prescriptively. Cleanup is the existing `/api delete <old-folder>`.
   No new migration command, no read-side mutation.

### Test updates in this sprint

- `__tests__/api-learn-fetch-recipe.test.ts` — update the fetch-recipe
  `dirName`-surfacing and re-save advice assertions to the new
  self-keying behavior (no "pass directory as domain" advice).
- New save-path tests:
  - A guide saves to `<slug(shortName)>/guide.md`, not
    `<domain>/guide.md`, when `shortName` slugs differently from
    `domain`.
  - A re-save of the same guide lands back in the same folder
    (self-keying), leaving no ghost when no sibling exists.
  - **Slug collision at save**: two `shortName`s that slug to the same
    value (`cmc_full` / `cmc-full`) — the second save is refused by the
    repurposed overwrite guard with the rename-`shortName` advice.
  - **Empty / all-symbol `shortName`** → save refuses with a
    prescriptive error (the `slug()` empty-result throw surfaces here).
  - **Ghost after re-save**: an old `<domain>/` folder plus a new
    `<slug(shortName)>/` folder coexist → loader flags the duplicate
    `shortName` as malformed, `/api delete <old-folder>` clears it
    (reuses the Sprint 2 malformed path; add one end-to-end test
    through `api-learn` save → `loadApiGuidesFromDir` → `/api delete`).
  - **Collision warning** fires only when an *other* folder (different
    `slug(shortName)`) claims a shared `domains:` key — not on a
    same-folder update; the message renders the slug.

### Docs

- Flip the design doc's status from **draft — not yet implemented** to
  **implemented**, and prune any forward-looking sections of the design
  doc that reference follow-up work outside this redesign. This plan
  lands the redesign self-contained. Leave the Sequencing hotfix note
  (item 1) as-is — it documents already-shipped behavior.

### Acceptance criteria

- [ ] A guide with `shortName: cmc` and `domains: [coinmarketcap.com]`
      saves to `api-guides/cmc/guide.md`, regardless of the `domain`
      arg passed on save.
- [ ] A re-save of the same guide lands in the same `cmc/` folder; no
      ghost, no warning.
- [ ] The collision warning fires iff another folder (different
      `slug(shortName)`) claims a shared `domains:` key; it renders the
      slug, not the `domain` arg; a same-folder update does not warn.
- [ ] The overwrite guard refuses a slug-collision save with
      rename-`shortName` advice; it permits a same-`shortName` update.
- [ ] An empty / all-symbol `shortName` save is refused with a
      prescriptive error before any write.
- [ ] A ghost folder left by a re-save is flagged as a
      duplicate-`shortName` malformed entry; `/api delete <old-folder>`
      clears it and the guide loads cleanly afterward.
- [ ] All three user-visible strings render the slug / new behavior;
      the "pass directory as domain on re-save" advice is gone.
- [ ] `npx vitest run packages/pi-lean-host` green; `npm run test:ci`
      green; `npm run test:py-bridge` unaffected (no portal/python
      surface touched).
- [ ] Design doc status flipped to implemented; forward-looking
      follow-up sections pruned.

---

## Overall exit bar (maps to the design doc's Pros)

- [ ] **Clobber structurally impossible**: two guides with different
      `shortName`s cannot share a directory — proved by the
      slug-collision and distinct-folder save tests.
- [ ] **Single identity axis**: `shortName` is the identity key
      everywhere (loader record key, disambiguation menu, save target
      input); `domains:` is the only routing axis. No code path reads
      the `domain` arg as an identity/write target.
- [ ] **Uniqueness enforced at write time**: the filesystem rejects
      duplicate identity at save; the loader surfaces the
      duplicate-`shortName` malformed condition at load as a
      strict-better failure point.
- [ ] **Re-save self-keys**: no "pass the directory name" guidance
      remains; a guide naturally lands back in its own folder.
- [ ] **No cross-cutting churn**: secrets store, auth, transport,
      routing, and `api-fetch` operation resolution are unchanged
      (audit notes confirm each). Blast radius is the loader keying +
      `api-learn` write target + one new malformed condition + `slug()`.
- [ ] **CI green** on `structural` (`npm run test:ci` +
      `npm run test:py-bridge`); no browser or network job touched.

## Out of scope for this plan

- Auto-migration (design doc options B/C) — deferred unless ghost-folder
  reports accumulate; this plan ships lazy option A only.
- Making `api-learn`'s `domain` param optional on the save branch — the
  fetch and template branches still require it, so the tool schema stays
  stable in this PR.
- A case-sensitive `slug()` variant — lowercase forcing is a resolved
  decision; revisit only if a case-sensitive identity is wanted.
