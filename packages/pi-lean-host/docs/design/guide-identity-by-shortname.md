# Guide Identity by `shortName` — Structural Redesign

> Decision record for moving the guide **identity key** from the directory name
> to the guide's own `shortName`, so that authoring a second guide for a routing
> domain can never silently overwrite a sibling. This is the structurally-clean
> follow-up to the fail-closed overwrite guard shipped as the immediate data-loss
> hotfix.
>
> The motivating bug: a second guide for the same routing domain saved with the
> natural `domain: "coinmarketcap.com"` (== the first guide's folder) targets the
> same `guide.md` and silently replaces the first. The dual role of `domain`
> (routing argument on fetch, identity argument on save) is the root cause; the
> pre-hotfix collision warning fired on the wrong condition (different
> directories) and stayed silent on the dangerous one (same directory, different
> guide). The fail-closed guard in `tools/api-learn.ts` (refuse when the incoming
> `shortName` differs from the guide.md already in the target directory) stops
> that data loss at the moment it would happen; this redesign removes the *class*
> of confusion.
>
> Status: **implemented.** The redesign is implemented — Sprint 1 landed the
> `slug()` helper + loader checks (the divergence check is **enforced**, not
> advisory: a divergent folder routes to `malformed` and does not load until
> renamed), Sprint 2 made the write target a function of `slug(shortName)`.
> It is sequenced ahead of the sibling-artifact
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
redesign removes the *class* of confusion: the write target becomes a function
of the file's own `shortName`, never the tool argument, so the clobber is
impossible by construction.

## Core idea

**The guide's identity is its `shortName`, derived from the file content. The
write target is a function of `slug(shortName)`, never the `domain` argument.
The invariant `dir === slug(shortName)` makes the folder name and the shortName
two views of the same identity — enforced at save time and at load time.**

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

### Why invariant-enforcement instead of loader re-keying

An earlier draft of this redesign proposed re-keying `LoadedApiGuides.guides`
from the folder name to `shortName`, carrying the folder on a new `guide.dir`
field, and detecting duplicate shortNames at load as a malformed condition.
That approach works but introduces permanent machinery — a new type field, a
`findGuidesByDomain` signature change, and a load-time duplicate detector with
`readdirSync`-order nondeterminism — all to catch a condition that the
invariant makes structurally impossible in steady state.

Under the invariant approach, the loader **continues to key by folder name**
(unchanged), and the folder name *is* `slug(shortName)` in steady state, so
keying-by-folder and keying-by-shortName are the same thing. No `guide.dir`
field, no `findGuidesByDomain` change, no permanent duplicate detector, no
co-located test re-keying. The load-time surface shrinks to a **divergence
check** (permanent — the standing invariant monitor) plus the
**illegal-shortName check** (permanent — guards hand-edited or restored-backup
guides the same way the divergence check guards hand-edited folders) and one
**temporary startup check** (the duplicate-shortName check, migration-window
only, marked for 0.5.0 deletion). The clobber-impossible property is
identical; the code surface is smaller.

## What changes, and what does not

### Changes (blast radius)

1. **`loadApiGuidesFromDir`** (`core/parse-api-guide.ts`) — **no re-keying**.
   The record key stays `entry` (the folder name). Three checks are added after
   a successful parse:
   - **Divergence check (permanent, enforced):** if `entry !== slug(parsed.guide.shortName)`,
     route to `malformed` with a prescriptive error naming the current folder,
     the required folder (`slug(shortName)`), and the migration instruction (see
     Migration). The guide does NOT load until the folder is renamed — the
     coupling is enforced, not advisory. This is the standing invariant monitor:
     it catches hand-edited folder names, restored backups, and pre-redesign
     folders that haven't been migrated yet, and guarantees at most one loaded
     guide per shortName.
   - **Duplicate-`shortName` check (temporary, remove in 0.5.0):** if two
     folders declare the same `shortName`, emit a warning naming both folders
     and suggesting `/api delete <one>`. In steady state (after migration) this
     is unreachable because two folders can't share `slug(shortName)`. It exists
     only for the migration window where pre-redesign folders may collide.
     `// TODO(0.5.0): remove — save-time slug() makes duplicate shortNames
     // unreachable once all folders are migrated.`
   - **Illegal-`shortName` check (permanent):** if `slug(shortName)` throws
     (empty or all-symbol `shortName`), push to `malformed` with a
     prescriptive "set a valid `shortName`" error. This is permanent, not
     migration-window: a hand-edited or restored-backup `guide.md` with
     `shortName: "!!!"` reaches disk by a path save-time `slug()` never gates
     — the same class of drift the permanent divergence check guards for
     folder names. No `// TODO(0.5.0): remove` marker.
2. **`api-learn` save path** (`tools/api-learn.ts`) — write target becomes
   `join(guidesDir, slug(parsed.guide.shortName), "guide.md")`, derived from the
   parsed draft. The `domain` arg becomes **purely cosmetic on the save branch** —
   it no longer selects the folder *and* no longer feeds collision detection (the
   collision loop iterates `parsed.guide.domains`, the file's own routing keys,
   not the arg; see item 5 for the comparison re-key). Its only remaining save-
   path uses are error/display context (`parseApiGuide({filename: domain})`) and
   the `details.domain` field. The fetch-recipe advice about "pass the directory
   name as `domain` on re-save" is removed — a re-save self-keys off its own
   `shortName` and naturally lands back in the same folder. **Four user-visible
   strings that still name `domain` (or `dirName` as a save arg) must be
   rewritten to name the actual write target** (`slug(shortName)`): the result
   line `"saved to .../${domain}/guide.md"` (and the `Domain: ${domain}` line
   beneath it), the collision-warning message (covered in item 5), the
   overwrite-guard advice (covered in item 5), and the `api-fetch`
   ambiguous-operation advice that tells the author to re-call
   `api-learn({domain: "${first.dirName}", ...})` (the `domain` arg is no longer
   load-bearing on save). A stale or wrong `domain` arg can no longer misroute
   the write or skew collision detection — strictly more robust than today,
   where the arg *is* the write target.
3. **`slug()`** — new small sanitizer in `core/path-template.ts` (the path-safety
   module already owns `assertSafeDomain` — keep one safety surface): lowercase,
   replace non-`[a-z0-9-]` with `-`, collapse repeats, strip leading/trailing
   `-`, reject empty / path-traversal results. Reuse `assertSafeDomain` as the
   final safety check on the slug so the existing guard covers both domains and
   slugs.
4. **`stagingPathFor`** (`tools/api-learn.ts`) — rekey off `slug(shortName)`,
   which **is** the new `dirName` (fetch-recipe case has the `shortName` in
   hand). The new-template case has only a placeholder `shortName`, so templates
   continue to stage under the requested `domain` until the author fills
   `shortName`; staging is a /tmp draft concern, never data loss, so this partial
   rekey is acceptable. **Pinning this firmly as `slug(shortName)` (not just
   "off `shortName`") is load-bearing for the follow-up scaffold PR**: it makes
   the scaffold doc's "key staging by `dirName`" section inherited rather than
   re-decided, so that section can be deleted there outright.
5. **Collision-warning logic** (`tools/api-learn.ts` save path) — the warning
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
   not `domain`) — render the slug there instead.

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

