# Guide Identity by `shortName` — Structural Redesign

> Decision record for moving the guide **identity key** from the directory name
> to the guide's own `shortName`, so that authoring a second guide for a routing
> domain can never silently overwrite a sibling. This is the structurally-clean
> follow-up to the fail-closed overwrite guard shipped as the immediate data-loss
> hotfix.
>
> The motivating bug: a second guide for the same routing domain saved with the
> natural `domain: "coinmarketcap.com"` (== the first guide's folder) targets
> the same `guide.md` and silently replaces the first. The dual role of `domain`
> (routing argument on fetch, identity argument on save) is the root cause; the
> pre-hotfix collision warning fired on the wrong condition (different
> directories) and stayed silent on the dangerous one (same directory, different
> guide). The fail-closed guard in `tools/api-learn.ts` (refuse when the incoming
> `shortName` differs from the guide.md already in the target directory) stops
> that data loss at the moment it would happen; this redesign removes the *class*
> of confusion.
>
> Status: **draft — not yet implemented.** This document exists to evaluate the
> redesign before committing to it. It is sequenced ahead of the sibling-artifact
> authoring doc [`api-verify-scaffold.md`](api-verify-scaffold.md), whose
> staging-path keying this redesign supersedes.

## Problem statement

`api-learn` writes to `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`,
where `<domain>` is the verbatim tool argument. The loader
(`core/parse-api-guide.ts` → `loadApiGuidesFromDir`) keys every guide by its
**subdirectory name** and routes by the guide's `domains:` field. So the
directory is the guide's **identity**, and `domains:` is its **routing** — two
distinct concerns coupled through the one folder name.

When a second guide for the same routing domain is saved with the natural
`domain: "coinmarketcap.com"` (== the first guide's folder), both writes target
the same `guide.md` and the second silently replaces the first. The dual role of
`domain` (routing argument on fetch, identity argument on save) is the root
cause; the existing collision warning fires on the wrong condition (different
directories) and stays silent on the dangerous one (same directory, different
guide).

The fail-closed guard stops the data loss at the moment it would happen. This
redesign removes the *class* of confusion: identity becomes a function of the
file's own content, never the tool argument, so the clobber is impossible by
construction.

## Core idea

**The guide's identity is its `shortName`, derived from the file content. The
write target is a function of `slug(shortName)`, never the `domain` argument.**
Two guides with different shortNames physically cannot share a directory.
Routing is untouched — the loader already scans every subdirectory and builds a
multi-valued domain map from each guide's `domains:` field; the folder name was
only ever the identity key, never the routing key.

```
# today: folder = the domain arg passed on save (identity ≡ routing)
api-guides/coinmarketcap.com/guide.md        # shortName: cmc
api-guides/coinmarketcap.com/guide.md        # shortName: cmc-full  ← clobber

# after:  folder = slug(shortName), read from the file (identity ⊥ routing)
api-guides/cmc/guide.md                      # domains: [coinmarketcap.com]
api-guides/cmc-full/guide.md                 # domains: [coinmarketcap.com]
```

## What changes, and what does not

### Changes (blast radius)

1. **`loadApiGuidesFromDir`** (`core/parse-api-guide.ts`) — key
   `result.guides` by `parsed.guide.shortName` instead of `entry` (the folder
   name), and set `guide.dir = entry` so the folder rides on the guide (see item
   2). Detect a true collision (two folders whose guides share a `shortName`)
   and push it to `malformed` with a prescriptive error — the *correct* error
   (duplicate identity), surfaced at load time instead of as a silent
   ambiguous-resolution at fetch time.
2. **`LoadedApiGuides`** (`core/api-guide-types.ts`) — each `ApiGuide` carries
   its folder (`guide.dir: string`). `findGuidesByDomain` returns `{guide,
   dirName}` where `dirName` is now `guide.dir` (the *folder*), not the record
   key. **Decision: carry the folder on the guide object, not a separate
   `shortName → folder` side-channel.** Grounding: `findGuidesByDomain`
   (`core/guide-store.ts`) does `loaded.guides[name]` and returns
   `dirName: name`. Once `guides` is re-keyed by `shortName`, a separate folder
   map makes `findGuidesByDomain` need a second lookup, and its
   `dirName: name` silently becomes the shortName rather than the folder — a
   bug with no compile error, and it breaks every `dirName`-keyed reader
   (`local-helpers.ts`, `verify-command.ts`, `delete-command.ts`, and the
   follow-up scaffold PR's sibling staging, which reads
   `<guidesDir>/<dirName>/`). Carrying `dir` on the guide lets
   `findGuidesByDomain` read `guide.dir` directly and keeps `dirName` honest.
   (`buildDomainMap` in `core/guide-loader.ts` needs **no change** — it only
   pushes the record key into domain-map arrays for `loaded.guides[key]`
   lookup, which is identity-preserving regardless of what the key is.)
3. **`api-learn` save path** (`tools/api-learn.ts`) — write target becomes
   `join(guidesDir, slug(parsed.guide.shortName), "guide.md")`, derived from the
   parsed draft. The `domain` arg becomes **purely cosmetic on the save branch** —
   it no longer selects the folder *and* no longer feeds collision detection (the
   collision loop iterates `parsed.guide.domains`, the file's own routing keys,
   not the arg; see item 6 for the comparison re-key). Its only remaining save-
   path uses are error/display context (`parseApiGuide({filename: domain})`) and
   the `details.domain` field. The fetch-recipe advice about "pass the directory
   name as `domain` on re-save" is removed — a re-save self-keys off its own
   `shortName` and naturally lands back in the same folder. **Three user-visible
   strings that still name `domain` must be rewritten to name the actual write
   target** (`slug(shortName)`): the result line `"saved to
   .../${domain}/guide.md"` (and the `Domain: ${domain}` line beneath it), the
   collision-warning message (covered in item 6), and the overwrite-guard advice
   (covered in item 6). A stale or wrong `domain` arg can no longer misroute the
   write or skew collision detection — strictly more robust than today, where
   the arg *is* the write target.
4. **`slug()`** — new small sanitizer in `core/path-template.ts` (or a sibling):
   lowercase, replace non-`[a-z0-9-]` with `-`, collapse repeats, strip leading/
   trailing `-`, reject empty / path-traversal results. Reuse `assertSafeDomain`
   as the final safety check on the slug so the existing guard covers both
   domains and slugs.
5. **`stagingPathFor`** (`tools/api-learn.ts`) — rekey off `slug(shortName)`,
   which **is** the new `dirName` (fetch-recipe case has the `shortName` in
   hand). The new-template case has only a placeholder `shortName`, so templates
   continue to stage under the requested `domain` until the author fills
   `shortName`; staging is a /tmp draft concern, never data loss, so this partial
   rekey is acceptable. **Pinning this firmly as `slug(shortName)` (not just
   "off `shortName`") is load-bearing for the follow-up scaffold PR**: it makes
   the scaffold doc's "key staging by `dirName`" section inherited rather than
   re-decided, so that section can be deleted there outright.
6. **Collision-warning logic** (`tools/api-learn.ts` save path) — the warning
   stays (it's still useful guidance for disambiguation territory), but its
   **directory comparison must be re-keyed**. Today it checks `m.dirName !== domain`
   to mean "an existing guide in a *different* folder than the one I'm writing
   to." That equality held only because `domain` *was* the write target. After
   this redesign the write target is `slug(shortName)`, not `domain`, so the
   comparison must become `m.dirName !== slug(parsed.guide.shortName)` (compute
   the slug once before the loop; reuse the same value the write path uses).
   Without this change the warning fires false positives (an existing guide in
   the *same* `slug(shortName)` folder flags as a collision and tells the author
   to `/api delete` the guide they're updating) and false negatives (an existing
   guide in a different folder that happens to match the `domain` arg is treated
   as same-directory). The lookup is unchanged — the loop already iterates
   `parsed.guide.domains` (the file's own routing keys) and calls
   `findGuidesByDomain` on each, so sibling discovery never read the `domain` arg;
   only the folder comparison changes. The warning message itself must also be
   rewritten: today it says ``writing to directory
   \`${domain}\` ``, which is now wrong (the write target is `slug(shortName)`,
   not `domain`) — render the slug there instead. The
   dangerous same-directory silent-clobber case is no longer reachable, so the
   pre-hotfix guard that missed it can be removed rather than patched.

   **Note on the shipped overwrite guard's shifted semantics:** the fail-closed
   `shortName`-mismatch guard (item 1 of Sequencing, already shipped) compares the
   incoming `shortName` against the guide.md in `<guidesDir>/<domain>/`. After
   this redesign the save target becomes `<guidesDir>/<slug(shortName)>/`, so a
   pre-existing guide.md there with a *different* `shortName` is only reachable
   via a slug collision (e.g. `cmc_full` and `cmc-full` both slug to `cmc-full`).
   The guard is retained, but it transforms from "clobber detector" into
   "slug-collision detector." It is not dead code — keep it; the follow-up
   scaffold PR reads it as the slug-collision backstop, not as removable legacy.
   Its advice text must also be rewritten: today it tells the author to "use a
   distinct directory" by re-calling with `domain: "${domain}-${shortName}"` —
   that workaround no longer makes sense (the write target is the slug, not the
   arg). The correct guidance for a slug collision is to **rename the
   `shortName`** so it slugs distinctly.

### Does NOT change (load-bearing facts that make this safe)

- **Secrets store** — keyed on `canonicalStoreDomain(guide) = guide.domains[0]`
  (`core/auth.ts`), **not** on the folder. Relocating a guide's folder does not
  move its secrets; `/api secrets coinmarketcap.com` keeps feeding both guides
  regardless of their folder names. **No secret migration.**
- **`api-fetch` operation resolution** — resolves ops by name across all guides
  matching the routing domain; helper routed by `dirName` (the folder), which
  `findGuidesByDomain` still returns. Unchanged behavior.
- **`local-helpers.ts`** — locates `helper.ts` via `dirName` (the folder). No
  logic change; `ctx.domain = dirName` transform semantics preserved.
- **Disambiguation menu** — already lists by `shortName`; now `shortName` is also
  the identity key, so the surface is more consistent, not different.
- **`/api delete`** — deletes by directory + `invalidateCache()`s. Still works;
  the directory is now `slug(shortName)` but the delete command takes whatever
  directory name is shown.

## Migration of existing user guides

Guides saved before the change live at `<domain>/guide.md`. After the change
they still **load** — the loader reads `shortName` from content and keys by it,
ignoring the old folder name — so there is **no read-time break**. But a re-save
relocates the guide to `<slug(shortName)>/guide.md`, leaving the old `<domain>/`
folder behind as a ghost that still parses and double-registers the same
`shortName` until cleaned.

That double-registration is exactly the new "duplicate `shortName`" malformed
condition, so the loader will surface it prescriptively after the first re-save,
pointing the author at `/api delete <old-folder>`. Cleanup is a solved problem
(`/api delete` + `invalidateCache()` already exist for ghost guides), but it's a
one-time annoyance per existing multi-recipe user.

**Note on which copy wins.** When both the old `<domain>/` and the new
`<slug(shortName)>/` folder exist, `readdirSync` order decides which guide lands
in `guides` (live) vs `malformed` (duplicate). Both copies persist on disk either
way, the malformed error is prescriptive, and `/api delete <old-folder>` clears
the ghost — so this is not a data-loss path, only a nondeterministic read until
cleaned. (The save path should `invalidateCache()` so the next read re-scans;
`/api delete` already does.)

**Options considered:**

- **A. Lazy, no auto-migration (recommended).** Old folders load fine; a re-save
  relocates and the loader flags the resulting ghost. Minimal code, no read-side
  mutation, no surprise. Cost: one manual `/api delete` per re-saved guide.
- **B. Auto-migrate on first load.** `mv <domain>/ → <slug(shortName)>/` when the
  folder name ≠ `slug(shortName)`. Transparent to the user, but **mutating user
  dirs on read** is surprising and races a concurrent `api-fetch` reading the
  same folder. Rejected unless the ghost cleanup proves burdensome in practice.
- **C. Ship a one-time migration command.** `/api migrate` or a startup sweep
  that renames folders in place with no live readers. More machinery than the
  problem warrants at current user-guide volume.

Recommend **A**; revisit **C** only if reports of ghost folders accumulate.

## Edge cases & new failure modes

- **Slug collisions.** Two shortNames that slug to the same value (e.g.
  `cmc_full` and `cmc-full`) target the same folder. The loader detects the
  duplicate `shortName` at load and reports it as malformed; the save path
  detects the pre-existing `guide.md` with a different `shortName` and refuses
  (the hotfix guard, retained). Real but small — `shortName` is author-chosen and
  human-readable, so exact and slug collisions are both visible and fixable by
  renaming one guide.
- **Empty / unsafe `shortName`.** `slug()` must produce a non-empty, traversal-
  safe result. An empty or all-symbol `shortName` → slug is empty → save refuses
  with a prescriptive error. `assertSafeDomain` is reused as the final guard so
  the existing path-traversal protection covers slugs without a second
  implementation.
- **Duplicate `shortName` across folders.** Today this surfaces as an
  "ambiguous" resolution at `api-fetch`/`api-guide` time. After the change it
  surfaces earlier, at load, as a malformed entry — a strictly better failure
  point (fail at identity definition, not at use).
- **`dirName` consumers.** Any code that read `dirName` off the record key
  (`Object.entries(loaded.guides)`) must read it from `guide.dir` instead. Audit:
  `api-guide` catalog rendering, `api-fetch` helper routing,
  `local-helpers.ts` listing, `verify-command.ts`, `delete-command.ts`, and
  `core/portal-projection.ts` (`buildProjection` keys the portal projection by
  the record key — likely benign since portal treats keys as opaque, and
  shortNames are more meaningful display values, but verify). Also includes
  **test files** that access `loaded.guides[<folder-name>]` directly or use the
  record key as a filesystem path: the co-located `api-guides/*/{static-key,
  local-helper,transform,resumption-token,token-bag}.test.ts` files,
  `__tests__/transform-{restget,paginate}.test.ts` (fixture key),
  `__tests__/parse-api-guide.test.ts` (an `Object.keys(loaded.guides)` equality
  assertion), `__tests__/delete-command.test.ts`, and `__tests__/axis-coverage.test.ts`
  (the subtle one — iterates `Object.entries(GUIDES)` and builds a filesystem
  path from the key via `existsSync(join(GUIDES_DIR, dirName, ...))`; must switch
  to `guide.dir` so the path still resolves to the real folder). All production
  `dirName` consumers already destructure from `findGuidesByDomain`, so most are
  transparent (the change is inside `findGuidesByDomain`, which returns
  `dirName: guide.dir` rather than `dirName: name`; `buildDomainMap` needs *no*
  change — it only pushes the record key into arrays for `loaded.guides[key]`
  lookup, which is identity-preserving regardless of what the key is). The audit
  is for any *direct* record iteration that still reads the key as the folder.
- **Cosmetic display changes (folder name → shortName).** Two surfaces render
  the record key to the user and will show shortNames instead of folder names
  after re-keying: `tools/api-guide.ts`'s "Known guides" list
  (`Object.keys(loadAllGuides().guides)`) and `formatApiGuideCatalog`'s orgless
  fallback (`guide.domains.join(", ") : name` in `core/parse-api-guide.ts`).
  The fallback is dead code for `ApiGuide`s (`domains:` is parser-required
  non-empty), so it only matters if a malformed guide slips through; the
  "Known guides" list is live and arguably an improvement (shortNames are more
  meaningful than folder names). No code change needed, but the blast radius
  should be honest about it.

## Pros

- **Clobber structurally impossible**, not guarded-against. No guard to forget,
  no flag to pass, no manual to read.
- **Kills the dual-role `domain` confusion** (routing vs. identity) that caused
  both the save clobber and the staging collision. `shortName` is the single
  identity axis; `domains:` stays the single routing axis.
- **Enforces `shortName` uniqueness by construction** — the filesystem rejects
  duplicate identity at write time rather than `selectGuideByShortName`
  reporting "ambiguous" at read time.
- **Re-save self-keys** — the fetch-recipe "pass the directory name" advice
  disappears; a guide naturally lands back in its own folder.
- **No secret-store migration, no auth change, no transport change, no routing
  change.** Blast radius is the loader keying + `api-learn` write target + one
  new malformed condition + a slug function.

## Cons / costs

- **Storage-layout change.** Existing user guides need a one-time `/api delete`
  of the ghost folder after their first re-save (under recommended migration A).
  No read-time break, but a per-guide cleanup annoyance.
- **New `slug()` surface.** Trivial but real: a sanitizer with its own edge
  cases (slug collisions, empty result, unicode). Reusing `assertSafeDomain` as
  the final guard keeps the safety story to one function.
- **`LoadedApiGuides` `guide.dir` field.** Type/API churn touching
  `findGuidesByDomain` and direct-record-iteration sites (`buildDomainMap`
  needs no change — see blast-radius item 2). Minor but non-zero. (A separate
  `shortName → folder` side-channel was rejected — see blast-radius item 2;
  it would let `findGuidesByDomain`'s `dirName: name` silently return the
  shortName instead of the folder, a bug with no compile error.)
- **One new malformed error path** (duplicate `shortName` across folders).
  Correct failure point, but a new user-visible failure where today the guide
  loads and fails later as "ambiguous."
- **Does not fully fix the staging collision** — `stagingPathFor` can rekey off
  `shortName` only for the fetch-recipe case; the new-template case has no
  `shortName` yet, so templates stay domain-keyed in /tmp. Acceptable: staging is
  a draft concern, never data loss.
- **Adds a concept (`slug`) to the authoring model.** Authors who inspect the
  folder layout see `cmc/` instead of `coinmarketcap.com/` and must learn that
  the folder is no longer the routing domain. The disambiguation menu and
  `/api status` already present `shortName`, so the visible surface is
  consistent, but the on-disk layout is one more step removed from the routing
  domain.

## Sequencing

1. **Done (hotfix, shipped):** the fail-closed `shortName`-mismatch overwrite
   guard in the `api-learn` save path is live — it refuses when the incoming
   `shortName` differs from the guide.md already in the target directory.
   Already shipping; do **not** re-implement it in this redesign's PR. After
   this redesign lands it shifts from "clobber detector" to "slug-collision
   detector" (see blast-radius item 6), but stays.
2. **Next (this redesign):** implement the structural change as a focused PR —
   loader keying by `shortName`, `guide.dir` carry-through, `slug()`,
   `api-learn` write target, audit `dirName` consumers, add the
   duplicate-`shortName` malformed test, update the fetch-recipe advice. Ship
   migration **A** (lazy, ghost flagged on re-save).
3. **Later (only if needed):** revisit auto-migration (**B** or **C**) if ghost-
  folder cleanup reports accumulate; otherwise leave it.

The hotfix already closes the data-loss hole today. The redesign earns its
keep as a follow-up because it removes the whole class of confusion rather than
patching one symptom — but it's not the fix for a live data-loss bug.

## Forward note for the scaffold PR (`api-verify-scaffold.md`)

This redesign is sequenced ahead of the sibling-artifact authoring doc
(`api-verify-scaffold.md`) and pays down two of its costs so the follow-up PR
is smaller:

- **Staging-path keying is already decided here.** That doc's "Staging path
  keying" section (rekey `/tmp` from routing `domain` → `dirName`) is inherited
  by this redesign's blast-radius item 5 (`stagingPathFor` keys off
  `slug(shortName)`, which *is* the new `dirName`). The scaffold PR should
  **delete that section outright** rather than re-deciding it.
- **The deletion-safety gate's wipe surface shrinks.** That doc motivates its
  mirror-save deletion-safety gate with two wipe windows: `new: true` saved
  over an existing directory that has siblings, and accidental `/tmp` cleanup.
  Under shortname-identity the first window shrinks to near-zero: a
  `new: true` template has a placeholder `shortName`, so its save target is
  `<slug(placeholder)>/`, which won't collide with a real guide's folder unless
  the author fills in an existing `shortName` — and that's caught by the
  shifted overwrite guard (blast-radius item 6). The scaffold PR therefore only
  needs to guard the accidental-`/tmp`-cleanup case, not the
  `new: true`-over-existing case. Half the gate's motivation, pre-paid.

## Resolved decisions

- **`slug()` forces lowercase.** Filesystem-safe default, matches typical slug
  conventions. Cost: `CMC` and `cmc` collide (accepted — author-chosen
  `shortName`s in existing recipes are already lowercase, so no real-world
  break). Revisit only if a case-sensitive identity becomes wanted.
- **Folder name is pure `slug(shortName)`** — no `<domain>-` prefix. Identity is
  the only axis; a prefix would re-couple identity to routing, which is the
  confusion this redesign removes. The on-disk layout being one step removed
  from the routing domain is the acknowledged cost (Cons), offset by the
  disambiguation menu and `/api status` already surfacing `shortName`.
- **`api-learn`'s `domain` param stays as a tool param, but is purely cosmetic
  on the save branch.** The fetch and template branches require it (routing
  lookup / template prefill), so it can't be dropped from the tool schema in
  this PR. On save it no longer selects the folder *and* no longer feeds
  collision detection (the collision loop iterates `parsed.guide.domains`, the
  file's own keys, not the arg — see blast-radius item 6). Its only remaining
  save-path uses are error/display context (`parseApiGuide({filename: domain})`,
  the `details` field). Making it optional-on-save is deferred to the scaffold
  PR, which already reworks the save signature (`recipeFile` → `dir`); this PR
  keeps the schema stable. **Emergent pro:** the save is now fully self-keying
  from the parsed file — a stale or wrong `domain` arg can't misroute the write
  or skew collision detection, strictly more robust than today where the arg
  *is* the write target.
