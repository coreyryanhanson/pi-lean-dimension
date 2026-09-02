# Guide Content Decoupling — Remaining Work (pi-lean-host)

> Continuation of [`guides-decoupling-caritas-sprint-plan.md`](./guides-decoupling-caritas-sprint-plan.md).
> Sprints 1–4 and 6 are complete. The only remaining host-side work is the
> **Lockstep gate** (schema v1). Caritas-side remaining work (Sprint 5) lives
> in the caritas repo's own plan doc
> (`~/caritas/docs/design/guides-decoupling-caritas-remaining-caritas.md`).

## Lockstep gate — declare schema v1, remove the unstable disclaimer

The design doc's schema-versioning lifecycle boundary. At lockstep (the README's
existing marker — "future compatibility is not guaranteed until the package
reaches lockstep with `pi-lean-dimension` 0.5.0"), bump `GUIDE_SCHEMA_VERSION`
to `1` and remove the README unstable disclaimer. This is a **label change,
not a break**: v1 is the frozen beta state, so every beta guide is implicitly
v1 with no migration.

**Gated on:** Sprint 5 (caritas nightly live tests running as the drift signal
that makes dropping the unstable disclaimer safe) **and** the lockstep release
of `pi-lean-dimension` 0.5.0.

**Pre-lockstep independence:** if 0.5.0 is delayed, host stays at schema v0 with
the README unstable disclaimer and caritas runs with its own drift disclaimer;
everything functions. No functional deadlock — the gate is a label change, not
a dependency.

### Tasks

1. Bump `GUIDE_SCHEMA_VERSION` from `0` to `1` in `core/api-guide-types.ts`.
   Update `__tests__/schema-version.test.ts` accordingly (the metadata-only
   invariant holds at `1`; present/absent/forward cases still parse
   identically).
2. Stamp `schemaVersion: 1` on the kept axis guides' frontmatter (the beta→v1
   label change). No recipe migration — v1 is the frozen beta state.
3. Remove the README unstable disclaimer (the pre-lockstep "compatibility is
   not guaranteed" block, currently ~lines 26–27). **Do not** remove caritas's
   drift disclaimer — they are separate statements (the design doc's
   two-disclaimers rule).
4. Add a CHANGELOG line: *"schema v1 declared"* next to the lockstep release.
5. From here, the design doc's bump rule applies: do **not** bump unless a
   guide that used to parse now fails to parse (adding optional fields / new
   enum values / relaxing constraints is a non-event).

### Exit criteria

- `GUIDE_SCHEMA_VERSION === 1`; axis guides carry `schemaVersion: 1`.
- `schema-version.test.ts` green at v1.
- README unstable disclaimer removed; caritas drift disclaimer intact.
- CHANGELOG records "schema v1 declared" at the lockstep release.
- `npm run test:ci` green. (npm publish of the schema-v1 release is the
  maintainer's own schedule, out of this plan's scope.)

## Deferred (maintainer's own schedule, not on this plan)

- npm version bump + publish of `pi-lean-host` (with the `exports` map added in
  Sprint 4a) — independent of these sprints.