- **Loader record key** — stays `entry` (the folder name). Under the invariant
  `dir === slug(shortName)`, the folder *is* the slug, so keying-by-folder is
  keying-by-identity. No `guide.dir` field, no `findGuidesByDomain` signature
  change, no `buildDomainMap` change, no co-located test re-keying.
- **`findGuidesByDomain`** (`core/guide-store.ts`) — unchanged. `dirName: name`
  stays honest because `name` (the folder) *is* `slug(shortName)` in steady
  state.
- **Secrets store** — keyed on `canonicalStoreDomain(guide) = guide.domains[0]`
  (`core/auth.ts`), **not** on the folder. Relocating a guide's folder does not
  move its secrets; `/api secrets coinmarketcap.com` keeps feeding both guides
  regardless of their folder names. **No secret migration.**
- **`api-fetch` operation resolution** — resolves ops by name across all guides
  matching the routing domain; helper routed by `dirName` (the folder), which
  `findGuidesByDomain` still returns. Unchanged behavior.
- **`local-helpers.ts`** — locates `helper.ts` via `dirName` (the folder). No
  logic change; `ctx.domain = dirName` transform semantics preserved.
- **Disambiguation menu** — already lists by `shortName`; the surface is
  consistent.
- **`/api delete`** — deletes by directory + `invalidateCache()`s. Still works;
  the directory is now `slug(shortName)` but the delete command takes whatever
  directory name is shown.
