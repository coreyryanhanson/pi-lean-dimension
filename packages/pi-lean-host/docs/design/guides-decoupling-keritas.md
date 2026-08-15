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
3. **No redundancy.** The axis guides in pi-lean-host are chosen to maximize
   *framework feature* coverage (so the framework is proven without a live
   dependency); keritas's integration tests maximize *endpoint* coverage.
   They overlap in neither purpose nor content.

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
├── api-guides/          (CORE AXIS SET ONLY — small, curated)
│   ├── boe.es/          (reference/template guide — kept)
│   └── …                (< ~7 guides, one per covered axis; membership TBD)
└── __tests__/           (structural — no live network)

keritas/                 (separate repo — devDep on pi-lean-host)
├── api-guides/          (comprehensive recipes, incl. axis-set overlap-free)
├── _shared/test-harness.ts   (moved here with the guides)
├── WAF-NOTES.md              (moved here with the guides)
├── CONTRIBUTING.md           (moved here with the guides)
└── README.md                 (owns the drift disclaimer)
```

## What moves to keritas vs what stays

**Moves with the guides** (they are content infrastructure, not framework):

- Every non-axis recipe + its `guide.md`, `helper.ts`, and co-located
  `endpoint-coverage.test.ts` / `helper.test.ts`
- `api-guides/_shared/test-harness.ts` (`itWhen` + live gate)
- `api-guides/WAF-NOTES.md`, `api-guides/CONTRIBUTING.md`

**Stays in pi-lean-host:**

- All of `core/`, `tools/`, and the framework structural tests
- A small **axis guide set** — recipes picked specifically so the union
  exercises every framework feature: `restGet`, `paginate`, built-in
  `transform`, local-helper auth, static-key auth, XML parsing (fast-xml-parser),
  charset/ETag quirks, multi-recipe domains. These are tested with a **mocked
  transport** (they never touch a live endpoint), so they are deterministic.
  The axis guides are **data** — the framework's structural tests parse and
  execute them against a stubbed fetch; their live endpoint tests move to
  keritas with the rest.
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
   and used by ~6 keyed guides (etherscan, gitlab, coingecko, eutils,
   resources.data.gov, api.github.com). The README unstable disclaimer
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
small (~5–7), non-flaky, mocked-transport set whose union exercises every
framework feature (see [What stays](#what-moves-to-keritas-vs-what-stays)).
The concrete membership needs a **feature-coverage audit** of the current
~29 guides — a large-model task that is not available right now.

**Audit procedure (to run before finalizing the set):**

1. Enumerate the framework feature axes (restGet, paginate, built-in
   `transform`, local-helper, static-key auth, XML parsing, charset/ETag
   quirks, multi-recipe domains).
2. For each current guide, record which axes its ops exercise (frontmatter
   `via`/`auth`/`parse`/`helper`/`transform` + helper.ts presence).
3. Pick the minimal union of guides covering every axis, preferring the
   reference/template guide (boe.es) and guides with the least endpoint
   surface (fewer ops to mock).
4. Verify each chosen guide parses under `all-guides-parse` and executes
   against a mocked transport with no live calls.

A working candidate union (not committed) is: boe.es, earthquake.usgs.gov,
api.github.com, archive.org + archive.org-wayback, services.dnb.de — covering
all eight axes in six guides. This is a starting point for the audit, not the
decision.

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
   (net-new; no behavior change).
2. Run the feature-coverage audit and finalize the axis set.
3. Move non-axis guides + `_shared`/`WAF-NOTES`/`CONTRIBUTING` into keritas;
   adapt axis-guide tests to a mocked transport.
4. Stand up keritas CI (nightly live) + README drift disclaimer.
5. At lockstep: remove the README unstable disclaimer, declare schema v1
   (CHANGELOG line), continue with the bump rule for any post-v1 break.

**Ownership.** Sole maintainer; this document is the durable decision record.
No reviewer/sign-off workflow.
