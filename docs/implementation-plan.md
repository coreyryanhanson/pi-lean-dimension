# pi-tool-masking — Implementation Plan

> Source of truth: [`design.md`](./design.md). This plan operationalizes it.
> Status: **`pi-tool-masking@1.0.0` published on npm.** The v1 surface was
> verified against two real consumers before publishing: `pi-lean-dimension`
> (portal + search, migrated on the `refactor/break-out-masking-tool`
> branch) and `pi-tbox` (the user-facing manager, §13 — built and published
> as `pi-tbox@0.0.1`). The portal/search migration is code-complete but
> **not yet merged to `main` or released as `0.3.0`** — Sprint 7 (version
> bump + release) is the remaining work. Host rebase (Sprint 8) is still
> pending.

## Scope & sequencing

**Done — library:** built the `pi-tool-masking` library (`initial-commit`
branch), ran a review, applied the documented fixes, and **published
`pi-tool-masking@1.0.0`** to npm.

**Done — manager (`pi-tbox`):** the user-facing manager extension
(§13 in design.md) was built as a separate repo, `pi-tbox`, and
**published as `pi-tbox@0.0.1`**. It depends on `pi-tool-masking`,
exercises the globalThis registry convergence (`getRegisteredToolsets`
across module copies), and validates the `changed`/`restored` event
split and `setDefaultResolutionMode` against a real pi extension
lifecycle — catching integration bugs the library's own MockPI tests
cannot. It was the second verification consumer before the library
locked to v1.

**Pending (in the `pi-lean-dimension` monorepo):** merge the
`refactor/break-out-masking-tool` branch (portal + search migration)
into `main` and cut the `0.3.x` release. The migration is code-complete
on that branch; `main` itself still carries the pre-migration
`browser-toggle.ts`.

**Out of scope (host):** `pi-lean-host` is *not* migrated in this plan. The
`feat/pi-lean-host` branch is used only as (a) a code reference when porting
the shared toggle logic, and (b) a rebase target — Sprint 8 verifies it rebases
cleanly onto the updated `main`. Host's own migration ships later as `0.4.x`.

**Why this order:** main has no host package, so it is the smaller, cleaner
migration and lands the library + invariant in one place first. The host
branch then rebases onto a main that already depends on `pi-tool-masking`, so
its eventual migration is a single-package change rather than a foundational
one. The manager (`pi-tbox`) was built and used to verify the surface before
the library locked to v1.

### Repos & branches at a glance