- **`dirName` consumers** — `api-fetch.ts`, `local-helpers.ts`,
  `verify-command.ts`, `delete-command.ts`, `guide-picker.ts`, `helpers.ts`,
  `auth.ts` all destructure `dirName` from `findGuidesByDomain`, which is
  unchanged. No audit needed; no consumer reads the folder from the record key
  differently than before.

## Migration of existing user guides

Guides saved before the change live at `<domain>/guide.md` (e.g.
`api-guides/coinmarketcap.com/guide.md` with `shortName: cmc`). After the change
they route to **malformed** until renamed — the **divergence check** is enforced,
not advisory: a folder `coinmarketcap.com` whose guide declares `shortName: cmc`
(required folder `cmc`) does not load, and the malformed entry is prescriptive
(names the required folder). The active set structurally holds at most one guide
per shortName from day one.

**Migration is agent-assisted, not code-driven.** The divergence error tells
the user the current folder, the required folder (`slug(shortName)`), and — for
the 0.4.0 release only — instructs the user to ask their agent to rename the
folder (`mv api-guides/coinmarketcap.com api-guides/cmc`), then `/reload`. We
normally discourage agents from directly modifying guides, but for a one-time
folder rename this is lower-risk than adding auto-migration code and simpler
than teaching the user a manual `/api` subcommand. The agent has bash and can
handle a collision naturally: if the target folder already exists (e.g. the
user already re-saved, creating `cmc/`), the agent sees the existing folder and
`/api delete`s the old one instead of renaming. We outsource the edge-case
handling rather than encoding it.

The `/reload` instruction in the warning is load-bearing: an external `mv`
doesn't call `invalidateCache()`, so the in-memory `LoadedApiGuides` is stale
until the next `session_start` or `/reload`.

**Duplicate shortNames during the migration window** (two pre-redesign folders
both declaring `shortName: cmc`) are caught by the temporary duplicate-shortName
startup check, which names both folders and suggests `/api delete <one>`. Once
all folders are migrated, this check is unreachable and is removed in 0.5.0.

**Options considered:**

- **A. Lazy, agent-assisted (recommended).** Old folders route to malformed
  until renamed; the user asks their agent to rename the folder, then `/reload`.
  Minimal code (the divergence + illegal-shortName checks + one temp duplicate
  check), no read-side mutation. Cost: one agent-assisted rename per
  non-compliant guide, enforced (the guide is not live until renamed).
- **B. Auto-migrate on first load.** `mv <domain>/ → <slug(shortName)>/` when
  the folder name ≠ `slug(shortName)`. Transparent to the user, but **mutating
  user dirs on read** is surprising and races a concurrent `api-fetch` reading
  the same folder. Rejected.
- **C. Ship a one-time migration command.** `/api migrate` or a startup sweep
  that renames folders in place with no live readers. More machinery than the
  problem warrants at current user-guide volume, and the agent-assisted path
  already covers it without a new command.

Recommend **A**; revisit **C** only if divergence-warning reports accumulate
faster than users act on them.

## Edge cases & new failure modes

- **Slug collisions.** Two shortNames that slug to the same value (e.g.
  `cmc_full` and `cmc-full`) target the same folder. The save path detects the
  pre-existing `guide.md` with a different `shortName` and refuses (the hotfix
  guard, retained and repurposed). Real but small — `shortName` is author-chosen
  and human-readable, so slug collisions are visible and fixable by renaming one
  guide's `shortName`.
