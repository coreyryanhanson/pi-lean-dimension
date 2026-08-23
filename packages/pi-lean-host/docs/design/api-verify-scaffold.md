# `api-verify-scaffold` — Agent-Facing `verify.json` Bootstrap

> Design doc for a new learn-mode tool that scaffolds the `/api verify`
> sidecar (`verify.json`) with sentinel placeholders for the params that
> currently make verify skip ops. **Status: draft for team review.** An
> implementation plan is downstream of this review.

## Problem

`/api verify <domain>` runs every runnable op of a guide against its live
API and stamps `verified: today` when all runnable ops pass. Ops with
**unsatisfiable params** are *skipped*, not failed — they don't block the
stamp, but they also don't get verified. An op is unsatisfiable when it has:

- A **path `{token}`** param with no supplied value (path params are never
  defaultable — they're filled from the params map).
- A **`required: true` query param** with no `default` and no supplied value.
- A **`requiresAnyOf`** group where no member is supplied.

The only way an unsatisfiable op can run is if a co-located
`~/.pi/agent/pi-lean-host/api-guides/<dirName>/verify.json` sidecar supplies
the value. The sidecar shape is `{ "<opName>": { "<param>": "<value>" } }`,
loaded via strict `JSON.parse` in `loadVerifyJson()` (`core/verify-command.ts`).

**The gap:** there is no agent-facing way to *produce or maintain* this
sidecar. The agent has to know the shape, read the guide, figure out which
params are unsatisfiable, hand-write the JSON, and write it to the guides
directory — a path that invites direct edits to the guides dir (the exact
habit `api-learn`'s `/tmp` staging exists to prevent). And when a guide
changes (new op, renamed param, added default), there's no maintenance story
for updating the sidecar.

## Goals

1. Give the agent a **learn-gated tool** that scaffolds `verify.json` with
   sentinel placeholders for exactly the params that make verify skip.
2. Make the scaffold **re-runnable** — a maintenance operation, not a
   one-time bootstrap. Re-running after a guide change adds sentinels for
   newly-unsatisfiable params while preserving existing real values.
3. Make the scaffold **additive** — never delete existing entries on the
   agent's behalf.
4. Mirror `api-learn`'s **`/tmp` staging pattern** so the agent learns the
   right reflex (edit staged files, not guides-dir files).
5. Require **zero format change** to `verify.json` — no new dependency, no
   loader migration, no parser duplication.

## Non-goals

- Scaffolding optional no-default params (the scaffold targets only *blocking*
  params — optional params are the agent's manual choice).
- Pruning stale entries automatically (purely additive; the human/agent owns
  deletions via the `/tmp` staging surface).
- Auto-scaffolding on `api-learn` save (explicit agent invocation only).
- Migrating `verify.json` to JSONC/YAML for literal comments.
- Expanding `api-learn` or `/api verify` to own this responsibility.

## Design

### Sentinel semantics (strict JSON)

`verify.json` is strict JSON — no comments. Instead of migrating the format,
the scaffold writes a **sentinel value** for each unsatisfiable param:

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

(The `search` op has a `requiresAnyOf: [query, tag, category]` group — every
member gets a sentinel; the agent fills any one. See
[`requiresAnyOf` → sentinel on every member](#requiresanyof--sentinel-on-every-member).)

The sentinel `"__FILL_ME__"` is:

- **Never a valid API value** — no real API accepts this string as a param,
  so there's no collision with intentional values.
- **Self-documenting** — the string *is* the instruction. A human reading the
  file knows what to do without a separate annotation.
- **Treated as "not supplied"** by the verify pipeline — a scaffolded-but-
  unfilled op still skips. The guard is a trivial `=== "__FILL_ME__"` check,
  co-located in `unsatisfiableParams` (see below).

This delivers the *behavior* of commented-out values (visible scaffold,
inactive until filled) without a format change. The agent can't see comments
anyway — it reads JSON values, not annotations.

### Sentinel guard in `unsatisfiableParams`

The guard lives in `unsatisfiableParams()` in `core/verify-command.ts`, the
function that already computes the blocking predicate. Each branch that
checks `supplied[key] === undefined` gains an additional
`supplied[key] === "__FILL_ME__"` check:

```typescript
// Path params
if (supplied[token] === undefined || supplied[token] === "__FILL_ME__")
  missing.push(token);

// requiresAnyOf group
const anySupplied = group.some(
  (name) => supplied[name] !== undefined && supplied[name] !== "__FILL_ME__",
);

// Required query params with no default
if (
  spec.required &&
  spec.default === undefined &&
  (supplied[key] === undefined || supplied[key] === "__FILL_ME__")
)
  missing.push(key);
```

**Why here, not in `loadVerifyJson`:** the sentinel is semantically "not
supplied," which is the predicate's concept. Co-locating the guard with the
predicate means any future consumer of `unsatisfiableParams` gets the sentinel
semantics for free — no hidden pre-filter step they could forget. One place,
one meaning.

**Export:** `unsatisfiableParams` is currently private to `verify-command.ts`.
The scaffold tool needs to call it to compute which params to scaffold, so it
is exported from `verify-command.ts` as part of this change. The codebase's
"one parser, two call sites" philosophy applies — do not duplicate the logic
in the tool. (Moving it to a shared `core/verify-params.ts` is an alternative
if the export grows extra dependents; not warranted for a single new caller.)

### New learn-mode tool: `api-verify-scaffold`

A dedicated, learn-gated tool — the 5th host tool (alongside `api-guide`,
`api-fetch`, `api-learn`, `api-probe`). Two call modes, mirroring `api-learn`.
A `guide?: string` shortName selector is accepted in both modes for
multi-recipe domain disambiguation (see
[Multi-recipe domain disambiguation](#multi-recipe-domain-disambiguation)):

| Call | Action |
|------|--------|
| `{domain}` (no `verifyFile`) | **Scaffold**: resolve the guide (disambiguate via `guide` if the domain maps to N guides), read the parsed guide, compute unsatisfiable params, additive-merge with the existing guides-dir `verify.json` at the resolved `dirName`, write the full merged result to `/tmp/pi-lean-host/<dirName>/verify.json`. Prepend the authoring manual to the result. |
| `{domain, verifyFile}` | **Save**: `assertSafeDomain(domain)`, read the `/tmp` file, validate it's valid JSON, write to `<guidesDir>/<dirName>/verify.json` (the `dirName` resolved at scaffold time, not the routing domain). No merge at save — the `/tmp` file IS the next state. |

**Tool name rationale:** `api-verify-scaffold` is the most self-documenting
option. "verify" + "scaffold" disambiguates from the `/api verify` *command*
(run ops). Agent-invoked tools and user-invoked commands occupy different
surfaces and don't collide.

### Multi-recipe domain disambiguation

A routing domain can map to N guide directories — `findGuidesByDomain`
returns `{guide, dirName}[]` and `buildDomainMap` is `Record<string, string[]>`
(e.g. `archive.org` → `archive.org` + `archive.org-wayback`). The scaffold
must resolve a single guide before it can compute unsatisfiable params or
know which directory to write `verify.json` to.

The tool mirrors `api-learn`'s resolution: a `guide?: string` shortName
selector parameter, with `findGuidesByDomain` + `selectGuideByShortName`
for N-guide resolution and a disambiguation menu when the selector is
absent and the domain maps to >1 guide. The scaffold and save both operate
on the resolved `dirName` (the on-disk guide directory), **not** the routing
domain — `verify.json` lives alongside `guide.md` in the directory, so the
path is `<guidesDir>/<dirName>/verify.json`. This is the same
directory-vs-domain distinction `api-fetch` already makes (helper routed by
`dirName`, secrets routed by `canonicalStoreDomain`).

### Full `/tmp` staging (mirror `api-learn`)

The scaffold writes to `/tmp/pi-lean-host/<dirName>/verify.json` — **not**
directly to the guides dir. The agent edits the staged file, then calls
`{domain, verifyFile}` to save.

**Why not direct-write** (the tempting option, since the merge is safe and
idempotent): if `verify.json` is direct-writable in the guides dir, the agent
generalizes "I can edit files in the guides dir directly" to `guide.md` —
which is exactly the habit `api-learn`'s staging exists to prevent. The
`api-learn` save output even warns: *"Edit the staged /tmp file, not the saved
guide.md — direct edits are overwritten on save and invisible to api-fetch
until then."* Consistency in the staging pattern teaches the right reflex
across both authoring tools.

### Additive merge at scaffold time

The merge happens **at scaffold time**, not at save time:

1. Scaffold call reads the existing guides-dir `verify.json` (if any).
2. Computes unsatisfiable params from the parsed guide.
3. For each unsatisfiable param not already present with a real (non-sentinel)
   value in the existing file, adds a `"__FILL_ME__"` sentinel.
4. Writes the **full merged result** to `/tmp`.

The `/tmp` file IS the next state — the agent sees the complete picture
(existing real values + new sentinels) and edits it directly. Save is a
straight validate-and-write. This mirrors `api-learn`'s fetch-recipe mode,
which stages the *entire* current recipe so the agent edits the real thing,
not a delta.

### Purely additive — never delete

The merge **only adds**. It never deletes:

- **Op removed from guide** → the op's entry in `verify.json` is preserved
  (stale but harmless; the op simply doesn't exist to verify).
- **Param now has a `default`** (was unsatisfiable, now runnable) → the
  param's entry is preserved. ⚠ This is **not always harmless**: if the
  stale entry still holds a `"__FILL_ME__"` sentinel, the sentinel guard no
  longer fires (the required-query branch checks `spec.default === undefined`),
  so the op runs with `?key=__FILL_ME__` as the real value → likely a 400/404
  that *blocks* the stamp (a failure, not a skip). The re-scaffold therefore
  **replaces stale sentinels on params that now have a `default`** with a
  clear `"__HAS_DEFAULT__"` marker (still treated as unsupplied by an
  extended guard on the defaultable branch, or simply left to the default —
  see [Sentinel guard on now-defaultable params](#sentinel-guard-on-now-defaultable-params)).
  Real values the human filled in are always preserved.
- **Real values the human filled in** → always preserved.

Re-running only grows the file. The agent/human owns deletions — and the
`/tmp` staging gives a natural place to prune before saving if the file
accumulates cruft.

### Only blocking params scaffolded

The scaffold targets **exactly** the params `unsatisfiableParams` flags —
the ones that make verify *skip*. An op with no unsatisfiable params gets no
entry. Optional no-default params (query params that aren't `required`, have
no `default`, and aren't in a `requiresAnyOf` group) are **not** scaffolded —
they don't block verify, and documenting every possible param is `api-guide`'s
job (via `params.<name>.description`), not the scaffold's.

### `requiresAnyOf` → sentinel on every member

A `requiresAnyOf` group says "at least one of these must be supplied." The
scaffold writes `"__FILL_ME__"` on **every** member:

```json
{
  "search": {
    "query": "__FILL_ME__",
    "tag": "__FILL_ME__",
    "category": "__FILL_ME__"
  }
}
```

The agent fills **any one** member with a real value → that member passes the
sentinel guard → the group's `some()` check returns true → the op runs. The
remaining sentinels are treated as unsupplied, which is exactly correct for a
"one of" group. This shows the agent the full menu of choices without
arbitrary picks or fake group-level placeholder keys.

### Compact authoring manual

A short manual is prepended to the scaffold result (mirroring `api-learn`'s
`AUTHORING_MANUAL` pattern). It covers the decisions the agent has to make
that aren't obvious from the JSON alone:

1. **`"__FILL_ME__"` means "replace with a real value."** The sentinel is
   treated as unsupplied; the op skips until you replace it.
2. **For `requiresAnyOf` groups, fill any ONE member — not all.** The op runs
   when any member is supplied; the remaining sentinels are correctly ignored.
3. **The merge is additive.** Existing real values are preserved; re-running
   adds sentinels for newly-unsatisfiable params only. Prune stale entries
   here in `/tmp` before saving if needed.
4. **Source the values.** Don't invent them — use `api-fetch` or `api-probe`
   to discover a real `{token}` value, or read the guide's param descriptions
   for format hints.

The save call (`{domain, verifyFile}`) is terse — by then the agent has
already read the manual.

### Gating: toolset masking only

The tool is added to `HOST_API_LEARN_SPEC.names` in `core/api-toggle.ts`:

```typescript
const HOST_API_LEARN_SPEC: ToolsetSpec = {
  id: "pi-lean-dimension.api-learn",
  names: new Set(["api-learn", "api-probe", "api-verify-scaffold"]),
  persistKey: "toolset-state:pi-lean-dimension.api-learn",
  defaultEnabled: false,
  requires: ["pi-lean-dimension.api"],
};
```

- **Toolset masking** is the primary gate — the tool is masked off in `/api on`
  mode, available in `/api learn` mode.
- **No hard runtime guard** (`isApiLearnEnabled()`) in the execute function —
  same as `api-learn`. The tool doesn't access the secrets store, so the
  defense-in-depth guard that `api-probe` uses for `listSecrets` isn't needed.
- **No focus-guard concern** — the focus guard applies only to toggle
  actuation subcommands (`/api on|off|learn`), not to tool execution.

## Alternatives considered

### Sentinel vs. format migration (JSONC/YAML)

| | Sentinel (strict JSON) | JSONC/YAML migration |
|---|---|---|
| Format change | None | New parser, loader change, test updates, `--help`/doc updates |
| "Commented out" behavior | ✓ (inactive until filled) | ✓ (literal comments) |
| Agent visibility | Identical (agent reads values, not comments) | Identical |
| New dependency | None | JSONC/YAML parser |
| Merge complexity | Trivial (`===` guard) | Parser-dependent |
| Parser invariant | Unchanged | New parser to maintain alongside the guide parser |

**Choice: sentinel.** The agent can't see comments — it reads JSON values.
The sentinel delivers the exact authoring UX (inactive until filled) with
zero format change.

### Hybrid (strict JSON + commented `.jsonc` scaffold)

A variant: keep `verify.json` as strict JSON for the loader, but emit a
sibling `verify.jsonc` with real comments for the human to read/copy from.
**Rejected:** two files is more moving parts, the agent reads the JSON not
the JSONC, and the human-facing benefit is marginal when the sentinel string
itself is self-documenting.

### New tool vs. expanding `api-learn`

| | New tool (`api-verify-scaffold`) | Expand `api-learn` |
|---|---|---|
| Tool count | 4 → 5 | Flat (4) |
| Ownership clarity | `api-learn` = `guide.md`, scaffold = `verify.json` | `api-learn` owns two files |
| Mode complexity | 2 modes (scaffold + save) | `api-learn` gains a 4th mode |
| Learn boundary | Explicit, dedicated | Muddied |

**Choice: new tool.** `api-learn`'s three modes are all about `guide.md`.
Adding `verify.json` authoring muddies its ownership. A dedicated tool keeps
the boundary clean — the same reasoning that gave `api-probe` its own tool.

### New tool vs. expanding `/api verify --scaffold`

`/api verify` is always-available (on-mode, not learn-gated). A `--scaffold`
flag would put a scaffold-write on an on-mode command, blurring the learn/on
boundary. The scaffold is an authoring action (complements the guide
authoring process), so it belongs in learn mode. **Choice: new learn-gated
tool.**

### New tool vs. auto-on-save

Silently scaffolding `verify.json` as a side effect of `api-learn` save is
the smallest diff, but it's implicit — the agent doesn't ask for it, can't
control the merge, and a silent write to the guides dir on every save is
surprising. **Choice: explicit tool invocation.**

### Direct-write vs. `/tmp` staging

| | Direct-write + preview | Full `/tmp` staging |
|---|---|---|
| Call count | 1 (scaffold + merge + write) | 2 (scaffold to /tmp, then save) |
| Safety | Additive merge (idempotent) | Additive merge + review gate |
| Agent reflex | "I can write to the guides dir" | "I edit /tmp, then save" |
| Consistency with `api-learn` | Diverges | Mirrors |

**Choice: full `/tmp` staging.** The key argument: if `verify.json` is
direct-writable, the agent generalizes to `guide.md`. Consistency in the
staging pattern teaches the right reflex. The two-call cost is honest
friction for a guides-dir write.

### Merge timing: scaffold-time vs. save-time

| | Scaffold-time merge | Save-time merge |
|---|---|---|
| `/tmp` file content | Full next state (existing + new) | Delta (new sentinels only) |
| Agent visibility | Sees the full picture | Sees only new entries |
| Save call | Straight validate-and-write | Read + merge + write |
| Merge logic location | One place (scaffold) | Split across save |

**Choice: scaffold-time merge.** The agent should see the full file it's
about to save, not a delta. Mirrors `api-learn`'s fetch-recipe showing the
entire recipe.

### Reconciling vs. purely additive merge

| | Purely additive | Reconciling (prune stale) |
|---|---|---|
| File cleanliness | Grows over time | Stays clean |
| Data safety | Never deletes | Silently removes entries |
| Trust | High (no surprises) | Lower (tool-driven deletions) |
| Stale entry handling | Preserved (harmless) | Pruned |

**Choice: purely additive.** Silent deletions by a tool erode trust. The
`/tmp` staging gives the agent/human a natural place to prune before saving.
Re-running only grows the file; the human owns deletions.

## Tradeoffs

- **Tool count grows 4 → 5.** Honest cost. Justified by ownership clarity
  (same reasoning as `api-probe`).
- **Two-call workflow.** More friction than direct-write. Justified by the
  agent-reflex argument — consistency with `api-learn`'s staging pattern.
- **File can accumulate stale entries.** Purely additive means cruft over
  time. Mitigated by: (a) the `/tmp` staging surface for manual pruning,
  (b) stale entries are harmless (ops don't exist → never read, params with
  defaults → ignored or used, both fine).
- **`"__FILL_ME__"` is noisier than `null`.** A string sentinel in every
  unfilled slot. Justified by zero collision risk and self-documentation.

## Risks

- **Agent fills all `requiresAnyOf` members.** The manual says "fill one,"
  but the agent might fill all blindly. Mitigated by: the authoring manual,
  and the fact that filling all is *harmless* — the op runs (any one
  satisfies the group), and extra values are just extra query params (the API
  ignores or uses them).
- **Sentinel guard drift.** If a future consumer of `unsatisfiableParams`
  forgets the sentinel check... but the guard is in the predicate itself, so
  this can't happen. That's why it's there, not in the loader.
- **Guide changes after scaffold but before save.** The scaffold is a
  snapshot. If the guide changes between scaffold and save, the `/tmp` file
  is stale. Re-running the scaffold refreshes it. Same property as `api-learn`
  fetch-recipe → edit → save (the recipe is a snapshot).
- **Path traversal via crafted `domain`.** The save path writes to
  `<guidesDir>/<dirName>/verify.json`. Without a guard, a `domain` like
  `../../etc` could write outside the guides dir. Mitigated by calling
  `assertSafeDomain(domain)` at the top of the save path — the same guard
  `api-learn` uses before writing `guide.md`.

### Sentinel guard on now-defaultable params

The required-query branch of `unsatisfiableParams` is gated on
`spec.default === undefined`. Once a param gains a `default`, the branch no
longer runs, so a leftover `"__FILL_ME__"` sentinel is no longer treated as
unsupplied — the op runs with the sentinel as the literal value and likely
fails (blocking the stamp). Two options:

1. **Re-scaffold replaces the sentinel** with `"__HAS_DEFAULT__"` and the
   guard treats `"__HAS_DEFAULT__"` as unsupplied on the defaultable branch
   too (a second `===` check, this time outside the `spec.default === undefined`
   condition). The default then applies. One extra guard line.
2. **Re-scaffold deletes the sentinel** on now-defaultable params — breaks
   pure-additivity for this one case, but the entry is genuinely obsolete.

**Choice: option 1.** Preserves the purely-additive invariant (the file only
grows) and keeps the guard story uniform (sentinels are always unsupplied,
wherever they appear). The `"__HAS_DEFAULT__"` marker is self-documenting in
the same way `"__FILL_ME__"` is.

## Testing plan

Follows the existing `verify-command.test.ts` vitest + mocked-fs pattern.

**Must-prove tests (8):**

1. **Scaffold correctness** — a guide with ops that have unsatisfiable params
   (path `{token}`, `required: true` no-default query, `requiresAnyOf` group)
   produces sentinels in the right `{opName: {param: "__FILL_ME__"}}` shape.
2. **Sentinel-as-unsupplied** — `unsatisfiableParams` treats `"__FILL_ME__"`
   (and `"__HAS_DEFAULT__"` on the defaultable branch) as unsupplied → a
   scaffolded-but-unfilled op still skips in `/api verify`.
3. **Additive merge** — existing real values preserved; new sentinels added
   for newly-unsatisfiable params; stale entries (op removed) preserved, not
   deleted; a param that gained a `default` has its stale sentinel replaced
   with `"__HAS_DEFAULT__"` (real values preserved).
4. **`requiresAnyOf` fill-one** — all members scaffolded with sentinels;
   filling any one makes the op runnable; the rest stay sentinel and are
   correctly ignored.
5. **No unsatisfiable params** — a guide where every op is runnable produces
   an empty scaffold (no entries).
6. **Learn-gating** — tool is in `HOST_API_LEARN_SPEC.names` and masked off
   in on-mode.
7. **Save path** — `{domain, verifyFile}` calls `assertSafeDomain`, reads the
   `/tmp` file, validates JSON, writes to `<guidesDir>/<dirName>/verify.json`.
8. **Multi-recipe disambiguation** — a domain mapping to N guides scaffolds
   the guide named by the `guide` selector; absent selector with N>1 yields a
   disambiguation menu; save writes to the resolved `dirName`, not the routing
   domain.

**Edge cases (4):**

1. **No existing `verify.json`** → fresh scaffold (all sentinels, no merge).
2. **Malformed existing `verify.json`** → error handling (the scaffold can't
   merge with garbage — clear error, guides dir untouched).
3. **`/tmp` file missing on save** → clear error, guides dir untouched.
4. **Path-traversal `domain`** → `assertSafeDomain` rejects before any write
   (guides dir untouched).

## File touch summary

| File | Change |
|------|--------|
| `core/verify-command.ts` | Export `unsatisfiableParams`; add `=== "__FILL_ME__"` (and `=== "__HAS_DEFAULT__""` on the defaultable branch) sentinel guard to each branch |
| `tools/api-verify-scaffold.ts` | **New file** — tool definition (scaffold + save modes, `guide` selector + multi-recipe disambiguation, `assertSafeDomain` on save, `/tmp` staging, scaffold-time merge, authoring manual) |
| `tools/index.ts` | Export `apiVerifyScaffoldTool`; update the barrel comment (currently "all 4 tool definitions" → 5) |
| `core/api-toggle.ts` | Add `"api-verify-scaffold"` to `HOST_API_LEARN_SPEC.names`; update stale UI text that hardcodes "four tools" / "api-learn + api-probe" (the `/api learn`, `/api status`, and help strings) |
| `index.ts` | `pi.registerTool(apiVerifyScaffoldTool)` |
| `package.json` | Add `"tools/api-verify-scaffold.ts"` to the `files` array (the `ship-manifest.test.ts` tripwire asserts every production `.ts` is listed) |
| `__tests__/api-verify-scaffold.test.ts` | **New file** — 7 must-prove tests + 3 edge cases (below) |

## Downstream

An implementation plan is the next artifact, **after team review** of this
design doc. The plan would sequence: (1) export + sentinel guard (incl.
`__HAS_DEFAULT__`) in `unsatisfiableParams`, (2) new tool file with `guide`
selector + multi-recipe disambiguation + `assertSafeDomain` on save +
`/tmp` staging + scaffold-time merge, (3) `HOST_API_LEARN_SPEC` update +
stale UI text, (4) `tools/index.ts` export + barrel comment, (5) `index.ts`
registration, (6) `package.json` `files` entry, (7) authoring manual,
(8) test file.
