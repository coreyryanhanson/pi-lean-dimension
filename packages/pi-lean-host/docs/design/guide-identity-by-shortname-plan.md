# Implementation Plan — Guide Identity by `shortName`

> Execution plan for [`guide-identity-by-shortname.md`](guide-identity-by-shortname.md).
> Divides the structural redesign into two sequenced sprints with per-sprint
> acceptance criteria and an overall exit bar. Sprint 1 lands the `slug()`
> helper and the loader checks; Sprint 2 rewrites the `api-learn` write path
> and the user-visible strings.

## Sequencing logic

The redesign has one load-bearing dependency: `slug()` must exist before the
loader checks can call it and before the `api-learn` write path can compute the
save target. The loader checks (Sprint 1) are observability-only — they warn
on divergence and flag migration-window duplicates, but they don't change
keying or write behavior, so they can't break anything downstream (the
permanent illegal-shortName check does move a guide to `malformed`, but only
for an already-pathological all-symbol `shortName` — the same class as a
hand-edited traversal-shaped folder name). The `api-learn` rewrite (Sprint 2)
is the user-visible behavior change and depends on `slug()` existing.

```
Sprint 1 (slug() + loader checks: divergence + illegal-shortName + temp duplicate check + session_start cache clear)
   └─▶ Sprint 2 (api-learn write target + collision re-key + guard advice + string rewrites + tests)
```

Unlike the earlier four-sprint draft, there is no loader re-keying, no
`guide.dir` field, no `findGuidesByDomain` change, and no co-located test
re-keying — the invariant `dir === slug(shortName)` makes the existing
folder-keyed loader correct in steady state, so Sprint 1's loader changes are
purely additive checks. See the design doc's "Why invariant-enforcement instead
of loader re-keying" for the rationale.

---

## Sprint 1 — Foundation: `slug()` + loader checks

**Goal.** Land the `slug()` helper and the loader checks: the permanent
divergence check, the permanent illegal-shortName check, and the temporary
duplicate-shortName migration-window check (marked for 0.5.0 deletion). Also
add `invalidateCache()` to the `session_start` handler so the migration
"mv then /reload" instruction is correct regardless of pi's module-re-eval
semantics. No write-path change yet — nothing calls `slug()` from `api-learn`,
so no guide's save target changes. The loader checks are observability-only:
they warn/flag but don't change which guides load or how they're keyed (the
illegal-shortName check excepted as noted above).

### Work