- **Empty / unsafe `shortName`.** `slug()` must produce a non-empty, traversal-
  safe result. An empty or all-symbol `shortName` → slug is empty →
  `assertSafeDomain` throws → save refuses with a prescriptive error. At load
  time, the permanent illegal-shortName check catches the same condition for
  guides that reach disk with an empty or all-symbol shortName (hand-edited or
  restored backup, not just pre-redesign).
- **Divergent folder name.** `entry !== slug(shortName)` — the permanent
  divergence check routes to malformed. Causes: pre-redesign folder not yet
  migrated, hand-edited folder name, restored backup. The guide does not load
  until the folder is renamed; the malformed error is prescriptive (names the
  required folder).
- **Duplicate `shortName` across folders (migration window only).** Two
  pre-redesign folders declaring the same `shortName`. The temporary duplicate
  check warns and names both folders. In steady state this is unreachable (two
  folders can't share `slug(shortName)`). Removed in 0.5.0.

## Pros

- **Clobber structurally impossible**, not guarded-against. No guard to forget,
  no flag to pass, no manual to read.
- **Kills the dual-role `domain` confusion** (routing vs. identity) that caused
  both the save clobber and the staging collision. `shortName` is the single
  identity axis; `domains:` stays the single routing axis.
- **Enforces `shortName` uniqueness by construction** — save-time `slug()`
  makes two guides with different shortNames physically unable to share a
  directory; the retained overwrite guard refuses slug collisions at write
  time.
- **Re-save self-keys** — the fetch-recipe "pass the directory name" advice
  disappears; a guide naturally lands back in its own folder.
- **Smaller code surface than re-keying** — no `guide.dir` field, no
  `findGuidesByDomain` change, no co-located test re-keying. The load-time
  surface is a permanent divergence check, a permanent illegal-shortName
  check, and one temporary check (duplicate-shortName) with a 0.5.0 deletion
  date.
- **No secret-store migration, no auth change, no transport change, no routing
  change.** Blast radius is `slug()` + the `api-learn` write target + the
  divergence/temp checks + four string rewrites.

## Cons / costs

- **Storage-layout change.** Existing user guides need a one-time folder rename
  (agent-assisted) if their folder name doesn't match `slug(shortName)`.
  Divergent guides are not live until renamed (enforced), so the migration is a
  per-guide cleanup action with a hard — but prescriptive — read-time signal.
- **New `slug()` surface.** Trivial but real: a sanitizer with its own edge
  cases (slug collisions, empty result, unicode). Reusing `assertSafeDomain` as
  the final guard keeps the safety story to one function.
- **Temporary startup check.** The duplicate-shortName check is migration-
  window scaffolding marked for 0.5.0 deletion. It adds a small amount of code
  that is intentionally self-deleting; the 0.5.0 removal must not be forgotten.
  (The illegal-shortName check is permanent — see Edge cases.)
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
   detector" (see blast-radius item 5), but stays.
2. **Next (this redesign):** implement the structural change in two sprints —
   Sprint 1: `slug()` + loader checks (divergence + illegal-shortName + temp duplicate check);
   Sprint 2: `api-learn` write target + collision warning re-key + guard advice
   - string rewrites + test updates. Ship migration **A** (lazy,
   agent-assisted folder rename).
3. **0.5.0:** remove the temporary duplicate-shortName startup check. The
   permanent divergence and illegal-shortName checks stay as the standing
   invariant monitors.
4. **Later (only if needed):** revisit auto-migration (**B** or **C**) if
   divergence-warning reports accumulate; otherwise leave it.

The hotfix already closes the data-loss hole today. The redesign earns its
keep as a follow-up because it removes the whole class of confusion rather than
patching one symptom — but it's not the fix for a live data-loss bug.

## Forward note for the scaffold PR (`api-verify-scaffold.md`)

This redesign is sequenced ahead of the sibling-artifact authoring doc
(`api-verify-scaffold.md`) and pays down two of its costs so the follow-up PR
is smaller:

- **Staging-path keying is already decided here.** That doc's "Staging path
  keying" section (rekey `/tmp` from routing `domain` → `dirName`) is inherited
  by this redesign's blast-radius item 4 (`stagingPathFor` keys off
  `slug(shortName)`, which *is* the new `dirName`). The scaffold PR should
  **delete that section outright** rather than re-deciding it.
