# Sibling-Artifact Authoring — `api-scaffold` + `api-learn` Split

> Design doc for agent-facing authoring of guide sibling artifacts
> (`helper.ts` and `verify.json`) alongside `guide.md`. Replaces the
> earlier `api-verify-scaffold` single-tool proposal, which addressed only
> `verify.json` and ignored `helper.ts` — the artifact with real-world
> usage and zero agent authoring support today.
>
> **Status: draft for team review.** An implementation plan is downstream
> of this review.

## Problem

An API guide directory (`~/.pi/agent/pi-lean-host/api-guides/<dirName>/`)
can contain up to three files:

1. **`guide.md`** (required) — the YAML recipe parsed by `parseApiGuide()`.
2. **`helper.ts`** (when present) — arbitrary TypeScript, loaded on demand
   via dynamic `import()` when an op declares `helper: true` (pre-call param
   transform) or `transform: true` (post-response transform). One helper per
   domain is the v1 contract (`core/local-helpers.ts`).
3. **`verify.json`** (when present) — the `/api verify` sidecar, shape
   `{ "<opName>": { "<param>": "<value>" } }`, strict JSON, loaded by
   `loadVerifyJson()` (`core/verify-command.ts`). Supplies values for ops
   with unsatisfiable params so they can run during verify.

**Two gaps exist today:**

- **`helper.ts` has no agent authoring path.** The agent cannot create,
  scaffold, or stage a helper through any tool. It must hand-write
  TypeScript via bash and place it directly in the guides dir — the exact
  anti-pattern `api-learn`'s `/tmp` staging exists to prevent. In the
  caritas recipe library, **4 of ~24 guides have a `helper.ts`**
  (`boe.es`, `earthquake.usgs.gov`, `en.wikipedia.org-action`,
  `web.archive.org`) — this is the real-world sibling artifact.

- **`verify.json` has no agent authoring path.** The agent must know the
  sidecar shape, read the guide, figure out which params are unsatisfiable,
  hand-write JSON, and write it to the guides dir. `verify` is a **new
  feature** — caritas currently has **0 `verify.json` files**, but adoption
  is pending the authoring shape being nailed down. Once settled, all
  qualifying caritas guides will get a `verify.json`. The 0-usage number is
  a timing artifact, not a signal of low demand.

Both gaps invite direct edits to the guides dir — the habit `api-learn`'s
`/tmp` staging exists to prevent. And both gaps have no maintenance story
when a guide changes (new op, renamed param, added default, new helper
declaration).

## Goals

1. Give the agent a **learn-gated bootstrap tool** (`api-scaffold`) that
   creates starter `helper.ts` and/or `verify.json` in `/tmp` staging —
   never directly in the guides dir.
2. Expand **`api-learn`** from single-file (`guide.md` only) to
   **directory-level** staging and mirror-save, picking up all present
   sibling files.
3. Make scaffolding **pull-on-demand** — no file appears unless the agent
   explicitly asks for it. Zero noise for guides that don't need siblings.
4. Require **zero format change** to `verify.json` — no new dependency, no
   loader migration, no parser duplication.
5. Enforce the **guide↔helper relationship** at save time — refuse to save
   a guide that declares `helper: true`/`transform: true` but has no
   loadable `helper.ts`.

## Non-goals

- Scaffolding optional no-default params in `verify.json` (the scaffold
  targets only *blocking* params — optional params are the agent's manual
  choice).
- Pruning stale `verify.json` entries automatically (purely additive on
  initial scaffold; re-scaffold = delete from `/tmp` + re-scaffold — no
  merge-on-re-scaffold).
- Auto-scaffolding on `api-learn` save (explicit agent invocation only).
- Migrating `verify.json` to JSONC/YAML for literal comments.
- Syntax-checking or validating `verify.json` at save time (valid by
  construction from scaffold; manual edits caught by `loadVerifyJson` at
  verify time).

## Design

### Two-tool split

The earlier proposal added a 5th tool (`api-verify-scaffold`) for
`verify.json` only. This design replaces it with a **two-tool split** that
handles both sibling artifacts:

- **`api-learn`** = staging + mirror-save (multi-file). Fetch-recipe stages
  `guide.md` + all present siblings to `/tmp`. Save takes a directory path,
  mirrors the staged dir exactly. Validates `guide.md` + enforces the helper
  relationship. **Zero scaffolding logic.**