1. **`slug()` in `core/path-template.ts`** (the path-safety module already owns
   `assertSafeDomain` — keep one safety surface).
   - Lowercase; replace every non-`[a-z0-9-]` run with `-`; collapse repeated
     `-`; strip leading/trailing `-`.
   - **Reuse `assertSafeDomain` as the single guard** on the slug result — the
     existing traversal/empty protection then covers both domains and slugs
     without a second implementation. (`assertSafeDomain` already rejects `/`,
     `\`, `\0`, `.`, `..` and empty; after the transform the only reachable
     failure is empty, from an empty or all-symbol `shortName`.) Wrap
     `assertSafeDomain`'s throw in a prescriptive message that names
     `shortName` rather than `domain`.
2. **Loader checks in `loadApiGuidesFromDir`** (`core/parse-api-guide.ts`) —
   added after a successful parse, **no re-keying** (record key stays `entry`):
   - **Divergence check (permanent):** if `entry !== slug(parsed.guide.shortName)`,
     emit a warning naming the current folder, the required folder
     (`slug(shortName)`), and the migration instruction (for 0.4.0: ask the
     agent to `mv <old> <new>`, then `/reload`). The guide still loads. This is
     the standing invariant monitor. **This check owns its own try/catch**
     around its `slug()` call: if `slug()` throws (empty or all-symbol
     `shortName`), route to `malformed` rather than letting the throw escape.
     This wrapping lives in the permanent divergence check, not in the
     temporary checks, so the loader stays safe after the 0.5.0 deletion.
   - **Duplicate-`shortName` check (temporary, remove in 0.5.0):** if a parsed
     guide's `shortName` was already seen in an earlier folder this scan, emit
     a warning naming both folders and suggesting `/api delete <one>`. In
     steady state (after migration) this is unreachable because two folders
     can't share `slug(shortName)`. Mark with
     `// TODO(0.5.0): remove — save-time slug() makes duplicate shortNames
     // unreachable once all folders are migrated.`
     (Track seen shortNames in a local `Set<string>` scoped to the scan loop;
     this is scan-local state, not a persistent field on `LoadedApiGuides`.)
   - **Illegal-`shortName` check (permanent):** if
     `slug(parsed.guide.shortName)` throws (empty or all-symbol `shortName`),
     push to `malformed` with a prescriptive "set a valid `shortName`" error
     instead of letting the throw escape. This is permanent, not temporary:
     hand-editing a `guide.md` to set `shortName: "!!!"` (or restoring a
     backup) is the same class of drift the permanent divergence check guards
     — save-time `slug()` only refuses at write time, so it does not cover
     guides that reach disk by other paths. No `// TODO(0.5.0): remove` marker.
     (Implemented as the divergence check's own try/catch, above — there is a
     single illegal-shortName routing path shared by the permanent checks, not
     a second implementation.)
3. **`invalidateCache()` on `session_start`** (`index.ts`): the current
   `session_start` handler only re-registers the portal projection; it does
   *not* clear the module-level guide-store `_cache`. The design doc's claim
   that a renamed folder is "stale until the next `session_start` or `/reload`"
   only holds if `session_start` actually clears the cache. Add
   `invalidateCache()` to the handler so the divergence check's "mv then
   `/reload`" migration instruction is correct regardless of whether pi
   re-evaluates the module vs. re-calls the entry function with persisted
   module-level state (the `/resume` path).

### Acceptance criteria

- [ ] `slug()` unit tests cover: lowercase forcing, non-`[a-z0-9-]`
      replacement, repeat-`-` collapse, leading/trailing `-` strip,
      empty/all-symbol input throws, a slug-collision pair
      (`cmc_full` / `cmc-full` → both `cmc-full`), and a traversal-shaped
      input (`..`, `a/b`) producing a result that `assertSafeDomain` accepts
      (i.e. flattened to a single safe segment) or rejects as appropriate.
- [ ] Divergence check: a guide loaded from a folder whose name differs from
      `slug(shortName)` emits the warning naming both folder names and the
      migration instruction; the guide still loads.
- [ ] Duplicate check: two folders with the same `shortName` emit the warning
      naming both folders; both guides load (keyed by their distinct folders).
- [ ] Illegal-shortName check: an empty or all-symbol `shortName` pushes to
      `malformed` with a prescriptive error; the loader doesn't throw.
- [ ] The duplicate-shortName check carries a `// TODO(0.5.0): remove`
      comment; the divergence and illegal-shortName checks do not.
- [ ] `npm run test:ci` green (no write-path code consumes `slug()` yet, so no
      save-target regressions; the loader checks are additive observability).
- [ ] No save-target behavior change observable from any tool or command
      (guides still save to `<domain>/guide.md` until Sprint 2).

---

## Sprint 2 — `api-learn` rewrite + string rewrites + tests + docs

**Goal.** Make the write target a function of `slug(shortName)` so two guides
with different `shortName`s physically cannot share a directory. Re-key the
collision warning and the retained overwrite guard to the new write target,
rewrite the four user-visible strings, and update the tests that assert on
save paths and warning text.

### Work

1. **Save target** (`tools/api-learn.ts` save branch):
   `join(guidesDir, slug(parsed.guide.shortName), "guide.md")`,
   computed from the parsed draft. The `domain` arg becomes cosmetic on
   the save branch (error/display context + `parseApiGuide({filename:
   domain})` + the `details.domain` field) — it no longer selects the folder
   and no longer feeds collision detection. Compute the slug **once** before
   the collision loop and reuse it for the write path, the collision
   comparison, and the guard. (Caveat: when `shortName:` is *absent* from the
   draft, the parser defaults `shortName` to `filename` = `domain`, so
   `slug(domain)` becomes the save target — the arg indirectly selects the
   folder in that edge case. In practice the placeholder template always
   includes `shortName:`, so this leak is unreachable for saved guides; the
   rewrite does not need to defend against it.)
2. **`stagingPathFor` rekey**: the fetch-recipe case has the `shortName` in
   hand, so stage under `slug(shortName)` — which **is** the new `dirName`.
   The new-template case has only a placeholder `shortName`, so templates
   continue to stage under the requested `domain`; staging is a `/tmp` draft
   concern, never data loss, so this partial rekey is acceptable. Pin the
   fetch-recipe staging firmly to `slug(shortName)` (not just "off
   `shortName`") so the staging key and the on-disk `dirName` are the same
   value.
3. **Collision-warning re-key**: today `m.dirName !== domain` means "an
   existing guide in a different folder than the one I'm writing to." That
   equality held only because `domain` *was* the write target. Change to
   `m.dirName !== slug(parsed.guide.shortName)`. Rewrite the warning message
   to render the slug, not `domain`. Without this the warning fires false
   positives (same-folder update flags as collision) and false negatives (a
   different-folder guide matching the `domain` arg is treated as
   same-directory). The lookup loop is unchanged — it already iterates
   `parsed.guide.domains` and calls `findGuidesByDomain` per key, so sibling
   discovery never read the `domain` arg.
4. **Overwrite guard — retained, repurposed**: the fail-closed
   `shortName`-mismatch guard (already shipped) compares the incoming
   `shortName` against the `guide.md` in `<guidesDir>/<domain>/`. After this
   redesign the save target is `<guidesDir>/<slug(shortName)>/`, so a
   pre-existing `guide.md` there with a *different* `shortName` is only
   reachable via a slug collision. Keep the guard; it is now a slug-collision
   detector, not dead code. **Rewrite its advice text**: today it tells the
   author to re-call with `domain: "${domain}-${shortName}"` — that
   workaround no longer makes sense (the write target is the slug, not the
   arg). The correct guidance for a slug collision is to **rename the
   `shortName`** so it slugs distinctly.
5. **User-visible string rewrites** (the four the design doc names):
   - The save result line `"saved to .../${domain}/guide.md"` and the
     `Domain: ${domain}` line beneath it → render `slug(shortName)`.
   - The collision-warning message (covered in step 3).
   - The overwrite-guard advice (covered in step 4).
   - The `api-fetch` `formatAmbiguousOperation` advice that tells the author
     to re-call `api-learn({domain: "${first.dirName}", ...})` — the
     `domain` arg is no longer load-bearing on save. Drop the
     `domain: "${first.dirName}"` advice; reword to "re-author one guide via
     api-learn({recipeFile: …}) with the colliding operation renamed."
   - Remove the fetch-recipe advice "pass the directory name as `domain` on
     re-save so a sibling guide is not clobbered" — a re-save now self-keys
     off its own `shortName` and naturally lands back in the same folder.
6. **`invalidateCache()` after save** — already present; confirm it stays so
   the next read re-scans (the divergence/duplicate checks depend on a fresh
   scan).

### Test updates in this sprint

- `__tests__/tools.test.ts` — catalog every assertion that references the
  old `<domain>` save path or the `domain` arg in warning text, and update
  each to `slug(shortName)`:
  - Line ~795: `join(tmpGuidesDir, "boe.es", "guide.md")` — the `boeRecipe`
    has `shortName: BOE`, so after redesign it saves to `slug("BOE")` =
    `"boe"`. Update to `join(tmpGuidesDir, "boe", "guide.md")`.
  - Line ~1000: `expect(secondText).toContain("collide-second")` — the
    collision warning now renders the slug, not the `domain` arg
    `"collide-second"`. Update to assert the slug of the second guide's
    `shortName`.
  - Line ~1081: `expect(text).toContain("/api delete recover-first")` —
    after redesign the existing guide's `dirName` is `slug(shortName)`, not
    the `domain` arg. Update to the slugged value.
  - Lines ~1140-1190: stamp test paths like
    `join(tmpGuidesDir, "stamp-absent.example", "guide.md")` — `shortName:
    StampAbsent` slugs to `"stampabsent"`. Update each stamp path to the
    slugged value.
  - Any other `join(tmpGuidesDir, "<domain>", "guide.md")` assertion: update
    to `slug(shortName)` of that fixture's `shortName`.
- `__tests__/api-learn-fetch-recipe.test.ts` — update the fetch-recipe
  `dirName`-surfacing and re-save advice assertions to the new self-keying
  behavior (no "pass directory as domain" advice).
- `__tests__/api-learn-fetch-recipe.test.ts` existing clobber test
  (~line 246-268 / the "fail-closed: different-shortName guide to an
  existing directory is refused" test) — **becomes a no-op under the
  redesign**. Different shortNames slug to different folders, so the
  overwrite guard never fires and the second save succeeds silently.
  Replace this test with a slug-collision test using shortNames that slug
  to the same value (e.g. `cmc_full` / `cmc-full`) — the second save is
  refused with the rename-`shortName` advice.
- New save-path tests:
  - A guide saves to `<slug(shortName)>/guide.md`, not
    `<domain>/guide.md`, when `shortName` slugs differently from `domain`.
  - A re-save of the same guide lands back in the same folder (self-keying),
    leaving no ghost when no sibling exists.
  - **Slug collision at save**: `cmc_full` / `cmc-full` — the second save is
    refused by the repurposed overwrite guard with the rename-`shortName`
    advice.
  - **Empty / all-symbol `shortName`** → save refuses with a prescriptive
    error (the `slug()` empty-result throw surfaces here).
  - **Divergence warning after agent-assisted rename**: an old `<domain>/`
    folder triggers the Sprint 1 divergence warning; after an `mv` to
    `<slug(shortName)>/` and a reload, the warning clears.
  - **Collision warning** fires only when an *other* folder (different
    `slug(shortName)`) claims a shared `domains:` key — not on a same-folder
    update; the message renders the slug.

### Docs

- Flip the design doc's status from **draft — not yet implemented** to
  **implemented**. Leave the Sequencing hotfix note (item 1) as-is — it
  documents already-shipped behavior.

### Acceptance criteria

- [ ] A guide with `shortName: cmc` and `domains: [coinmarketcap.com]` saves
      to `api-guides/cmc/guide.md`, regardless of the `domain` arg passed on
      save.
- [ ] A re-save of the same guide lands in the same `cmc/` folder; no ghost,
      no warning.
- [ ] The collision warning fires iff another folder (different
      `slug(shortName)`) claims a shared `domains:` key; it renders the slug,
      not the `domain` arg; a same-folder update does not warn.
- [ ] The overwrite guard refuses a slug-collision save with
      rename-`shortName` advice; it permits a same-`shortName` update.
- [ ] An empty / all-symbol `shortName` save is refused with a prescriptive
      error before any write.
- [ ] All four user-visible strings render the slug / new behavior; the
      "pass directory as domain on re-save" advice and the
      `api-fetch` `domain: "${first.dirName}"` advice are gone.
- [ ] The existing different-shortName clobber test is replaced by a
      slug-collision test; the slug-collision test asserts the refusal and
      the rename-`shortName` advice.
- [ ] `npx vitest run packages/pi-lean-host` green; `npm run test:ci` green;
      `npm run test:py-bridge` unaffected (no portal/python surface touched).
- [ ] Design doc status flipped to implemented.

---

## Overall exit bar (maps to the design doc's Pros)

- [ ] **Clobber structurally impossible**: two guides with different
      `shortName`s cannot share a directory — proved by the slug-collision
      and distinct-folder save tests.
- [ ] **Single identity axis**: `shortName` (via `slug`) is the identity
      everywhere (save target, invariant monitor); `domains:` is the only
      routing axis. No code path reads the `domain` arg as an identity/write
      target.
- [ ] **Uniqueness enforced at write time**: save-time `slug()` makes two
      guides with different shortNames physically unable to share a
      directory; the retained overwrite guard refuses slug collisions.
- [ ] **Re-save self-keys**: no "pass the directory name" guidance remains;
      a guide naturally lands back in its own folder.
- [ ] **Smaller code surface than re-keying**: no `guide.dir` field, no
      `findGuidesByDomain` change, no co-located test re-keying. Load-time
      surface is the permanent divergence and illegal-shortName checks plus
      the temporary duplicate-shortName check with a 0.5.0 deletion date.
- [ ] **No cross-cutting churn**: secrets store, auth, transport, routing,
      and `api-fetch` operation resolution are unchanged. Blast radius is
      `slug()` + the `api-learn` write target + the loader checks + four
      string rewrites.
- [ ] **CI green** on `structural` (`npm run test:ci` +
      `npm run test:py-bridge`); no browser or network job touched.

## Out of scope for this plan

- Auto-migration (design doc options B/C) — deferred unless divergence-warning
  reports accumulate; this plan ships lazy option A (agent-assisted rename)
  only.
- Removing the temporary duplicate-shortName startup check — scheduled
  for 0.5.0; the `// TODO(0.5.0): remove` comment is the removal trigger. The
  permanent divergence and illegal-shortName checks stay.
- Making `api-learn`'s `domain` param optional on the save branch — the fetch
  and template branches still require it, so the tool schema stays stable in
  this PR.
- A case-sensitive `slug()` variant — lowercase forcing is a resolved
  decision; revisit only if a case-sensitive identity is wanted.
