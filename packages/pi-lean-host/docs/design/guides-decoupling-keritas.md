# pi-lean-host — Guide Content Decoupling (`keritas`)

> Design for breaking the recipe/guide content out of the `pi-lean-host`
> package into a separate repository named **`keritas`** (keeping the pi-lean
> / Pylean pun family from *Angel*). pi-lean-host stays the framework + a
> small, non-flaky axis-guide set; keritas owns the comprehensive recipe
> library, its live integration tests, and the "proven as of a date, may
> drift" disclaimer.
>
> Status: **decided.** This is the decision record for structure and
> versioning. It is not a migration schedule — execution sequencing is out of
> scope here (see [Rollout](#rollout--next-steps) for the intended order).

## Problem

`pi-lean-host` mixes two things with different lifecycles:

| Bucket | LOC |
|---|---|
| Guides (markdown) | ~15.4k |
| Guide integration tests | ~8.8k |
| Guide helpers | ~0.3k |
| **Content total (≈ half the repo)** | **~24.4k** |
| Framework (core + tools) | ~7.3k |
| Framework structural tests | ~10.3k |
| **Repo total** | **~48.2k** |

(LOC measured via `wc -l` on git-tracked files in each bucket; counts
are a snapshot for the split rationale, not a maintained invariant.)

The shipped framework is ~7.3k LOC of code; the rest is content. Content has a
faster churn cadence (endpoints break, format drifts) and a flakier test
profile (live external APIs) than the framework. Co-locating them means the
framework repo carries the maintenance commitment of every recipe it neither
needs to be correct nor is paid to keep green — and the deliverable on npm
(`api-guides/` is already excluded from the tarball) never contained these
guides anyway. They are reference content, already decoupled from the
*artifact*, kept in the framework repo only by tradition.

There is also a concrete workflow cost today: guide content blocks fast
iteration on the framework. A large in-flight branch carries the guide tree
along with it, so a main merge drags the content churn with it even when the
framework change is unrelated. Splitting the content out lets framework work
(and future schema work, e.g. oauth2) land in separate, flattenable branches
without the guide tree in the way.

## Goal

1. **pi-lean-host** ships the framework and owns a **core axis-guide set +
   structural tests** that (a) prove every framework feature end-to-end and
   (b) are non-flaky (no live external APIs, via mocked transport). This
   core keeps the repo self-contained and fast — pure structural CI.
2. **keritas** (separate repo) owns the **comprehensive recipe library** —
   the long tail of real-world guides + their co-located live integration
   tests (`HOST_INTEGRATION=1`) — plus the explicit drift disclaimer.
3. **No endpoint-recipe duplication.** The axis guides in pi-lean-host are
   *synthetic minimal variants* authored to exercise framework features against
   a mocked transport — they are not copies of real recipes and carry no
   `verified:` date. keritas owns the real, comprehensive recipe library and
   its live integration tests. The two repos overlap in neither purpose nor
   real-recipe content: host proves framework features deterministically;
   keritas proves endpoints against live APIs.

## Non-goals

- **Not** a guides-content-cdn, a marketplace, or an auto-generated
  catalogue. keritas is a plain recipe repo.
- **No** schema-change auto-enforcement beyond the existing parse gate
  (`schemaVersion` is advisory — see [Schema versioning](#schema-versioning-the-coupling-answer)).
- **No** per-guide version pinning / multiple framework versions installed in
  one repo — that freezes the wrong thing (the framework is *more* stable
  than the endpoints it talks to).
- **No** published keritas npm package. keritas is a source repo consumed only
  as a devDependency by its own dev/test tooling against a published
  pi-lean-host (see [Decisions](#decisions)).

## Proposed structure

```
pi-lean-host/            (framework repo — this package)
├── core/  tools/        (the shipped extension)
├── api-guides/          (CORE AXIS SET ONLY — synthetic minimal guides)
│   ├── boe.es/          (synthetic axis variant — NOT the reference template)
│   └── …                (< ~7 synthetic guides, one per covered axis; membership TBD)
└── __tests__/           (structural — no live network)

keritas/                 (separate repo — devDep on pi-lean-host)
├── api-guides/          (comprehensive real recipes, incl. full boe.es reference)
├── _shared/test-harness.ts   (moved here with the guides)
├── _shared/probe-op.ts       (moved here with the guides)
├── WAF-NOTES.md              (moved here with the guides)
├── CONTRIBUTING.md           (moved here with the guides)
└── README.md                 (owns the drift disclaimer)
```

## What moves to keritas vs what stays

**Moves with the guides** (they are content infrastructure, not framework):

- Every non-axis recipe + its `guide.md`, `helper.ts`, and co-located
  `endpoint-coverage.test.ts` / `helper.test.ts` — **including the full boe.es
  reference/template guide** (the slim synthetic boe.es stays in host)
- `api-guides/_shared/test-harness.ts` (`itWhen` + live gate)
- `api-guides/_shared/probe-op.ts` (dev probing tool — no non-axis guides to
  probe remain in host)
- `api-guides/WAF-NOTES.md`, `api-guides/CONTRIBUTING.md`

**Stays in pi-lean-host:**

- All of `core/`, `tools/`, and the framework structural tests
- A small **axis guide set** — *synthetic minimal guides* authored
  specifically so the union exercises every framework feature: `restGet`,
  `paginate`, built-in `transform`, local-helper auth, static-key auth, XML
  parsing (fast-xml-parser), charset/ETag quirks, multi-recipe domains. These
  are **not** copies of real recipes; they are minimal synthetic guides written
  to hit one axis (or a small group of axes) against a **mocked transport**
  (they never touch a live endpoint), so they are deterministic and carry no
  `verified:` date. The axis guides are **data** — the framework's structural
  tests parse and execute them against a stubbed fetch. Because they are
  synthetic, the real recipe for any domain they echo (e.g. the full boe.es)
  lives in keritas alongside that recipe's live `endpoint-coverage.test.ts`;
  keritas's test harness (`copyDomains`) resolves the guide locally, unchanged.
  The reference/template role (boe.es as the canonical guide authors copy,
  per `CONTRIBUTING.md`) stays with the full recipe in keritas — host's slim
  variants are coverage fixtures, not authoring templates.
- The `all-guides-parse` test (still applies to the kept axis set) — the
  always-on, zero-flake binding contract that the guides are schema-valid
  *now*.

### Axis-set membership (TBD)

The exact guide set is **not yet decided** — see
[Deferred: axis-set membership](#deferred-axis-set-membership-tbd) for the
placeholder and the audit procedure that will finalize it.

## Schema versioning (the coupling answer)

The one real cost of a separate repo is **version coupling**: guides are
written against `parseApiGuide()`'s format, so a schema change ripples into
every recipe. We minimize and make it visible, not eliminate it.

**Lifecycle — beta until lockstep, v1 declared at lockstep.**

- The schema is **beta** until the package reaches lockstep (the README's
  existing unstable disclaimer — "future compatibility is not guaranteed
  until the package reaches lockstep with `pi-lean-dimension` 0.5.0" — is the
  boundary marker for this period).
- `GUIDE_SCHEMA_VERSION = 0` during beta. Guides declare `schemaVersion: 0`
  in frontmatter (absent defaults to 0), so pre-split guides are implicitly
  beta.
- At lockstep, the constant bumps to **1** and the CHANGELOG records
  *"schema v1 declared"*. This is a **label change, not a break** — v1 is the
  frozen beta state, so every beta guide is implicitly v1 with no migration.
- **oauth2 lands during beta** and burns no version bump, even if it breaks
  guides — beta carries no compatibility guarantee. Only **post-v1** breaking
  parse changes bump to v2+.

**Bump rule (post-v1) — do not bump unless a guide that used to parse now
fails to parse.** Adding an optional field, a new enum value (`auth.kind`,
`via`), or relaxing a constraint is a **non-event** (old guides parse either
way — that's what keeps the coupling cheap). Removing/renaming a field,
deleting a `via`/`pagination.style` value, or changing a parse-enforced
constraint's meaning — those bump.

**Decoupled from package semver.** pi-lean-host's version crawls for
transport/tools/portal-projection reasons that don't touch guides; the schema
integer only counts breaking *format* events, so it stays O(single digits).
The package version is the coarse-noise signal; the schema integer is the
rare, cause-aligned one.

**Attribution, not enforcement.** Guides declare `schemaVersion` in
frontmatter. It is metadata for triage ("this guide targets schema 2, current
is 3 → migrate it") and for keritas's provenance claim. The version **never
gates or warns at parse time** — `all-guides-parse` (running the *current*
parser) is the real, only gate. No parser changes for versioning.

**Change record.** Each v2+ bump is one CHANGELOG line in pi-lean-host, next
to the release that introduced it. `git log`/CHANGELOG on `api-guide-types.ts`
*is* the schema history. The existing `verified: <date>` frontmatter key
stays and gains the `schemaVersion` sibling.

## CI strategy

- **pi-lean-host** CI runs structural tests only — fast, deterministic, no
  browser, no network. This is the split's whole point: the framework repo is
  green by construction.
- **keritas** CI runs the live integration tests (`HOST_INTEGRATION=1`) on a
  schedule (cron/nightly) against a pinned `pi-lean-host` (dev dependency
  from npm). These are allowed to be slow and occasionally red — that's the
  drift signal, not a gate. Reuses the same `itWhen` live-gate harness the
  framework already uses, so the test shape is unchanged.

## Drift disclaimer (keritas README)

keritas's README owns this statement, per recipe:

> Recipes here were verified against a specific pi-lean-host schema version
> and their live endpoints as of the date in each guide's `verified` field.
> Public APIs change; a recipe may drift out of date. Users can author their
> own guides easily with pi-lean-host (`/api learn` + `/api probe`), or copy
> a recipe here and adapt it — the format is a versioned, documented YAML.

This is exactly the "proven as of a date, may drift" posture + the authoring
escape hatch — a natural fit for a content repo, and it keeps the framework
repo out of the "X API broke" issue traffic.

**Two disclaimers, kept separate.** The README unstable disclaimer
(pre-lockstep, schema settling) is *removed at lockstep*; keritas's drift
disclaimer (perpetual, "proven as of a date") stays forever. They answer
different questions and must not be conflated.

## Decisions

The four open questions from the proposal are resolved:

1. **Split timing — split now.** The original wait-trigger (`auth.kind:
   static-key` proven) is already met: static-key is realized in the schema
   and used by 5 keyed guides (etherscan, gitlab, coingecko, eutils,
   api.github.com). The README unstable disclaimer
   already covers the churn period, and the workflow driver (framework
   branches blocked by the guide tree) argues for sooner. oauth2 is a watched
   schema item that lands during beta and burns no bump.
2. **keritas release flow — devDep-only source repo.** No published keritas
   package. keritas is consumed only as a devDependency by its own dev/test
   tooling against a published pi-lean-host. Users adopt a recipe by copying
   its guide dir, exactly as today.
3. **Schema-attribution enforcement — advisory only.** `schemaVersion` is
   purely metadata (triage + keritas provenance). It never gates or warns at
   parse time; `all-guides-parse` is the only gate; no parser changes.
4. **Schema versioning lifecycle — beta (v0) → v1 at lockstep.** See
   [Schema versioning](#schema-versioning-the-coupling-answer).

## Deferred: axis-set membership (TBD)

The exact axis-guide set is **intentionally deferred**. The aim is fixed: a
small (~5–7), non-flaky, mocked-transport set of **synthetic minimal guides**
whose union exercises every framework feature (see [What stays](#what-moves-to-keritas-vs-what-stays)).
Unlike the pre-split recipes, these guides are authored, not picked from the
existing library — each is a minimal synthetic guide written to hit one axis
(or a small group) against mocked transport, carrying no `verified:` date and
no live endpoint. The concrete membership needs a **feature-coverage audit**
of the current 23 real guides — a large-model task that is not available right
now.

**Audit procedure (to run before finalizing the set):**

1. Enumerate the framework feature axes (restGet, paginate, built-in
   `transform`, local-helper, static-key auth, XML parsing, charset/ETag
   quirks, multi-recipe domains) — the guide-driven subset of the full list
   in [Test axes](#test-axes-the-audits-dimension-list).
2. For each current *real* guide, record which axes its ops exercise (frontmatter
   `via`/`auth`/`parse`/`helper`/`transform` + helper.ts presence) — this is
   the feature checklist the synthetic variants must collectively cover.
3. Author the minimal union of synthetic guides covering every axis, one axis
   per guide where practical (preferring small groupings over multi-axis
   guides for regression isolation), each with the fewest ops needed to hit
   its feature(s) against mocked transport. Do **not** copy real recipes —
   these are coverage fixtures, not reference content.
4. Verify each synthetic guide parses under `all-guides-parse` and executes
   against a mocked transport with no live calls.

A working candidate set (not committed) is six synthetic guides echoing the
feature spread of: boe.es, earthquake.usgs.gov, api.github.com, archive.org +
archive.org-wayback, services.dnb.de — covering all eight axes (6 guides:
archive.org and archive.org-wayback count separately, exercising multi-recipe
domain dispatch). This is a starting point for the audit, not the decision.

## Test axes (the audit's dimension list)

The audit (Deferred, step 1) enumerates these axes. Each is a framework
feature dimension that must be exercised by at least one axis guide against
mocked transport (deterministic, no live network), or by a structural test
that doesn't depend on guide content. The current suite already covers most —
the audit's job is to confirm the kept axis guides preserve the guide-driven
coverage after the split.

The Deferred section's eight axes are the **guide-driven** subset (coverage
depends on axis-set membership); the remaining rows are **framework-structural**
axes covered by tests that don't depend on which guides are kept, listed for
completeness — they're stable across the split.

| Axis | Exercises | Driver | Current test file(s) | Status |
|------|-----------|--------|----------------------|--------|
| exec-restGet | path templating, query assembly, `parseResponse`, ETag cache, 429 retry | guide | `helpers.test.ts`, `axis-units.test.ts` (Axis D) | covered |
| exec-paginate | all 5 pagination styles, `gatherAll` ceiling, `totalCountPath` | guide | `helpers.test.ts`, `axis-units.test.ts` (Axes A/C/E/F) | covered |
| xml-parsing | XML→JSON, namespace stripping (A2), single-record boxing (A1) | guide | `axis-units.test.ts` (Axes B/E/F) | covered |
| transform-builtin | `transform: true` hookpoint, graceful failure, `failedItems` routing | guide | `transform-restget.test.ts`, `transform-paginate.test.ts`, `transform-render.test.ts` | covered |
| local-helper | pre-call param transformation, disable-on-failure | guide | `local-helpers.test.ts` | covered |
| static-key-auth | secret injection, fail-closed, output-channel audit, SSRF-on-auth, canonical store domain | guide | `auth.test.ts`, `query-secrets.test.ts`, `secrets-store.test.ts`, `secrets-command.test.ts` | covered |
| transport | UA, charset, 429-retry parsing, ETag, `redactSecretParams` | guide | `transport.test.ts`, `helpers.test.ts` | covered |
| ssrf-guard | unauthenticated `paginate` nextLink block (loopback, RFC1918, cloud metadata) | guide | `helpers.test.ts` (nextLink metadata block), `smoke.test.ts` (ssrfGuard unit), `auth.test.ts` (auth-bearing redirect SSRF) | covered |
| multi-recipe-domains | `api-fetch` operation-name dispatch across two guides claiming one domain | guide | `tools.test.ts` (cross-guide op-name resolution: success, zero-match, collision), `parse-api-guide.test.ts` (catalog) | covered |
| parse-schema | `parseApiGuide()` field validation, defaults, `projectToGuide`, catalog | structural | `parse-api-guide.test.ts`, `all-guides-parse.test.ts` | covered |
| api-fetch-tool | end-to-tool execute, spill, render | structural | `tools.test.ts`, `render-result.test.ts`, `response-spill.test.ts` | covered |
| api-guide-tool | catalog, detail, auth footer, disambiguation | structural | `tools.test.ts`, `parse-api-guide.test.ts`, `auth.test.ts` | covered |
| api-learn-tool | validate-before-write, worked example | structural | `tools.test.ts` | covered |
| api-probe-tool | shape discovery, draft emission, redirect, listSecrets | structural | `api-probe.test.ts`, `query-secrets.test.ts` | covered |
| api-toggle | on/off/learn, focus guard, peer composition, glyph | structural | `api-toggle.test.ts` | covered |
| portal-projection | runtime feature-detect, recipe stripping, boundary | structural | `portal-projection.test.ts`, `host-only-boundary.test.ts` | covered |
| ship-manifest | tarball coverage, api-guides exclusion | structural | `ship-manifest.test.ts` | covered |
| schema-version | `GUIDE_SCHEMA_VERSION` advisory-only invariant (never gates at parse) | structural | — | **gap** (constant not yet implemented) |

Two low-severity interactions are intentionally **not** axes: the
local-helper × transform combination (each mechanism proven independently; the
interaction is unlikely to fail in a novel way) and `api-learn` round-trip
identity (both call sites import the same `parseApiGuide`, so a regression
would require introducing a second parser). Both are YAGNI as dedicated tests.

### Gaps to close with the split

1. **schema-version** — the doc's central coupling answer (`schemaVersion` is
   metadata, never gates/warns at parse) has no regression guard. Closed in
   [Rollout](#rollout--next-steps) step 1.
2. **axis-set coverage assertion** — `all-guides-parse` asserts every kept
   guide parses, but nothing asserts the *union* covers every guide-driven
   axis. Post-split, removing an axis guide keeps `all-guides-parse` green
   with silent coverage loss. A structural guard promoting the manual audit
   to an enforced invariant is closed in step 3.

(`multi-recipe-domains` dispatch and `ssrf-guard` were previously listed here
as gaps; both are already covered — see the [Test axes](#test-axes-the-audits-dimension-list)
table. The `skipSsrfGuard: true` usage in `axis-units.test.ts` is a test-
infrastructure necessity for hitting the local test server, not a coverage
gap.)

## Risks & failure modes

- **Schema churn during beta.** oauth2 (and any other beta change) can break
  guides. Mitigated by the README unstable disclaimer, the user's commitment
  to personally keep in-progress guides working, and beta carrying no
  compatibility guarantee (no bump bookkeeping).
- **Axis-set regression isolation.** A single axis guide covering multiple
  features hides which feature regressed. Mitigated by keeping the set small
  and the mocked-transport tests focused; the audit (above) prefers one
  feature per guide where practical.
- **keritas drift noise.** Nightly live tests go red when an endpoint
  changes. This is intended signal, not a gate; the drift disclaimer + WAF
  notes absorb it. Risk is only if reds are ignored indefinitely — the
  `verified:` date on each guide makes staleness visible.
- **Split churn.** Moving ~24k LOC across repos is a one-time mechanical cost;
  the workflow driver (unblocked framework branches) pays for it immediately.
- **Two-disclaimer confusion.** Removing the README unstable disclaimer at
  lockstep must not silently remove keritas's drift disclaimer. Kept as
  separate, clearly-scoped statements.
- **Axis-set audit may find no small set works.** The split's self-proving
  premise depends on a finalized axis set that doesn't exist yet. If the
  feature-coverage audit reveals that no small set of synthetic guides can
  cover all axes against mocked transport, the premise weakens. The candidate
  set (echoing boe.es, earthquake.usgs.gov, api.github.com, archive.org pair,
  services.dnb.de) covers all eight axes in six synthetic guides testable with
  mocked transport, so this risk is low — but it is not yet proven. Because
  the axis guides are authored (not picked), there is no additional risk that
  an existing low-surface guide is unsuitable; the only risk is authoring
  effort, which is bounded by the axis count.

## Validation / evidence plan

- **`all-guides-parse`** stays green on the axis set in pi-lean-host CI —
  the always-on proof that the kept guides are schema-valid.
- **Axis-guide mocked-transport tests** prove every framework feature
  executes end-to-end without a live dependency (deterministic, structural).
- **keritas nightly `HOST_INTEGRATION=1`** proves the long-tail recipes
  against live endpoints; reds are the drift signal.
- **Feature-coverage audit** (see Deferred) is the evidence that the axis set
  loses no framework feature coverage before the split.

## Rollout / next steps

Out of scope for this document as a schedule, but the intended order:

1. Introduce `GUIDE_SCHEMA_VERSION = 0` + `schemaVersion: 0` on guides
   (net-new; no behavior change), and add `schema-version.test.ts` asserting
   `schemaVersion` frontmatter is metadata-only — it never gates, warns, or
   alters parse behavior (closes the schema-version gap; this is the
   regression guard for the central coupling answer).
2. Run the feature-coverage audit and finalize the axis set.
3. Move non-axis guides + `_shared`/`WAF-NOTES`/`CONTRIBUTING` (including
   `_shared/probe-op.ts`) into keritas; author the synthetic axis guides and
   write mocked-transport tests for each (these are new tests with stubbed
   fetch responses, not adaptations of the existing live `itWhen` tests — the
   live `endpoint-coverage.test.ts` files move to keritas with the real
   recipes). The multi-recipe axis-guide pair (archive.org +
   archive.org-wayback, authored as two synthetic guides claiming one domain)
   must exercise `api-fetch` operation-name dispatch across both guides (the
   dispatch path is already tested structurally in `tools.test.ts`; the
   axis-guide pair preserves guide-driven coverage of it). Add an
   axis-coverage structural test asserting the kept axis-set union covers
   every guide-driven axis in the [Test axes](#test-axes-the-audits-dimension-list)
   table (closes the axis-set coverage gap; promotes the one-time audit to an
   enforced guard).
4. Stand up keritas CI (nightly live) + README drift disclaimer.
5. At lockstep: remove the README unstable disclaimer, declare schema v1
   (CHANGELOG line), continue with the bump rule for any post-v1 break.

**Ownership.** Sole maintainer; this document is the durable decision record.
No reviewer/sign-off workflow.
