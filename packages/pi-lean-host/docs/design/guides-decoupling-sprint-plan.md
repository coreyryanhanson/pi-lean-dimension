# Guide Content Decoupling (`keritas`) — Sprint Plan

> Drafted as the executable sprint breakdown for
> [`guides-decoupling-keritas.md`](./guides-decoupling-keritas.md) (the design
> doc — the decision record for splitting the recipe/guide content out of
> `pi-lean-host` into a separate `keritas` repo). This doc is the *how/when*,
> not the *what/why*; read the design doc for rationale, the schema-versioning
> lifecycle, the axis-set membership criteria, and the drift disclaimer.
>
> The design doc's [Rollout / next steps](./guides-decoupling-keritas.md#rollout--next-steps)
> section gives the intended order in six steps. This plan decomposes those
> steps into sequenced sprints with concrete acceptance criteria.

## What ships

- **`GUIDE_SCHEMA_VERSION = 0`** constant + `schemaVersion: 0` frontmatter on
  guides + a `schema-version.test.ts` regression guard proving the field is
  metadata-only (never gates/warns/alters parse) — closes the design doc's
  schema-version gap.
- **A finalized axis-guide set** (~5–7 synthetic minimal guides) plus an
  enforced `axis-coverage.test.ts` guard that asserts the kept union covers
  every guide-driven framework axis.
- **Synthetic axis guides + mocked-transport tests** in `pi-lean-host` (new,
  deterministic, no live network) replacing the live `endpoint-coverage.test.ts`
  coverage that moves out with the real recipes.
- **The `keritas` repo** holding every non-axis recipe + `_shared/`
  (`test-harness.ts`, `probe-op.ts`) + `WAF-NOTES.md` + `CONTRIBUTING.md` +
  a README owning the perpetual drift disclaimer.
- **An `exports` map on `pi-lean-host`** so keritas can import framework
  helpers as package imports (`pi-lean-host/core/helpers.js`) instead of
  relative paths — the migration the design doc's Risks section flags.
- **keritas CI** — per-PR (parse-validity + mocked-transport
  `transform.test.ts`/`helper.test.ts` that moved with the guides) and nightly
  live (`HOST_INTEGRATION=1`) — + README drift disclaimer.
- **At lockstep:** removal of the README unstable disclaimer + a CHANGELOG
  line declaring schema v1 (label change, not a break).
- **Documentation cleanup** in host `AGENTS.md` + `README.md` removing stale
  `api-guides/` tree / `_shared/` / `HOST_INTEGRATION` references.

## Sprints

| Sprint | Contents | Gated on | Network? |
|--------|----------|----------|----------|
| 1 | `GUIDE_SCHEMA_VERSION = 0` + `schemaVersion: 0` frontmatter + `schema-version.test.ts` | none | no |
| 2 | Feature-coverage audit → finalize axis-set membership | none (research) | no |
| 3 | Author synthetic axis guides + mocked-transport tests + `axis-coverage.test.ts` guard | 2 | no |
| 4 | Add `exports` map to `pi-lean-host`; move non-axis content to `keritas` repo; migrate import paths | 3 + a published `pi-lean-host` with the `exports` map | no |
| 5 | Stand up keritas CI (per-PR parse + mocked-transport; nightly live) + README drift disclaimer | 4 | no (per-PR) / yes (nightly) |
| — | **Lockstep gate:** remove README unstable disclaimer, declare schema v1 | 5 + lockstep release of `pi-lean-dimension` 0.5.0 | — |
| 6 | Documentation cleanup in host `AGENTS.md` + `README.md` | 4 | no |

Sprints 1 and 2 are independent and may run in parallel (one is a small code
change, the other is a read-only audit). Sprint 3 is gated on the audit's
finalized axis set. Sprint 4 (the move) is gated on Sprint 3 so host stays
green by construction the whole time — the synthetic axis guides and their
mocked-transport tests are in place *before* the real recipes leave. Sprint 5
is gated on the move. The lockstep gate is gated on Sprint 5 (keritas nightly
live tests are the drift signal that makes it safe to drop the unstable
disclaimer). Sprint 6 (doc cleanup) is gated only on the move, not on
lockstep — it can land any time after Sprint 4.