- **The deletion-safety gate's wipe surface shrinks.** That doc motivates its
  mirror-save deletion-safety gate with two wipe windows: `new: true` saved
  over an existing directory that has siblings, and accidental `/tmp` cleanup.
  Under shortname-identity the first window shrinks to near-zero: a
  `new: true` template has a placeholder `shortName`, so its save target is
  `<slug(placeholder)>/`, which won't collide with a real guide's folder unless
  the author fills in an existing `shortName` — and that's caught by the
  shifted overwrite guard (blast-radius item 5). The scaffold PR therefore only
  needs to guard the accidental-`/tmp`-cleanup case, not the
  `new: true`-over-existing case. Half the gate's motivation, pre-paid.

## Resolved decisions

- **Invariant: `dir === slug(shortName)`, not `dir === shortName`.** The folder
  is always lowercase-safe (the slug forces lowercase); the `shortName`
  frontmatter field keeps its display casing (e.g. `GitHub`). Requiring exact
  equality would force the `shortName:` field to lowercase, a tighter
  authoring constraint for no gain. With `dir === slug(shortName)`, two
  shortNames that differ only by case (`GitHub` and `github`) slug to the same
  folder → can't coexist → overwrite guard refuses. The clobber-impossible
  property holds; the authoring surface stays loose.
- **Invariant-enforcement over loader re-keying.** The loader continues to key
  by folder name; the invariant makes folder and `slug(shortName)` equivalent
  in steady state. This avoids a permanent `guide.dir` field, a
  `findGuidesByDomain` signature change, a permanent duplicate detector with
  `readdirSync`-order nondeterminism, and co-located test re-keying — all of
  which the earlier re-keying draft required. The clobber-impossible property
  is identical; the code surface is smaller.
- **Permanent divergence + illegal-shortName checks; temporary duplicate
  check.** The divergence check (`entry !== slug(shortName)`) and the
  illegal-shortName check (`slug(shortName)` throws → `malformed`) both stay
  as standing invariant monitors — both guard hand-edited or restored-backup
  guides that reach disk by a path save-time `slug()` never gates. The
  divergence check is **enforced** (routes to `malformed`, so the active set
  structurally holds at most one guide per shortName); the illegal-shortName
  check is enforced the same way. The duplicate-shortName check is
  migration-window-only, marked `// TODO(0.5.0): remove`, because save-time
  `slug()` plus the folder-name-is-`slug(shortName)` invariant make two
  folders with the same shortName unreachable once all folders are migrated.
- **Agent-assisted migration.** The divergence error instructs the user to
  ask their agent to `mv` the folder, then `/reload`. Not auto-migration
  (option B/C rejected). The agent handles collision-on-rename naturally
  (existing target → `/api delete` the old folder); we outsource the
  edge-case handling rather than encoding it. The `/reload` instruction is
  load-bearing because an external `mv` doesn't call `invalidateCache()`.
- **`slug()` forces lowercase.** Filesystem-safe default, matches typical slug
  conventions. Cost: `CMC` and `cmc` collide (accepted — author-chosen
  `shortName`s in existing recipes are already lowercase, so no real-world
  break). Revisit only if a case-sensitive identity is wanted.
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
  file's own keys, not the arg — see blast-radius item 5). Its only remaining
  save-path uses are error/display context (`parseApiGuide({filename: domain})`,
  the `details` field). Making it optional-on-save is deferred to the scaffold
  PR, which already reworks the save signature (`recipeFile` → `dir`); this PR
  keeps the schema stable. **Emergent pro:** the save is now fully self-keying
  from the parsed file — a stale or wrong `domain` arg can't misroute the write
  or skew collision detection, strictly more robust than today where the arg
  *is* the write target. (One edge caveat: when `shortName:` is *absent* from
  the draft, the parser defaults `shortName` to `filename` = `domain`, so
  `slug(domain)` becomes the save target — the arg indirectly selects the
  folder in that case. Unreachable for saved guides: the placeholder template
  always includes `shortName:`, so the redesign does not defend against it.)