| Repo | Branch | Role | Status |
|------|--------|------|--------|
| `pi-tool-masking` | `initial-commit` | Library implementation | ✅ **published `1.0.0`** |
| `pi-tbox` | `main` | User-facing manager extension (§13) | ✅ **published `0.0.1`** (verification consumer #2) |
| `pi-lean-dimension` (monorepo) | `refactor/break-out-masking-tool` | Portal + search migration → `0.3.0` | ✅ migrations code-complete, **not merged to `main`; release pending (Sprint 7)** |
| `pi-lean-dimension` (monorepo) | `main` | Pre-migration baseline | ⏳ awaits merge of the migration branch |
| `pi-lean-dimension` (monorepo) | `feat/pi-lean-host` | Reference + rebase check only | ⏳ pending (Sprint 8) |

### Versioning

- Library: `pi-tool-masking` shipped **`1.0.0`** on npm (stable v1 API
  surface per §5; the persist schema and `DefaultResolutionMode` are
  frozen from v1 per §4.5/§7).
- Manager: `pi-tbox` shipped **`0.0.1`** on npm — built and used to
  verify the globalThis registry convergence and event surface against a
  real pi extension lifecycle before the library locked to v1.
- Consumers (pending): portal + search + dimension bump `0.2.4 → 0.3.0`
  and pin `pi-tool-masking` as a required `peerDependency` (`^1.0.0`) —
  the pin is already on the `refactor/break-out-masking-tool` branch
  (under `peerDependencies`, alongside the other pi-ecosystem peers);
  the bump + release is Sprint 7.
- Host (later, out of scope): `0.4.0` when it migrates.
- Lockstep across the five repos (pi-tool-masking + portal + host +
  search + pi-tbox) via the monorepo's `scripts/sync-versions.js`
  discipline (extended to cover the new external dep — see Sprint 7).

### Current main-branch baseline (verified, still the migration starting point)

- `packages/pi-lean-portal/browser-toggle.ts` — 497 lines, owns toggle +
  restore + `setSearchSlot` reach-through + `SIBLING_TOOL_NAMES`.
- `packages/pi-lean-portal/__tests__/browser-toggle.test.ts` — 80 tests.
- `packages/pi-lean-portal/__tests__/browser-toggle-profile.test.ts` — 14 tests.
- `packages/pi-lean-search/index.ts` — 260 lines, owns `search` glyph + health
  probe + `session_shutdown` cleanup.
- One `settings-reader.ts` at `packages/pi-lean-portal/core/shared/`.
- No `pi-lean-host` on `main`.
- All three published packages at `0.2.4`.

---

## Completed — Sprints 0–4 (library)

All four library sprints shipped on the `initial-commit` branch. `npm test` is
green: **84 tests across 2 files** (`core.test.ts`, `registry-convergence.test.ts`).
What each sprint delivered:

### Sprint 0 — Library scaffolding ✅

A loadable, source-only TypeScript package (`package.json`: `name:
"pi-tool-masking"`, `version: "1.0.0"`, `type: "module"`, no default factory,
no `extensions/` manifest, no `pi-package` keyword). `tsconfig.json` mirrors
the monorepo's strict flags (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `module: "nodenext"`, `isolatedModules`,
`moduleDetection: "force"`, `noUncheckedSideEffectImports`, `noEmit: true`).
`index.ts` exports the full §5 surface. The test harness `__tests__/mock-pi.ts`
ships a `MockPI` implementing the masking-relevant `ExtensionAPI` subset:
`setActiveTools` / `getActiveTools` / `getAllTools` (returns `ToolInfo[]`
objects, not strings) / `appendEntry` (records writes keyed by `customType`) /
`on` / `events` (a real Node `EventEmitter`) / `registerTool`, plus
`sessionManager.getBranch()` returning the recorded `SessionEntry[]`. Restore
reads via `ctx.sessionManager.getBranch()` — `ExtensionAPI` has no `readEntry`
counterpart to `appendEntry` — so the mock exposes `getBranch()`, not a
fictional `readEntry`.

### Sprint 1 — Core primitives ✅

`defineToolset` / `enable` / `disable` / `isEnabled` with the §9
peer-composition invariant and the §6.1 globalThis registry + collision policy.
Registry on `globalThis.__piToolMaskingRegistry`, idempotent init, keyed by
`spec.id`. Collision policy throws on a duplicate `spec.id` (different spec)
and on a duplicate `persistKey`, but is **idempotent by content** for
`deepEqual`-identical re-registration (the `/reload`/`/resume` case — returns
the existing handle, no throw). `enable` is additive
(`[...new Set([...current, ...registered])]`, `registered = spec.names ∩
getAllTools()`); `disable` filters `spec.names` out of `getActiveTools()` (not
`getAllTools()`). Both idempotent. Tests: peer composition, additive-enable,
disable-uses-getActiveTools, collision throws, idempotent re-registration,
registry idempotency, enable/disable idempotency.

### Sprint 2 — `requires` cascade + default-resolution mode ✅

`enable` transitively enables `spec.requires` (graph walk with visited-stack);
`disable` reverse-cascades to every toolset whose `requires` contains this
one's id. Cycle detection is lazy (first graph resolution, not
`defineToolset` time) — the walk throws on a stack revisit, naming the cycle
path (`A → B → C → A`). Forward-references are allowed (a `requires` id not yet
registered is skipped until it appears). `setDefaultResolutionMode` persists the mode via
`pi.appendEntry("toolset-resolution-mode", { mode })` and
`getDefaultResolutionMode` reads the module state (which may have been
restored from the branch on a fresh process). Default `"exclusion"`. Tests: dependency cascade (all four §9 directions),
cycle throw with path, forward-reference, mode set/get, no-path-yields-
`L.enabled && !B.enabled`.