- **`api-scaffold`** = bootstrap/creation (read-only re: guides dir, writes
  `/tmp` only). Boolean params for `verify` and `helper`. Reads the guide
  from the guides dir, computes unsatisfiable params, generates stubs,
  writes to the staged `/tmp` dir. **Never touches the guides dir** — the
  agent must use `api-learn` to save. This is where the sentinel/merge/stub
  logic lives.

**Why a 5th tool is justified here** (addressing the reviewer's "over-scoped
for v1" concern on the old doc): `api-scaffold` handles **two file types**
with real logic — sentinel computation + additive merge for `verify.json`,
stub generation for `helper.ts`. It's not a thin wrapper for a 3-key
sidecar. And keeping the scaffolding logic out of `api-learn` preserves
`api-learn`'s ownership boundary (stage + validate + save, not create).

### `api-learn` changes (multi-file staging + mirror-save)

#### Fetch-recipe stages all present siblings

Today fetch-recipe stages only `guide.md`. The change: **stage every file
present in the guide directory** — `guide.md` (always), `helper.ts` and
`verify.json` (when they exist). The agent edits the *real* current state
of the entire directory, not a blank slate that would clobber siblings on
save.

Staging path keying changes from the routing `domain` to the resolved
`dirName` (see [Staging path keying](#staging-path-keying)).

#### Save takes a directory path (retiring `recipeFile`)

The `recipeFile` parameter (a single `guide.md` path) is replaced by `dir`
(a staged directory path). Save reads `guide.md` (required), `helper.ts`
(when present), and `verify.json` (when present) from the staged dir and
writes them to the guides dir.

The agent passes `dir` (the staged dir path surfaced by fetch/template/
scaffold) and `domain` (the write target, set to `dirName` per the existing
pattern — fetch surfaces `dirName` in its result).

#### Mirror-save semantics

Save **mirrors the staged dir exactly**:

- **Present files** → overwrite the corresponding file in the guides dir.
- **Absent files** → remove the corresponding file from the guides dir.

Deleting a file from the staged `/tmp` dir is the signal to drop it. This
gives the agent a deletion path with no extra API surface.

This is safe because fetch-recipe always stages all existing siblings — the
staged dir is an honest snapshot. The only wipe window is `new: true` saved
over an existing directory (see [Risks](#risks)).

#### Helper-relationship validation at save time

Save refuses if the guide declares `helper: true` or `transform: true` on
any op but:

1. **`helper.ts` is absent from the staged dir**, OR
2. **`import()` of the staged `helper.ts` fails** (syntax error, missing
   default export, top-level throw).

This reuses `local-helpers.ts`'s existing `loadHelper`/`loadTransform`
mechanism — no new import path. The guarantee: **if `api-learn` saved the
guide, the helper exists AND loads.** No silently-degraded guides.

> ⚠ **Implementation note:** `loadHelper`/`loadTransform` have a side
> effect — they set the `disabledHelpers` map on failure. The save-time
> check must not pollute session state. Use a non-mutating variant or
> reset the disabled flag after the check. This is an implementation
> detail, not a design decision.

`verify.json` is written as-is — no JSON validation at save time. It's
valid by construction when scaffolded; manual edits are caught by
`loadVerifyJson` at verify time (strict `JSON.parse`, returns `{error}` on
malformed).

### `api-scaffold` — the bootstrap tool

A dedicated, learn-gated tool — the 5th host tool (alongside `api-guide`,
`api-fetch`, `api-learn`, `api-probe`). **Read-only re: the guides dir** —
it reads the guide to compute what to scaffold, but writes only to `/tmp`.

#### Parameters

```typescript
{
  domain: string;           // routing domain (mirrors api-learn)
  guide?: string;           // shortName selector for multi-recipe domains
  verify?: boolean;         // scaffold verify.json
  helper?: boolean;         // scaffold helper.ts
}
```

- `domain` + optional `guide` mirror `api-learn`'s fetch-recipe resolution
  exactly (`findGuidesByDomain` + `selectGuideByShortName`, disambiguation
  menu for N-guide domains with no selector). The agent uses the same
  mental model for both tools.
- `dirName` is **always derived** (never passed in) and **surfaced in the
  result** alongside the staged dir path, so the agent can pass them to
  `api-learn` save.
- At least one of `verify`/`helper` must be `true`.

#### Refuse-to-overwrite

`api-scaffold` **refuses to overwrite any existing staged sibling**. If
`helper.ts` or `verify.json` already exists in the staged `/tmp` dir, the
tool errors and tells the agent to delete the file from `/tmp` first if a
fresh scaffold is wanted. **No re-scaffold merge** — re-scaffold = delete
from `/tmp` + re-call scaffold. This drops the old doc's
additive-merge-on-re-scaffold story.

#### `helper: true` — minimal stub

Writes a starter `helper.ts` with both the pre-call default export and the
post-response `transform` export as **commented-out stubs** with doc
comments explaining the contract:

```typescript
/**
 * Helper for <domain>.
 * One helper per domain is the v1 contract.
 *
 * Uncomment the export(s) you need and fill in the logic.
 */

// Pre-call param transform — receives agent-supplied params, returns the
// params the executor uses for URL templating / query assembly.
// export default function(
//   params: Record<string, unknown>,
//   _ctx: { operation: string; domain: string },
// ): Record<string, unknown> {
//   return params;
// }

// Post-response transform — reshapes the parsed response body.
// export function transform(
//   data: unknown,
//   _ctx: { operation: string; domain: string },
// ): unknown {
//   return data;
// }
```

The agent uncomments the one it needs and fills in the logic.
**Self-documenting — the template IS the documentation.** No separate
authoring manual needed for `helper.ts`.

#### `verify: true` — sentinel scaffolding

Computes unsatisfiable params from the parsed guide and writes
`"__FILL_ME__"` sentinel placeholders into the staged `verify.json`:

```json
{
  "getItem": { "id": "__FILL_ME__" },
  "search": {
    "query": "__FILL_ME__",
    "tag": "__FILL_ME__",
    "category": "__FILL_ME__"
  }
}
```

(The `search` op has a `requiresAnyOf: [query, tag, category]` group —
every member gets a sentinel; the agent fills any one.)

If an existing `verify.json` is present in the **guides dir** (not `/tmp`),
the scaffold additive-merges: existing real values are preserved, new
sentinels are added for newly-unsatisfiable params. The full merged result
is written to `/tmp`. (This is the initial-scaffold merge. Re-scaffold after
the file is already in `/tmp` is delete + re-scaffold — no merge.)

##### `unsatisfiableParams` export + return-shape fix

`unsatisfiableParams()` is currently private to `core/verify-command.ts`.
It's exported as part of this change so `api-scaffold` can call it — the
codebase's "one parser, two call sites" philosophy applies; do not
duplicate the logic.

The return shape must be enriched. Today the `requiresAnyOf` branch pushes
a composite string `"one of: id, slug, code"` — a single entry. The
scaffold needs **individual member names** (`id`, `slug`, `code`) to write
`{"id": "__FILL_ME__", ...}`. The fix: return structured objects
(`{param: string, kind: "path"|"query"|"group"}[]`) or a companion function
that expands group members into individual names.

##### Sentinel semantics (strict JSON)

`verify.json` is strict JSON — no comments. The sentinel `"__FILL_ME__"` is:

- **Never a valid API value** — no real API accepts this string as a param.
- **Self-documenting** — the string *is* the instruction.
- **Treated as "not supplied"** by the verify pipeline (see
  [P1 fix: sentinel strip in verify loop](#p1-fix-sentinel-strip-in-verify-loop)).

This delivers the *behavior* of commented-out values (visible scaffold,
inactive until filled) without a format change.

##### `requiresAnyOf` → sentinel on every member

The scaffold writes `"__FILL_ME__"` on **every** member of a
`requiresAnyOf` group. The agent fills **any one** → the group's `some()`
check returns true → the op runs. The remaining sentinels are stripped
(see P1 fix) and treated as unsupplied. This shows the agent the full menu
of choices without arbitrary picks.

##### Only blocking params scaffolded

The scaffold targets **exactly** the params `unsatisfiableParams` flags —
the ones that make verify *skip*. Optional no-default params are not
scaffolded — they don't block verify, and documenting every possible param
is `api-guide`'s job.

##### Compact authoring manual

A short manual is prepended to the scaffold result (mirroring `api-learn`'s
`AUTHORING_MANUAL` pattern):

1. **`"__FILL_ME__"` means "replace with a real value."** The sentinel is
   treated as unsupplied; the op skips until you replace it.
2. **For `requiresAnyOf` groups, fill any ONE member — not all.** The op
   runs when any member is supplied; the remaining sentinels are correctly
   ignored.
3. **Source the values.** Don't invent them — use `api-fetch` or `api-probe`
   to discover a real `{token}` value, or read the guide's param descriptions
   for format hints.

### P1 fix: sentinel strip in verify loop

**The problem (identified by code review):** The verify loop at
`core/verify-command.ts` passes `supplied` (which may contain sentinel
values from `verify.json`) straight into both `unsatisfiableParams` and
`resolveOpForExecution`. Once an op *runs* (passes the skip check),
`buildQueryParams` (`core/helpers.ts:124-218`) serializes any
`params[key] !== undefined` into the query string — including
`"__FILL_ME__"`. So:

- `requiresAnyOf` with one member filled → the API gets
  `?query=real&tag=__FILL_ME__&category=__FILL_ME__`.
- A sentinel on a now-defaultable param → the default is not applied (the
  check is `val === undefined`), so the API gets `?key=__FILL_ME__` literally.

**The fix:** Strip sentinels from `supplied` in the verify loop **before
both** `unsatisfiableParams` and `resolveOpForExecution`. One place, one
strip:

```typescript
for (const op of ops) {
  const rawSupplied = verifyJson[op.name] ?? {};
  // Strip sentinels → unsatisfiableParams sees undefined (correctly flags
  // as unsatisfiable → skipped), and the executor never sees sentinels.
  const supplied: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawSupplied)) {
    if (v !== "__FILL_ME__") supplied[k] = v;
  }

  const missing = unsatisfiableParams(op, supplied);
  if (missing.length > 0) { skipped++; … continue; }

  const outcome = await resolveOpForExecution(guide, op, dirName, {
    userParams: supplied,
  });
  …
}
```

- `unsatisfiableParams` sees `undefined` → correctly flags the op as
  unsatisfiable → skipped.
- The executor never sees sentinels → `buildQueryParams` stays untouched
  (no sentinel awareness needed).
- The `requiresAnyOf` `some()` check in `buildQueryParams` is also safe
  because sentinels never reach it.

This is a ~5-line pre-filter co-located with the only call site that passes
`verifyJson` values to the executor. `api-fetch` never receives sentinels
(the agent fills real values), so no executor-side change is needed.

### Staging path keying

Today `stagingPathFor(domain)` keys the `/tmp` path by the routing `domain`:
`/tmp/pi-lean-host/<domain>/guide.md`. The agent is told to pass `dirName`
as `domain` on re-save, so it works in practice — but the convention is
implicit and fragile.

**Change:** Both `api-learn` and `api-scaffold` resolve `dirName` from the
guide store (`findGuidesByDomain` → `{guide, dirName}`) and use `dirName`
as the staging dir name: `/tmp/pi-lean-host/<dirName>/`. Deterministic
regardless of routing domain — `archive.org` and `archive.org-wayback`
each get their own `dirName`-keyed staged dir. Eliminates the implicit
"agent passes `dirName` as `domain`" convention.

The `new: true` template path (no existing guide, no `dirName`) stays keyed
by the requested `domain` — there's no `dirName` to resolve yet.

### Gating: toolset masking only

`api-scaffold` is added to `HOST_API_LEARN_SPEC.names` in
`core/api-toggle.ts`:

```typescript
const HOST_API_LEARN_SPEC: ToolsetSpec = {
  id: "pi-lean-dimension.api-learn",
  names: new Set(["api-learn", "api-probe", "api-scaffold"]),
  persistKey: "toolset-state:pi-lean-dimension.api-learn",
  defaultEnabled: false,
  requires: ["pi-lean-dimension.api"],
};
```

- **Toolset masking** is the primary gate — masked off in `/api on` mode,
  available in `/api learn` mode.
- **No hard runtime guard** (`isApiLearnEnabled()`) — same as `api-learn`.
  The tool doesn't access the secrets store, so the defense-in-depth guard
  that `api-probe` uses for `listSecrets` isn't needed.
- **No focus-guard concern** — the focus guard applies only to toggle
  actuation subcommands (`/api on|off|learn`), not to tool execution.

Stale UI text in `core/api-toggle.ts` that hardcodes "four tools" /
"api-learn + api-probe" (the `/api learn`, `/api status`, and help strings)
must be updated.

## Alternatives considered

### Two-tool split vs. single expanded `api-learn`

| | Two-tool split (`api-scaffold` + `api-learn`) | Expand `api-learn` |
|---|---|---|
| Tool count | 4 → 5 | Flat (4) |
| `api-learn` complexity | Stays bounded (stage + save, no scaffold logic) | Gains sentinel/merge/stub code |
| Ownership clarity | `api-learn` = stage+save, `api-scaffold` = bootstrap | `api-learn` owns everything |
| Save validation | `api-learn` validates guide + helper relationship | Same, but mixed with scaffold logic |

**Choice: two-tool split.** Putting sentinel computation, additive merge,
and stub generation inside `api-learn` muddies its ownership (stage + save
is a clean boundary; bootstrap/creation is a different concern). The 5th
tool is justified by real logic across two file types, not a thin wrapper.

### Two-tool split vs. old single-tool (`api-verify-scaffold`)

The old proposal addressed `verify.json` only and ignored `helper.ts` —
the artifact with real-world usage (4/24 caritas guides) and zero agent
authoring support. It also had two P1 gaps (sentinel leak into query
strings; `unsatisfiableParams` composite return shape) flagged by code
review. **Choice: replace it.** The two-tool split addresses both artifacts
and fixes both P1s.

### Sentinel vs. format migration (JSONC/YAML)

| | Sentinel (strict JSON) | JSONC/YAML migration |
|---|---|---|
| Format change | None | New parser, loader change, test/doc updates |
| "Commented out" behavior | ✓ (inactive until filled) | ✓ (literal comments) |
| Agent visibility | Identical (agent reads values, not comments) | Identical |
| New dependency | None | JSONC/YAML parser |

**Choice: sentinel.** The agent can't see comments — it reads JSON values.
The sentinel delivers the authoring UX (inactive until filled) with zero
format change.

### Pull-on-demand vs. auto-scaffold

| | Pull-on-demand (boolean params) | Auto-scaffold on fetch/template |
|---|---|---|
| Noise | Zero — no file unless asked | 20/24 get unneeded `helper.ts`, 24/24 get unneeded `verify.json` |
| Agent control | Full — decides what to create | None — gets everything, deletes what it doesn't need |
| Discovery | Agent must know to ask | Agent sees the full directory shape |

**Choice: pull-on-demand.** The caritas evidence is stark: 4/24 have
`helper.ts`, 0/24 have `verify.json`. Auto-scaffolding both would pollute
the majority case. The agent discovers the need when `api-probe` shows a
param shape that needs transformation, or when `/api verify` skips ops with
unsatisfiable params.

### Mirror-save vs. never-delete

| | Mirror the staged dir | Never-delete (additive only) |
|---|---|---|
| Deletion path | Delete from `/tmp` + save | Separate explicit step (bash or `/api delete`) |
| Data-loss risk | Low (fetch stages all siblings) | Zero |
| API surface | None (deletion = delete file) | Extra flag/mode for intentional deletion |

**Choice: mirror the staged dir.** Fetch-recipe always stages all existing
siblings, so the staged dir is an honest snapshot. Deleting a file from
`/tmp` is an intentional act. The only wipe window is `new: true` over an
existing directory (see [Risks](#risks)).

### Directory-path save vs. file-path + sibling discovery

| | Directory-path (`dir`) | File-path + discover siblings |
|---|---|---|
| Parameter shape | Retires `recipeFile`, adds `dir` | `recipeFile` unchanged |
| Mental model | Staged dir is the save unit | `recipeFile` = `guide.md`, siblings auto-discovered |
| Path length | Slightly shorter (dir, not file) | Same |

**Choice: directory-path.** Honest expression of the new model. Shorter
path for low-param agents. Clean break from the single-file `recipeFile`.

## Tradeoffs

- **Tool count grows 4 → 5.** Honest cost. Justified by real bootstrap
  logic across two file types (sentinel/merge for `verify.json`, stub for
  `helper.ts`), not a thin wrapper.
- **3-call workflow for full bootstrap** (fetch → scaffold → save). Only
  for guides that need siblings (4/24 today, more after caritas adopts
  `verify.json`). For guides without siblings, it's still fetch + save.
- **`verify.json` can accumulate stale entries.** Purely additive on
  initial scaffold; re-scaffold is delete + re-scaffold (no merge).
  Mitigated by the `/tmp` staging surface for manual pruning.
- **`"__FILL_ME__"` is noisier than `null`.** A string sentinel in every
  unfilled slot. Justified by zero collision risk and self-documentation.
- **Mirror-save can wipe siblings on `new: true` rewrite.** See Risks.

## Risks

- **`new: true` saved over an existing directory with siblings.** The
  template stages only `guide.md`; if the agent saves it over a directory
  that has a `helper.ts`, mirror-save removes the helper. Mitigations:
  (a) the overwrite guard already refuses different-`shortName` saves;
  (b) a same-`shortName` `new: true` save is a legitimate "rewrite from
  scratch" where not staging the helper is arguably intentional;
  (c) if the new guide declares `helper: true`, the helper-relationship
  check forces the agent to scaffold/fetch the helper before saving.
- **`api-scaffold` reads from the guides dir while the agent edits in
  `/tmp`.** The scaffold is a snapshot of the *saved* guide, not the staged
  edit. If the guide changes between scaffold and save, the `/tmp` file is
  stale. Re-running the scaffold refreshes it. Same snapshot property as
  `api-learn` fetch-recipe → edit → save.
- **`import()` side effects in save-time validation.** `loadHelper`/
  `loadTransform` set the `disabledHelpers` map on failure. The save-time
  check must not pollute session state — use a non-mutating variant or
  reset after the check. Implementation detail, not a design decision.
- **Agent fills all `requiresAnyOf` members.** The manual says "fill one,"
  but the agent might fill all blindly. Harmless — the op runs (any one
  satisfies the group), and extra values are just extra query params.
- **Path traversal via crafted `domain`.** The save path writes to
  `<guidesDir>/<dirName>/`. Mitigated by `assertSafeDomain(domain)` at the
  top of the save path — the same guard `api-learn` uses today.
- **Sentinel collision with a real API value.** `"__FILL_ME__"` is
  unlikely to be a valid API param value. Low probability; the claim is
  near-absolute but not mathematically guaranteed.

## Testing plan

Follows the existing vitest + mocked-fs pattern (`verify-command.test.ts`,
`api-learn-fetch-recipe.test.ts`).

**`api-scaffold` tests:**

1. **`helper: true` scaffold** — writes a stub `helper.ts` with both exports
   commented out + doc comments to `/tmp/pi-lean-host/<dirName>/helper.ts`.
2. **`verify: true` scaffold** — a guide with ops that have unsatisfiable
   params (path `{token}`, required no-default query, `requiresAnyOf`)
   produces sentinels in the right `{opName: {param: "__FILL_ME__"}}` shape.
3. **`verify` additive merge** — existing real values in the guides-dir
   `verify.json` preserved; new sentinels added for newly-unsatisfiable
   params.
4. **`requiresAnyOf` fill-one** — all members scaffolded with sentinels;
   filling any one makes the op runnable after the sentinel strip.
5. **No unsatisfiable params** — a guide where every op is runnable produces
   an empty `verify.json` scaffold (no entries).
6. **Refuse-to-overwrite** — `api-scaffold` errors if a sibling already
   exists in the staged `/tmp` dir.
7. **`dirName` derived + surfaced** — result surfaces `dirName` and the
   staged dir path.
8. **Multi-recipe disambiguation** — N-guide domain with `guide` selector
   scaffolds the selected guide; absent selector yields a disambiguation
   menu.
9. **Learn-gating** — tool is in `HOST_API_LEARN_SPEC.names` and masked off
   in on-mode.

**`api-learn` multi-file tests:**

1. **Fetch-recipe stages all siblings** — `guide.md` + present
    `helper.ts` + present `verify.json` all staged to `/tmp`.
2. **Directory-path save** — `{domain, dir}` reads all present files from
    the staged dir, writes them to the guides dir.
3. **Mirror-save present → overwrite** — existing guides-dir files
    overwritten by staged versions.
4. **Mirror-save absent → remove** — a sibling absent from the staged dir
    is removed from the guides dir.
5. **Helper-relationship refuse on missing** — save refused if
    `helper: true`/`transform: true` declared but `helper.ts` absent from
    staged dir.
6. **Helper-relationship refuse on import() failure** — save refused if
    `helper.ts` present but `import()` fails.
7. **`verify.json` written as-is** — no JSON validation at save time;
    valid by construction from scaffold.
8. **Staging path keyed by `dirName`** — staging dir is
    `/tmp/pi-lean-host/<dirName>/`, not `/tmp/pi-lean-host/<domain>/`.

**P1 fix tests:**

1. **Sentinel strip in verify loop** — sentinels stripped before both
    `unsatisfiableParams` and `resolveOpForExecution`; scaffolded-but-
    unfilled op skips; executor never receives sentinel values.
2. **`requiresAnyOf` sentinel doesn't leak** — filling one member does not
    send `__FILL_ME__` for the other members in the query string.

**`unsatisfiableParams` return-shape tests:**

1. **Individual member names** — `requiresAnyOf` branch returns individual
    member names, not composite `"one of: ..."` strings.

**Edge cases:**

1. **No existing siblings** → fetch stages only `guide.md`.
2. **`new: true` over existing directory** → template stages only
    `guide.md`; save would remove existing siblings (mitigated by overwrite
    guard for different shortName).
3. **Malformed existing `verify.json` in guides dir** → scaffold can't
    merge; clear error, guides dir untouched.
4. **Path-traversal `domain`** → `assertSafeDomain` rejects before any
    write.

## File touch summary

| File | Change |
|------|--------|
| `core/verify-command.ts` | Export `unsatisfiableParams`; enrich return shape (individual member names, not composite strings); add sentinel strip in verify loop before `unsatisfiableParams` and `resolveOpForExecution` |
| `tools/api-scaffold.ts` | **New file** — tool definition (`domain` + `guide` + `verify`/`helper` booleans, multi-recipe disambiguation, `/tmp` staging keyed by `dirName`, refuse-to-overwrite, sentinel compute + additive merge for `verify.json`, stub generation for `helper.ts`, authoring manual) |
| `tools/api-learn.ts` | Multi-file staging (fetch-recipe stages all siblings); directory-path save (retire `recipeFile`, add `dir`); mirror-save semantics; helper-relationship validation (refuse on missing + refuse on `import()` error); staging path keyed by `dirName` |
| `tools/index.ts` | Export `apiScaffoldTool`; update the barrel comment (currently "all 4 tool definitions" → 5) |
| `core/api-toggle.ts` | Add `"api-scaffold"` to `HOST_API_LEARN_SPEC.names`; update stale UI text that hardcodes "four tools" / "api-learn + api-probe" |
| `index.ts` | `pi.registerTool(apiScaffoldTool)` |
| `package.json` | Add `"tools/api-scaffold.ts"` to the `files` array (`ship-manifest.test.ts` tripwire) |
| `__tests__/api-scaffold.test.ts` | **New file** — tests 1–9, 21–23 |
| `__tests__/api-learn-multi-file.test.ts` | **New file** (or extend `api-learn-fetch-recipe.test.ts`) — tests 10–17, 22 |
| `__tests__/verify-command.test.ts` | Add tests 18–20 (sentinel strip, no-leak, return-shape) |

## Downstream

An implementation plan is the next artifact, **after team review** of this
design doc. The plan would sequence: (1) `unsatisfiableParams` export +
return-shape fix, (2) verify-loop sentinel strip (P1 fix), (3) `api-scaffold`
tool (`helper` + `verify` paths, refuse-to-overwrite, `/tmp` staging), (4)
`api-learn` multi-file staging + directory-path save + mirror-save, (5)
helper-relationship validation, (6) staging path keying by `dirName`, (7)
`HOST_API_LEARN_SPEC` update + stale UI text, (8) `tools/index.ts` export +
barrel comment, (9) `index.ts` registration, (10) `package.json` `files`
entry, (11) authoring manual, (12) test files.