---

## Sprint 1 — Schema version constant + metadata-only guard

**Goal:** introduce `GUIDE_SCHEMA_VERSION = 0` in `core/api-guide-types.ts`,
accept (and preserve) a `schemaVersion` frontmatter field on guides, stamp
`schemaVersion: 0` on the existing guides, and add `schema-version.test.ts`
asserting the field is pure metadata — it never gates, warns, or alters parse
behavior. This closes the design doc's schema-version gap (the only
structural-axis gap) and is the regression guard for the central coupling
answer.

**Gated on:** nothing. Small, shippable alone.

### Tasks

1. Add `export const GUIDE_SCHEMA_VERSION = 0 as const;` to
   `core/api-guide-types.ts`. Add an optional `schemaVersion?: number` field
   to the parsed-guide type (the parser reads it from frontmatter; absent
   defaults to `0`). No parser behavior changes on its presence or value.
2. Confirm `parseApiGuide()` surfaces `schemaVersion` on the parsed guide
   when present and leaves it `undefined` when absent — and that *nothing*
   in the parse path branches on it (no validation, no warning, no reject).
   If the frontmatter is not yet consumed, wire the read without gating.
3. Stamp `schemaVersion: 0` in the frontmatter of every existing
   `api-guides/<domain>/guide.md`. (Mechanical; one line per guide. Carries
   no compatibility guarantee during beta — see the design doc's lifecycle.)
4. Write `__tests__/schema-version.test.ts`:
   - `GUIDE_SCHEMA_VERSION` is `0` and exported.
   - A guide parses identically with `schemaVersion: 0`, with it absent,
     and with a forward value (e.g. `999`) — same operations, same auth,
     same parse result. The field never raises, warns, or changes output.
   - A guide with a malformed `schemaVersion` (non-integer) is handled per
     the existing frontmatter-coercion policy — assert it does *not* become
     a parse gate (either tolerated or a standard frontmatter-type error,
     not a schema-version-specific rejection).

### Sprint 1 exit criteria

- `npm run test:ci` green (no network).
- `GUIDE_SCHEMA_VERSION` exported; every guide carries `schemaVersion: 0`.
- `schema-version.test.ts` proves metadata-only behavior across
  present/absent/forward/malformed cases.
- No parser branch keyed on `schemaVersion` value (grep-clean).

---

## Sprint 2 — Feature-coverage audit → finalize axis set

**Goal:** run the design doc's
[audit procedure](./guides-decoupling-keritas.md#deferred-axis-set-membership-tbd)
against the current 23 real guides and produce the finalized axis-guide
membership list — the synthetic minimal guides that will stay in host. This
is a read-only research sprint: no code or guide content changes.

**Gated on:** nothing. Pure analysis.

### Tasks

1. Enumerate the guide-driven framework feature axes from the design doc's
   [Test axes](./guides-decoupling-keritas.md#test-axes-the-audits-dimension-list)
   table (the eight guide-driven rows: `exec-restGet`, `exec-paginate`,
   `xml-parsing`, `transform-builtin`, `local-helper`, `static-key-auth`,
   `transport`, `ssrf-guard`, `multi-recipe-domains`).
2. For each current real guide, record which axes its ops exercise
   (frontmatter `via`/`auth`/`parse`/`helper`/`transform` + `helper.ts`
   presence + pagination style). Produce a guide × axis coverage matrix.
3. Propose the minimal union of synthetic guides covering every axis — one
   axis per guide where practical (the design doc prefers small groupings
   over multi-axis guides for regression isolation). Start from the design
   doc's working candidate (six synthetic guides echoing the feature spread
   of boe.es, earthquake.usgs.gov, api.github.com, archive.org +
   archive.org-wayback, services.dnb.de) and adjust per the audit.
4. For each proposed synthetic guide, record: the axis(es) it covers, the
   fewest ops needed to hit them, and the mocked-transport fixture shape
   (the stubbed response(s) the test will feed). Confirm no axis is covered
   by exactly one *multi-axis* guide where a single-axis guide would do
   (regression-isolation check).
5. Confirm the multi-recipe axis-guide pair (archive.org +
   archive.org-wayback, two synthetic guides claiming one domain) exercises
   `api-fetch` operation-name dispatch across both — the guide-driven
   coverage of `multi-recipe-domains`.

### Sprint 2 exit criteria

- A committed `docs/design/axis-set-audit.md` recording: the guide × axis
  matrix, the finalized axis-set membership (the synthetic guides to author
  in Sprint 3), and per-guide axis + fixture-shape notes.
- Every guide-driven axis in the Test axes table is covered by ≥1 proposed
  synthetic guide; the coverage is not silently lost by the split.
- The multi-recipe dispatch pair is named explicitly.

> This sprint is the design doc's deferred decision. Its output
> (`axis-set-audit.md`) is the input to Sprint 3.

---

## Sprint 3 — Author synthetic axis guides + mocked-transport tests + coverage guard

**Goal:** land the finalized axis-guide set in `pi-lean-host` with
deterministic mocked-transport tests (no live network), and add
`axis-coverage.test.ts` — the structural guard that promotes the Sprint 2
audit to an enforced invariant. After this sprint, host's guide-driven
coverage no longer depends on the real recipes, so the move in Sprint 4
cannot silently drop a feature axis.

**Gated on:** Sprint 2 (the finalized axis set).

### Tasks

1. For each synthetic guide in the audit, author
   `api-guides/<domain>/guide.md` — minimal ops hitting its axis(es) against
   mocked transport. No `verified:` date (these are coverage fixtures, not
   real recipes). No live endpoint.
2. Write a co-located mocked-transport test per axis guide: stub the
   `fetch`/transport layer with fixed response fixtures and execute each op
   through the real `restGet`/`paginate` pipeline, asserting the
   axis-specific behavior (e.g. the XML guide asserts `itemsPath` resolves
   on the stubbed XML body; the transform guide asserts the transform runs
   and `failedItems` routing on throw; the multi-recipe pair asserts
   operation-name dispatch across both guides). These are **new tests with
   stubbed fetch**, not adaptations of the existing live `itWhen` tests —
   the live `endpoint-coverage.test.ts` files move to keritas with the real
   recipes in Sprint 4.
3. Add `__tests__/axis-coverage.test.ts`:
   - Enumerate the guide-driven axes (same list as Sprint 2).
   - Assert the kept axis-set union covers every axis — by reading each
     axis guide's ops and matching them to axes (the same matrix Sprint 2
     produced, now encoded as a test). Removing an axis guide or dropping
     an axis-exercising op fails this test.
   - Assert each axis guide parses under `all-guides-parse` and that the
     set size matches the audit's finalized count.
   - **Role clarity:** the mocked-transport tests (task 2) are the *real*
     coverage proof — they execute ops and assert axis-specific behavior.
     `axis-coverage.test.ts` is a **regression tripwire** against silent
     axis-guide removal, not a proof of coverage on its own (a guide can
     declare a flag while the behavior is malformed — only the
     mocked-transport test catches that). Both layers are required.
   - **Assert specific flag combinations per axis**, not just flag presence,
     to prevent single-`via` coverage holes — e.g. require at least one op
     with `transform: true` AND `via: restGet` *and* at least one with
     `transform: true` AND `via: paginate`, rather than "some op somewhere
     has `transform: true`". Same for pagination styles and auth kinds.
4. Confirm `all-guides-parse` still green over the *expanded* guide set
   (real recipes still present + new synthetic guides added).

### Sprint 3 exit criteria

- `npm run test:ci` green (no network).
- Every synthetic axis guide parses and executes against mocked transport
  with no live calls.
- `axis-coverage.test.ts` fails if any guide-driven axis loses coverage.
- `all-guides-parse` green over the full set (real + synthetic).

---

## Sprint 4 — Add `exports` map; move non-axis content to `keritas`; migrate import paths

**Goal:** the actual split. Add an `exports` map to `pi-lean-host` so keritas
can import framework helpers as package imports, publish it, create the
`keritas` repo, and move every non-axis recipe + `_shared/` + `WAF-NOTES.md`

- `CONTRIBUTING.md` into it — migrating the moved tests' relative
`../../core/` imports to `pi-lean-host/core/...` package imports. Host stays
green by construction throughout (Sprint 3 put the axis guides and
mocked-transport coverage in place first).

**Gated on:** Sprint 3 + a published `pi-lean-host` carrying the `exports`
map (keritas is a devDep-only source repo — see the design doc's Decisions).

**Merge-cycle & rollback note:** this sprint is **at minimum two merge
cycles** — 4a (exports map + publish) must land and publish before 4c (move
- import migration) can be verified, because keritas's devDep resolves
`pi-lean-host/core/...` against npm. Git revert is the rollback for the
content move in host. The published exports-map version is permanent (npm
un-publish is time-limited) but **additive** — it exposes new entry points
without changing existing behavior, so no current consumer breaks; a wrong
map is fixed with a new patch version, not an un-publish. If 4c stalls
after 4a publishes, the only residue is a published version exposing
internal modules with no consumer yet — benign but worth naming.

### 4a — `exports` map on `pi-lean-host`

1. Add an `exports` field to `package.json` exposing the framework entry
   points keritas needs. The audited full set (run the 4c audit command —
   do not rely on this enumeration alone) is **seven** targets:
   `./core/helpers.js`, `./core/parse-api-guide.js`, `./core/guide-store.js`,
   `./core/local-helpers.js`, `./core/api-guide-types.js`,
   `./core/transport.js` (dynamically imported by the moved
   `transform.test.ts` files), and `./core/auth.js` (dynamically imported
   by the moved auth-bearing `endpoint-coverage.test.ts` files).
   **No-build shape:** the package has `noEmit: true` (no `.js` files exist),
   so each export must map the `.js` key to its source `.ts` file (or use a
   `types`/`default` conditions map) so `tsx` and type-checking in keritas
   resolve it — e.g. `"./core/helpers.js": "./core/helpers.ts"`.
2. Keep the existing `files` array (the npm tarball already excludes
   `api-guides/`); confirm the `exports` map does not pull new content into
   the tarball (`ship-manifest.test.ts` stays green).
3. Publish the `exports`-map release (lockstep bump via
   `scripts/sync-versions.js`, `npm run publish:dry` to inspect, then
   `npm run publish`). keritas's devDep resolves against this published
   version.

### 4b — Create the `keritas` repo

1. Create the `keritas` repo (separate repo, same license). Add a
   `package.json` with `pi-lean-host` as a **devDependency** pinned to the
   4a-published version. No published keritas package — it is a source repo
   consumed only by its own dev/test tooling (design doc Decisions #2).
2. Set up `tsx` + `vitest` dev tooling mirroring host's runner versions.

### 4c — Move content + migrate import paths

1. Move, from `pi-lean-host/api-guides/` to `keritas/api-guides/`:
   - Every **non-axis** recipe dir (its `guide.md`, `helper.ts`,
     `endpoint-coverage.test.ts`, `helper.test.ts`, `transform.test.ts`,
     `endpoint-coverage-plan.md`, `spec/` caches, etc.) — **including the
     full boe.es reference/template guide** (the slim synthetic boe.es stays
     in host).
   - `api-guides/_shared/test-harness.ts` and `api-guides/_shared/probe-op.ts`.
   - `api-guides/WAF-NOTES.md` and `api-guides/CONTRIBUTING.md`.
2. Keep in `pi-lean-host/api-guides/`: only the synthetic axis-guide set
   from Sprint 3 (no `_shared/`, no `WAF-NOTES.md`, no `CONTRIBUTING.md` —
   those moved).
3. **Import path migration** (the design doc Risks section's mechanical
   cost): in every moved test/helper that imported framework code via
   relative paths (`../../core/...`), rewrite to package imports
   (`pi-lean-host/core/...`). Audit first with
   `rg "\.\./\.\./core" api-guides/` to enumerate every site — **drop the
   `from "` prefix** so the match catches **dynamic** `import("../../core/…")`
   calls as well as static `import … from "../../core/…"`. The static-only
   form misses ~40 dynamic imports across ~14 moved files (the auth-bearing
   `endpoint-coverage.test.ts` files and the `transform.test.ts` files use
   dynamic imports, plus `vi.importActual`); those resolve `./core/transport.js`
   and `./core/auth.js`, which is why 4a lists them. The
   moved `_shared/test-harness.ts` and `probe-op.ts` are the shared cases;
   per-recipe `transform.test.ts` / `endpoint-coverage.test.ts` /
   `helper.test.ts` are the per-file cases.
4. In keritas, run the moved tests against the devDep `pi-lean-host`:
   - `all-guides-parse` equivalent over keritas's full recipe set (parse,
     no network).
   - The moved `transform.test.ts` / `helper.test.ts` (mocked-transport
     recipe-correctness, no network).
   - The moved `endpoint-coverage.test.ts` under `HOST_INTEGRATION=1`
     (live — to be wired into nightly CI in Sprint 5, not gated here).

### 4d — Host after the move

1. Remove the moved dirs from `pi-lean-host/api-guides/`. Only the synthetic
   axis guides remain.
2. Confirm `__tests__/all-guides-parse.test.ts` still discovers and parses
   the kept axis set (it scans `api-guides/` — now smaller).
3. Confirm `axis-coverage.test.ts` still green (the axis guides are intact).
4. **Update `__tests__/axis-units.test.ts`** — it reads real recipe dirs
   (`loc.gov`, `services.dnb.de`, `resources.data.gov`, `en.wikipedia.org`)
   via `withTempDirs(...)` and asserts content-specific operations
   (`listSearch`, `searchZdb`, etc.). Those dirs move to keritas in 4c, so
   the test throws `Recipe folder not found`. Either re-point it at the
   synthetic axis guides (which constrains Sprint 3 authoring: the synthetic
   guides must carry matching operation names + pagination styles), or fold
   these assertions into Sprint 3's mocked-transport tests and slim
   `axis-units.test.ts` to synthetic guides only. Schedule this with 4c,
   not after — the exit criterion below can't pass without it.
5. **Update `__tests__/parse-api-guide.test.ts`** — the "real boe.es guide
   — 17 operations" describe block (~line 209) reads
   `api-guides/boe.es/guide.md` and asserts exactly 17 specific op names.
   The real boe.es moves to keritas; the synthetic slim boe.es has far fewer
   ops. Delete that describe block (the inline `BOE_RECIPE` worked-example
   tests above it use a string constant, not the file, and are unaffected)
   or move it to keritas.
6. **Update `__tests__/ship-manifest.test.ts`** — the
   `api-guides/web.archive.org/helper.ts` existence assertion (~line 53)
   fails post-move (`web.archive.org` is non-axis). Remove or adjust it.

### Sprint 4 exit criteria

- `npm run test:ci` green in `pi-lean-host` with only the synthetic axis
  guides present (no real recipes, no `_shared/`).
- `pi-lean-host` published with the `exports` map. `ship-manifest.test.ts`
  still green (it guards the `files` array — unchanged here); the `exports`
  map itself is validated by `npm run publish:dry` inspection (each
  `./core/*.js` key resolves to its `.ts` source) **and** by keritas's
  devDep resolving the moved tests' `pi-lean-host/core/...` imports in 4c.
  `ship-manifest.test.ts` alone does *not* validate the exports map — do
  not treat its green as proof.
- `keritas` repo exists with every non-axis recipe + `_shared/` +
  `WAF-NOTES.md` + `CONTRIBUTING.md`; all moved tests' imports rewritten to
  `pi-lean-host/core/...` and resolving against the devDep.
- In keritas: parse-validity over the full recipe set green (no network);
  moved mocked-transport `transform.test.ts`/`helper.test.ts` green.
- No `../../core/` relative imports remain in keritas (grep-clean).

---

## Sprint 5 — Stand up keritas CI + README drift disclaimer

**Goal:** give keritas the two-tier CI the design doc specifies — per-PR
fast (parse + mocked-transport, gated) and nightly live
(`HOST_INTEGRATION=1`, non-gating drift signal) — and land the README drift
disclaimer. This is what makes the split's "green by construction where
achievable, drift-signal posture where not" real.

**Gated on:** Sprint 4 (keritas repo exists with moved content + rewritten
imports).

### Tasks

1. **keritas per-PR CI (fast, gated, no network):**
   - Parse-validity: run `parseApiGuide()` over every guide (the
     `all-guides-parse` equivalent, now in keritas).
   - Mocked-transport recipe-correctness: the moved `transform.test.ts`
     files and any `helper.test.ts` that imports the real `helper.ts` via
     mocked transport. These are coupled to the real `helper.ts` (which
     moved), so they run here, fast and deterministic.
   - Both gated on PR status; a recipe PR that breaks parsing or helper
     wiring fails fast.
2. **keritas nightly CI (slow, non-gating, live):**
   - The moved `endpoint-coverage.test.ts` files under
     `HOST_INTEGRATION=1` against the pinned `pi-lean-host` devDep. Reuses
     the same `itWhen` live-gate harness (which moved with `_shared/`).
   - Scheduled (cron), not PR-gated. Reds are the drift signal, not a gate.
   - Upload test artifacts on failure (vitest output, request traces).
3. **README drift disclaimer** in `keritas/README.md` — the design doc's
   per-recipe statement (proven as of `verified` date, may drift; users can
   author their own guides with `/api learn` + `/api probe` or copy + adapt
   a recipe here). Keep this **separate** from host's README unstable
   disclaimer (different questions — the design doc's two-disclaimers rule).
4. Pin the `pi-lean-host` devDep in keritas to a specific published version;
   bumping it is a deliberate keritas PR (so a schema change in host is a
   visible, reviewed event in keritas, not a silent break).

### Sprint 5 exit criteria

- keritas per-PR CI runs parse-validity + mocked-transport tests green on a
  clean PR; a deliberately-broken guide fails it.
- keritas nightly CI runs the live `HOST_INTEGRATION=1` suite on schedule;
  failures are non-gating (drift signal only).
- `keritas/README.md` carries the drift disclaimer, scoped to per-recipe
  `verified`-date provenance — distinct from any framework unstable
  disclaimer.
- `pi-lean-host` devDep pinned to a published version in keritas.

---

## Lockstep gate — declare schema v1, remove the unstable disclaimer

**Goal:** the design doc's schema-versioning lifecycle boundary. At lockstep
(the README's existing marker — "future compatibility is not guaranteed
until the package reaches lockstep with `pi-lean-dimension` 0.5.0"), bump
`GUIDE_SCHEMA_VERSION` to `1` and remove the README unstable disclaimer.
This is a **label change, not a break**: v1 is the frozen beta state, so
every beta guide is implicitly v1 with no migration.

**Gated on:** Sprint 5 (keritas nightly live tests running as the drift
signal that makes dropping the unstable disclaimer safe) **and** the
lockstep release of `pi-lean-dimension` 0.5.0.

**Pre-lockstep independence:** Sprints 1–5 are pre-lockstep and independent
of the 0.5.0 release — only the schema v1 bump and the disclaimer removal
wait for it. If 0.5.0 is delayed indefinitely, host stays at schema v0 with
the README unstable disclaimer and keritas runs with its own drift
disclaimer; everything functions. No functional deadlock — the gate is a
label change, not a dependency.

### Tasks

1. Bump `GUIDE_SCHEMA_VERSION` from `0` to `1` in
   `core/api-guide-types.ts`. Update `schema-version.test.ts` accordingly
   (the metadata-only invariant holds at `1`; present/absent/forward cases
   still parse identically).
2. Stamp `schemaVersion: 1` on the kept axis guides' frontmatter (the
   beta→v1 label change). No recipe migration — v1 is the frozen beta state.
3. Remove the README unstable disclaimer (the pre-lockstep "compatibility is
   not guaranteed" block). **Do not** remove keritas's drift disclaimer —
   they are separate statements (the design doc's two-disclaimers rule).
4. Add a CHANGELOG line: *"schema v1 declared"* next to the lockstep release.
5. From here, the design doc's bump rule applies: do **not** bump unless a
   guide that used to parse now fails to parse (adding optional fields / new
   enum values / relaxing constraints is a non-event).

### Lockstep gate exit criteria

- `GUIDE_SCHEMA_VERSION === 1`; axis guides carry `schemaVersion: 1`.
- `schema-version.test.ts` green at v1.
- README unstable disclaimer removed; keritas drift disclaimer intact.
- CHANGELOG records "schema v1 declared" at the lockstep release.
- `npm run test:ci` green; `npm run publish:dry` clean.

---

## Sprint 6 — Documentation cleanup

**Goal:** update host's own docs to reflect the post-split reality — remove
stale references to the `api-guides/` tree (now axis-only), the `_shared/`
layout, `WAF-NOTES.md`/`CONTRIBUTING.md` (moved), and the
`HOST_INTEGRATION` env-gate instructions (live tests now live in keritas).
Point users to keritas for the comprehensive recipe library.

**Gated on:** Sprint 4 (the move). Not gated on lockstep — can land any time
after the split.

### Tasks

1. `packages/pi-lean-host/AGENTS.md`:
   - Update the "api-guides/" section to describe the **axis set only**
     (synthetic minimal guides, mocked-transport, no `verified:` date, no
     live endpoints).
   - Remove references to `_shared/test-harness.ts`, `_shared/probe-op.ts`,
     `WAF-NOTES.md`, `CONTRIBUTING.md` as host-resident (they moved to
     keritas). Note that the inline worked example in `tools/api-learn.ts`
     stays in host (separate from the full reference guides in keritas).
   - Update the `HOST_INTEGRATION` instructions: live-endpoint tests are no
     longer co-located in host; they live in keritas. Host's
     `api-guides/<domain>/` tests are mocked-transport, always-on, no env
     var.
   - Add a pointer to the `keritas` repo for the comprehensive recipe
     library + the drift disclaimer.
   - Record the `GUIDE_SCHEMA_VERSION` / `schemaVersion` mechanism and the
     bump rule (post-v1) per the design doc's schema-versioning section.
2. `packages/pi-lean-host/README.md`:
   - Update the install/usage section to describe the axis set and point to
     keritas for real recipes.
   - After lockstep, the unstable disclaimer is already removed (Lockstep
     gate); before lockstep, leave it (it is the beta boundary marker).
3. Cross-check the monorepo root `AGENTS.md` for any host `api-guides/`
   references that are now stale (the root file predates this package per
   its own note) — update if it mentions the guide tree.

### Sprint 6 exit criteria

- No stale `_shared/`, `WAF-NOTES.md`, `CONTRIBUTING.md`, or
  `HOST_INTEGRATION`-in-host references remain in host docs (grep-clean).
- Axis-set description accurate; keritas pointer present.
- `GUIDE_SCHEMA_VERSION` / bump rule documented in host `AGENTS.md`.

---

## Cross-cutting rules (inherited from the design doc)

- **Green by construction in host.** Host CI is structural only — fast,
  deterministic, no browser, no network. The split's whole point: the
  framework repo is green by construction. No live endpoint test stays in
  host after Sprint 4.
- **No endpoint-recipe duplication.** Host's axis guides are synthetic
  minimal variants against mocked transport; keritas owns the real recipes
  - their live tests. The two repos overlap in neither purpose nor
  real-recipe content.
- **`schemaVersion` is attribution, not enforcement.** It never gates,
  warns, or alters parse behavior. `all-guides-parse` (host, over the axis
  set) and keritas's parse-validity CI are the only real gates. No parser
  changes for versioning — Sprint 1's guard is the proof.
- **Two disclaimers stay separate.** The README unstable disclaimer
  (pre-lockstep, schema settling) is removed at lockstep; keritas's drift
  disclaimer (perpetual, per-recipe `verified`-date provenance) stays
  forever. Conflating them is a flagged risk in the design doc.
- **Sole maintainer; no reviewer/sign-off workflow.** The design doc owns
  ownership; this plan inherits it. Sprints land on the maintainer's
  judgment against their own exit criteria.

## Out of scope (deferred, from the design doc)

- **Axis-set membership** — finalized in Sprint 2's audit; not pre-decided
  here. The design doc's working candidate (six synthetic guides) is a
  starting point, not the answer.
- **oauth2** — lands during beta (schema v0), burns no version bump. It is
  a watched schema item but not on this plan's critical path; it can land
  any time before lockstep without affecting these sprints.
- **Per-guide version pinning / multiple framework versions in one repo** —
  explicitly rejected by the design doc (it freezes the wrong thing).
- **A published `keritas` npm package** — explicitly rejected; keritas is a
  devDep-only source repo.
- **Schema-change auto-enforcement beyond the parse gate** — `schemaVersion`
  is advisory only; no parser changes for versioning.