### Sprint 3 — Restore, events ✅

The `session_start` / `session_tree` restore handler (registered in Sprint 1,
bodied here): at the top of `doRestore`, read the persisted resolution
mode from the branch (`"toolset-resolution-mode"` entry) before the
per-toolset loop — this sets `defaultResolutionMode` for the entire
restore; then, per registered toolset, read `spec.persistKey` from
`ctx.sessionManager.getBranch()`; an entry → apply its `enabled`, emit
`restored`; no entry → resolve `spec.defaultEnabled` under exclusion mode or
`false` under inclusion mode, apply, emit `changed`, and **do not call
`appendEntry`** (restore never persists a default fallback, §6). Always emits
exactly one event per toolset per restore (the always-emit invariant).
`TOOLSET_EVENTS` (`changed`/`restored`) + `ToolsetChangedEvent` payloads with
optional `emitMemberEvents` per-member fanout. Settings reading is **out
of scope** for the library (§5.1) — consumers keep a local reader
(portal's `core/shared/settings-reader.ts`) and pass the resolved
boolean as `spec.defaultEnabled`. Tests: persistence round-trip, no-entry
restore (exclusion + inclusion), always-emit, the `changed`/`restored`
split, `emitMemberEvents` N+1 fanout, idempotent/last-writer-wins
restore, `session_tree` restore, default-resolution entry-vs-no-entry.

> **Revert note:** Sprint 3 originally shipped a `readMergedSettings`
> utility export on the library. It was removed before v1 shipped — see
> [`revert-settings-reader.md`](./revert-settings-reader.md). The library
> exports no settings reader; do not re-add one (§5.1).

### Sprint 4 — Library test suite complete (§12) ✅

The novel **globalThis registry convergence test**
(`__tests__/registry-convergence.test.ts`): simulates two isolated module
loads against one shared `globalThis` — registers a toolset from copy A,
asserts copy B's registry enumerates it. This is the one mechanism that cannot
be verified by reading code alone. All §12 bullets are covered in this repo;
no invariant test is duplicated in a consumer repo (consumers not yet
migrated — asserted in Sprints 5/6).

---

## Completed — Sprints 5–6 (consumer migration, branch `refactor/break-out-masking-tool`)

Both consumer migrations are code-complete on the
`refactor/break-out-masking-tool` branch (6 commits ahead of `main`, not
yet merged). `main` still carries the pre-migration 497-line
`browser-toggle.ts`. `npx vitest run` across the affected packages is
green: **52 tests across 3 files** (14 portal-toggle + 14 portal-profile +
24 search). What each sprint delivered:

### Sprint 5 — Portal migration ✅

`browser-toggle.ts` collapsed from 497 → 279 lines onto the library per §10.
`pi-tool-masking` added to `packages/pi-lean-portal/package.json` `dependencies`
(pinned `"^1.0.0"`, resolved against the published package). Two toolsets defined:
`portal.web` (`BROWSER_TOOL_NAMES`, `defaultEnabled` read from portal's own
`core/shared/settings-reader.ts` → `browserToggle?.defaultEnabled ?? true` — the
library exports no settings reader, §5.1) and `portal.learn`
(`LEARN_TOOL_NAMES`, `defaultEnabled: false`, `requires: ["portal.web"]`). The
`/web` command dispatches to `enable`/`disable`; `learn` pulls web on via
`requires`, `off` cascades learn off via `requires` — no hand-written
learn↔web coupling. Deleted: `SIBLING_TOOL_NAMES`, `setSearchSlot`, the search
reach-through, `restoreFromBranch`, `applyConfigDefault`, and the
`session_start`/`session_tree` restore wiring (the library owns restore now).
`defaultProfile` persists separately under `portal-conversation-state`
(§7 split). The `browser` glyph renders from the `session_start`/`session_tree`
capture handlers (`syncCachedState` + `renderBrowserGlyph` — the §6
capture-ordering fix). `settings-reader.ts` kept and imported; no inlined
duplicate. Tests: the 80 invariant-duplicating `browser-toggle.test.ts` tests
were replaced with **14 thin integration tests** (MockPI, `/web` dispatch,
glyph render, `portal-conversation-state` split, cached-state sync); the 14
profile tests kept (portal-specific behavior). `npx vitest run
packages/pi-lean-portal` green. `rg setSearchSlot` / `rg SIBLING_TOOL_NAMES`
empty across live code; `rg -i search` empty in `browser-toggle.ts`.

### Sprint 6 — Search migration ✅

Search owns its own `search.web` toolset and co-activates off `portal.web`'s
`changed` event per §10/§10.1. `pi-tool-masking` added to
`packages/pi-lean-search/package.json` `dependencies`. In `index.ts`:
`defineToolset` for `search.web` (`new Set(["web-search"])`,
`defaultEnabled: true`); a co-activation listener on `TOOLSET_EVENTS.changed`
for `id === "portal.web"` calls `enable`/`disable` on the search toolset —
listens on `changed` **only**, not `restored` (§10.1, so a persisted-off
search is not re-mirrored on restart). Glyph listener on `search.web`'s own
`changed`/`restored` events renders the `search` slot; `renderSearchGlyph` is
called from the `session_start`/`session_tree` capture handlers and reflects
`search.web` activation × health color. The `session_shutdown` glyph cleanup
and the SearXNG health probes (server-reachable + full-pipeline, the latter
for `/searxng-status`) were kept. Portal has zero references to search. Tests:
24 in `web-search.test.ts` (`readSearxngUrl` config resolution + `webSearchTool`
shape/execute/render including instant-answer rendering). `npx vitest run
packages/pi-lean-search` green. The §10.1 companion-matrix acceptance criteria
(restart-after-`/web off`, manager-disabled-search restore behavior) were
satisfied by **manual testing** — no regressions found — rather than automated
tests; automated companion-matrix coverage remains a deferred gap.

---

## Pending — Sprint 7 — Version bump, dependency wiring, release prep (`0.3.0`)

**Goal:** cut the `0.3.x` release with `pi-tool-masking` as a required peer dep.

**Work:**

1. ~~Publish `pi-tool-masking@1.0.0` from the `initial-commit` branch.~~
   ✅ Done — `pi-tool-masking@1.0.0` is on npm; `npm view pi-tool-masking`
   shows no `pi-package` keyword and no extension manifest (§14). Skip to
   the consumer release below.
2. Merge `refactor/break-out-masking-tool` into `main`, then bump portal +
   search + dimension `0.2.4 → 0.3.0` (lockstep). The
   `pi-tool-masking: ^1.0.0` pin is already on the branch; dimension's
   `bundledDependencies` picks it up transitively.
3. Extend `scripts/sync-versions.js` if needed so the external
   `pi-tool-masking` dep is kept in lockstep with the published version across
   consumers (the script currently handles intra-monorepo deps only — add a
   pinned-external-dep check or document the manual step).
4. `npm run publish:dry` — inspect tarballs: portal + search + dimension
   include `pi-tool-masking` in their resolved dep tree; the library tarball
   is library-only.
5. Update `CHANGELOG.md` with the `0.3.0` entry: new required peer dep
   `pi-tool-masking`, toggle logic extracted, `session_tree` behavior change
   on entry-less branches (§7.1 — intentional improvement), no legacy
   migration (§8 — old branches reset to defaults; browser state unaffected).

**Acceptance criteria:**

- [x] `pi-tool-masking@1.0.0` is published; `npm view pi-tool-masking` shows
      no `pi-package` keyword and no extension manifest.
- [ ] `refactor/break-out-masking-tool` is merged into `main`.
- [ ] `npm run publish:dry` succeeds; portal/search/dimension tarballs resolve
      `pi-tool-masking` at `^1.0.0`.
- [ ] All three consumer packages report `0.3.0`; `npm run sync-versions` (or
      equivalent) confirms lockstep.
- [ ] `npm test` (full structural suite) is green on `main`.
- [ ] CHANGELOG documents the `session_tree` entry-less-branch behavior change
      and the no-legacy-migration stance.

---

## Pending — Sprint 8 — Verify `feat/pi-lean-host` rebases cleanly

**Goal:** confirm the host branch is not blocked by the main migration — it
should rebase onto the updated `main` with only host-package conflicts
resolvable by reference to the same library.

**Work:**

1. From `feat/pi-lean-host`, `git rebase main` (updated in Sprint 7).
2. Expected conflict surface: `browser-toggle.ts`-adjacent files are not on the
   host branch, so portal/search migrations should apply cleanly; the host
   branch's own `packages/pi-lean-host/core/api-toggle.ts` and
   `core/settings-reader.ts` are untouched by main's migration and should not
   conflict. Where conflicts arise, resolve by reference to the §10 host block
   (the `host.api` / `api-toggle-state` collapse is the *future* 0.4.x work —
   do **not** migrate host here, just make the tree consistent).
3. Run the structural test suite on the rebased branch (host tests auto-skip
   without backends; the portal/search structural tests must stay green).

**Acceptance criteria:**

- [ ] `feat/pi-lean-host` rebases onto updated `main` with no unresolved
      conflicts after resolution.
- [ ] `npm run test:ci` is green on the rebased branch (host contract tests
      auto-skip; structural + portal + search pass).
- [ ] No host source files are modified by the rebase beyond what the rebase
      itself requires — host migration is explicitly deferred to 0.4.x.
- [ ] The rebased branch's `packages/pi-lean-host/core/api-toggle.ts` still
      compiles (tsc clean) — it is the reference for the eventual 0.4.x
      migration, unchanged in behavior.

---

## Cross-cutting acceptance (whole plan)

- [x] The peer-composition invariant (§9) and the `requires` cascade (§4.4)
      have **exactly one** test home: `pi-tool-masking`'s repo. (Confirmed no
      consumer duplication — Sprints 5/6 ship thin integration tests only.)
- [x] `rg "web-toggle-state|api-toggle-state"` across the migration branch
      returns only CHANGELOG/history references — the old persist keys are
      gone from live code (verified post-Sprint 5/6). (On `main` pre-merge the
      old keys are still present — this flips when the branch merges.)
- [x] `rg "settings-reader"` across the migration branch returns the portal
      reader only — the library exports no settings reader (§5.1), and no
      consumer imports `readMergedSettings` from `pi-tool-masking`.
- [x] `globalThis.__piToolMaskingRegistry` is the only cross-instance shared
      surface; toggle actuation remains a static import (§6.1 boundary).
- [x] The restore handler is `/reload`-safe via event-object-identity dedup
      (review Finding 1) — verified by the regression test.
- [ ] `npm test` is green on `main` at `0.3.0` and on `feat/pi-lean-host`
      rebased onto it.

## Out-of-scope reminders (do not accidentally do)

- Do **not** migrate `pi-lean-host` onto the library in this plan (0.4.x).
- The manager extension is **already built** (`pi-tbox@0.0.1`, §13) — do not
  re-build it here; this repo's scope is the library + portal/search
  migration only.
- Do **not** add a `companions: string[]` primitive (§10.1 — one group today).
- Do **not** add a `focus()` verb or `getToggleUnits()` helper (§13.2 — manager
  concerns, owned by `pi-tbox`).
- Do **not** add a legacy persistence migration read path (§8).
- Do **not** tag the library `pi-package` in `keywords` (§14 — verified on the
  published `1.0.0`).
- Do **not** add a settings-reader export (`readMergedSettings` or any
  `settings.json` reader) to the library (§5.1 — see
  `revert-settings-reader.md`). Consumers keep a local reader.
