# Implementation Plan — `api-scaffold` + `api-learn` Split

> Sequenced implementation of [`api-verify-scaffold.md`](./api-verify-scaffold.md).
> Read that design doc first — this plan assumes its decisions are settled.
>
> **Sprint order is a dependency chain**, not a suggestion: each sprint's
> acceptance criteria gate the next. Sprints 1–2 are pure refactors of
> existing code (zero behavior change, byte-identical verify output); Sprints
> 3–4 build new tools on the foundation they expose; Sprints 5–6 wire the
> tool in and pay down the test debt the refactor creates.

## Sprint map

| Sprint | What | Files touched | Risk | Parallelizable after? |
|--------|------|---------------|------|----------------------|
| 1 | `unsatisfiable` 3-function split | `core/verify-command.ts`, `__tests__/verify-command.test.ts` | Low — pure refactor, byte-identical output | Yes (with S2) |
| 2 | Verify-loop sentinel strip (P1 fix) | `core/verify-command.ts`, `__tests__/verify-command.test.ts` | Low — ~5-line pre-filter | Yes (with S1) |
| 3 | `api-scaffold` tool | `tools/api-scaffold.ts` (new), `__tests__/api-scaffold.test.ts` (new) | Medium — new tool, two artifact paths | After S1 |
| 4 | `api-learn` multi-file staging + mirror-save + helper validation | `tools/api-learn.ts`, `__tests__/api-learn-fetch-recipe.test.ts`, `__tests__/api-learn-multi-file.test.ts` (new) | High — retires `recipeFile`, breaks ~20 call sites | After S3 (scaffold writes the staged dir learn saves) |
| 5 | Toggle + registry wiring | `core/api-toggle.ts`, `tools/index.ts`, `index.ts`, `package.json` | Low — mechanical | After S4 (not S3 — see note) |
| 6 | Authoring manual + docs sweep | `tools/api-scaffold.ts`, `tools/api-learn.ts`, READMEs | Low — prose | After S4 |

> **Sprints 1 and 2 are order-independent** — neither's correctness depends
> on the other, so they can be applied in either order. They touch *adjacent
> lines in the same loop body* (S1 at ~line 217, S2 at ~line 216), so a true
> two-agent simultaneous edit will likely git-conflict on the same hunk; read
> "parallelizable" as "order-independent, sequential application is clean," not
> "conflict-free concurrent edit." Everything else is sequential.
>
> **S5 must land after S4, not after S3.** S5 registers `api-scaffold` with
> `pi.registerTool`, and its result tells the agent to pass `dir` to
> `api-learn` save — but `api-learn` still expects `recipeFile` until S4
> lands. Registering the tool before S4 would ship a broken scaffold→save
> handoff that S5's isolated smoke test (`api-scaffold({domain, verify: true})`
> writes to `/tmp`) would not catch, because it doesn't exercise the save side.
>
> **S4 and S6 must ship in the same release.** S4 retires `recipeFile` from
> the schema and all call sites; S6 sweeps the agent-visible `recipeFile`
> nudge strings across 6 source files (`tools/api-guide.ts`, `tools/api-fetch.ts`,
> `core/helpers-command.ts`, `core/parse-api-guide.ts`). If S4 ships without
> S6, nudges tell the agent to pass a param `api-learn` no longer accepts —
> actively misleading, not merely stale. The smallest fix is to fold the
> 6-string sweep into S4's acceptance (see S4 work item 12), so the sweep
> can't slip a release behind the schema change.

---

## Sprint 1 — `unsatisfiable` 3-function split

**Goal.** Extract the "what is unsatisfiable" business rule out of its
composite-string renderer so `api-scaffold` (Sprint 3) can consume the
structured shape, **without** regressing the live verify report.

**Why first.** It's a pure refactor with byte-identical output — the lowest-
risk change, and it unlocks the structured `Unsatisfiable[]` that Sprint 3's
sentinel renderer needs. Doing it first means Sprint 3 imports a stable
export instead of reaching into a private function.

### Work

1. In `core/verify-command.ts`, define the discriminated union:

   ```typescript
   type Unsatisfiable =
     | { kind: "path"; param: string }
     | { kind: "group"; members: string[] }
     | { kind: "query"; param: string };
   ```

2. Replace the private `unsatisfiableParams(op, supplied): string[]` with an
   exported `unsatisfiable(op, supplied): Unsatisfiable[]` holding the three
   branches (pathParams → `path`; unsatisfied `requiresAnyOf` → one `group`
   entry; required-no-default query → `query`). Same rule, structured shape.
3. Add `renderForReport(items: Unsatisfiable[]): string[]` — private, used
   only by the verify loop. Reconstructs today's exact strings: `group` →
   `` `one of: ${members.join(", ")}` ``, `path`/`query` → bare `param`.
   Exhaustive `switch` over `kind`.
4. Add exported `renderForSentinels(items: Unsatisfiable[]): string[]` —
expands `group` to individual member names (one sentinel each), `path`/
`query` bare. Exhaustive `switch` over `kind`.
5. The exhaustive `switch` is the type-level guarantee (a fourth `kind` →
compile error). The acceptance check below (add a temp `kind: "x"`, watch
tsc fail, revert) is a **one-time manual confirmation, not a regression
test** — do not leave the temp kind committed.
6. At the single call site (verify loop, ~line 217): replace
   `unsatisfiableParams(op, supplied)` with
   `renderForReport(unsatisfiable(op, supplied))`.

### Acceptance criteria

- [ ] `core/verify-command.ts` exports `unsatisfiable` and
      `renderForSentinels`; `renderForReport` stays module-private.
- [ ] The `Unsatisfiable` discriminated union is defined with exactly the
      three `kind` values; both renderers `switch` exhaustively (compile
      error if a fourth kind is added without handling — one-time manual
      confirmation by adding a temporary `kind: "x"` and watching tsc fail,
      then revert; not a committed regression test).
- [ ] **Byte-identical verify report.** The existing verify report-line test
      in `__tests__/verify-command.test.ts` passes unchanged — no assertion
      edits, no new fixtures. This is the proof the refactor is behavior-
      preserving.
- [ ] No other call site of the old `unsatisfiableParams` remains
      (`grep -rn unsatisfiableParams` returns only the renderer definition,
      if any).
- [ ] `npm run test:ci` green; `npx vitest run __tests__/verify-command.test.ts` green.

---

## Sprint 2 — verify-loop sentinel strip (P1 fix)

**Goal.** Close the P1 sentinel-leak bug identified in the design doc:
sentinels from `verify.json` currently flow into `buildQueryParams` and
serialize into the query string. Fix it with one strip at the only call
site that bridges `verifyJson` → executor.

**Why here.** Independent of Sprint 1 (touches the same loop, different
concern). Tiny, isolated, and unblocks the sentinel contract Sprint 3
relies on — `"__FILL_ME__"` must mean "inactive" end-to-end or the scaffold
is unsafe to ship.

### Work

In `core/verify-command.ts`, inside the per-op loop, before both
`unsatisfiable`/`unsatisfiableParams` and `resolveOpForExecution`:

```typescript
const rawSupplied = verifyJson[op.name] ?? {};
const supplied: Record<string, unknown> = {};
for (const [k, v] of Object.entries(rawSupplied)) {
  if (v !== "__FILL_ME__") supplied[k] = v;
}
```

Then use `supplied` (not `rawSupplied`) for the missing-params check and
the executor call. No change to `buildQueryParams`, `helpers.ts`, or
`api-fetch` — the executor never sees sentinels.

### Acceptance criteria

- [ ] The verify loop strips `"__FILL_ME__"` values from `supplied` before
      the missing-params check and before `resolveOpForExecution`.
- [ ] **Sentinel strip test:** a mocked-transport verify run with a
      `verify.json` carrying `{"op": {"id": "__FILL_ME__"}}` skips that op
      (unsatisfiable) — the executor is never called
      (assert the transport mock receives zero calls for that op).
- [ ] **No-leak test (`requiresAnyOf`):** a `requiresAnyOf: [query, tag, category]` op with
      `{"op": {"query": "real", "tag": "__FILL_ME__", "category": "__FILL_ME__"}}`
      runs and the serialized request URL contains `query=real` but **not**
      `__FILL_ME__` (assert against the captured request URL/params).
- [ ] **No-leak test (`passthrough`):** a `passthrough: true` op with a
      sentinel-valued agent param also strips the sentinel before the
      executor — the serialized request URL/params contain **no**
      `__FILL_ME__`. (The strip removes the key from `supplied` entirely, so
      `buildQueryParams` sees `undefined` and skips it; this assertion closes
      the passthrough path the `requiresAnyOf` test doesn't cover.)
- [ ] No real-value regression: a `verify.json` with all-real values behaves
      exactly as before (existing tests stay green).
- [ ] `npm run test:ci` green.

---

## Sprint 3 — `api-scaffold` tool

**Goal.** Ship the learn-gated bootstrap tool that writes starter
`helper.ts` and/or `verify.json` into `/tmp` staging — never the guides dir.

**Depends on.** Sprint 1 (`renderForSentinels` + `unsatisfiable` exports).

### Work

1. **New file `tools/api-scaffold.ts`** with `defineTool`:
   - Params: `domain: string`, `guide?: string`, `verify?: boolean`,
     `helper?: boolean`. Validation error if neither `verify` nor `helper`
     is `true` (names the constraint, no `/tmp` write).
   - Guide resolution mirrors `api-learn` fetch-recipe exactly:
     `findGuidesByDomain` + `selectGuideByShortName`, disambiguation menu
     for N-guide domains with no selector. Reuse the same helpers — do not
     duplicate the resolution path.
   - Staging dir keyed by `slug(shortName)` →
     `/tmp/pi-lean-host/<slug(shortName)>/` (same pattern `api-learn`
     already ships). Surface `dirName` and the staged dir path in the
     result.
   - **Refuse-to-overwrite:** if `helper.ts` or `verify.json` already
     exists in the staged `/tmp` dir, error naming the file and instruct
     deletion-then-re-call. No merge on re-scaffold.
   - **`helper: true` path:** write the commented-out stub template from the
     design doc (both default + `transform` exports commented, with doc
     comments). Self-documenting.
   - **`verify: true` path:** for each op, compute
     `renderForSentinels(unsatisfiable(op, {}))`; if non-empty, emit
     `{ "<opName>": { "<param>": "__FILL_ME__" } }`. If the guides dir has
     an existing `verify.json`, load + additive-merge (preserve real values,
     add sentinels for newly-unsatisfiable params); a malformed guides-dir
     `verify.json` → clear error, guides dir untouched. An op with no
     unsatisfiable params contributes no entry (an all-runnable guide →
     empty `{}`).
   - **`loadVerifyJson` export:** `loadVerifyJson` is currently module-
     private in `core/verify-command.ts` (only `handleVerifySubcommand` is
     exported). The scaffold needs to load an existing guides-dir
     `verify.json` for the additive-merge. Export `loadVerifyJson` (add the
     `export` keyword — the function body is unchanged). This is the one
     exception to the cross-cutting "`loadVerifyJson` is not modified"
     acceptance: the `export` keyword is added, the logic is not. Do **not**
     inline a second read-and-parse in the scaffold — that duplicates the
     loader.
   - **Both true:** write both files to the same staged dir in one call;
     surface both paths.
   - Authoring manual prepended to the result (the 3-line manual from the
     design doc: sentinel meaning, fill-one-for-groups, source-real-values).
     State the save-first-then-scaffold ordering explicitly.
2. **New file `__tests__/api-scaffold.test.ts`** — mocked-fs, covering the
   11 design-doc test cases + malformed-guides-dir-`verify.json` edge case.

### Acceptance criteria

- [ ] `tools/api-scaffold.ts` exists; `pi.registerTool` call is **not** added
      yet (that's Sprint 5) — the tool is importable and unit-tested in
      isolation.
- [ ] At least one of `verify`/`helper` is required; both-false → validation
      error, no `/tmp` write, message names the "at least one" constraint.
- [ ] `helper: true` writes the design-doc stub to
      `/tmp/pi-lean-host/<dirName>/helper.ts` with both exports commented
      out and doc comments intact.
- [ ] `verify: true` on a guide with path-`{token}`, required-no-default
      query, and `requiresAnyOf` ops produces
      `{"<opName>": {"<param>": "__FILL_ME__"}}` for every flagged param;
      `requiresAnyOf` members each get a sentinel.
- [ ] **Additive merge:** existing real values in a guides-dir `verify.json`
      are preserved; new sentinels added only for newly-unsatisfiable params.
- [ ] **Refuse-to-overwrite** fires when a sibling already exists in the
      staged `/tmp` dir; message names the file and the delete-then-re-call
      path.
- [ ] All-runnable guide → empty `verify.json` scaffold (`{}`), no per-op
      entries.
- [ ] `dirName` is derived (never a param) and surfaced in the result with
      the staged dir path.
- [ ] N-guide domain: `guide` selector scaffolds the selected one; absent
      selector yields the disambiguation menu (matches `api-learn`).
- [ ] Malformed guides-dir `verify.json` → clear error, no `/tmp` write,
      guides dir untouched.
- [ ] `npx vitest run __tests__/api-scaffold.test.ts` green (all 11 cases +
      edge case).

---

## Sprint 4 — `api-learn` multi-file staging + mirror-save + helper validation

**Goal.** Expand `api-learn` from single-file to directory-level staging and
mirror-save, retire `recipeFile` for `dir`, and validate the guide↔helper
relationship at save time.

**Depends on.** Sprint 3 — *soft / workflow-level dependency*, not a code
dependency: `api-learn`'s changes don't import or call `api-scaffold.ts`, and
the `dir` param is *designed* to receive the path `api-scaffold` produces. S4
could proceed if S3 slipped, with `dir` receiving the fetch-recipe staging
path instead. The dependency is real for the end-to-end workflow and for
testing the scaffold→save handoff, not for compilation. **Highest-risk
sprint:** retiring `recipeFile` breaks active call sites in **three** test
files — `__tests__/api-learn-fetch-recipe.test.ts` (~5 active refs at lines
84, 93, 97, 346, 363; the earlier "~20" figure counted comments/test names),
`__tests__/tools.test.ts` (lines 586, 866), and
`__tests__/local-helpers.test.ts` (lines 426, 464, 510).

### Work

1. **Fetch-recipe stages all present siblings.** Today it stages only
   `guide.md`; change it to copy `guide.md` (always), `helper.ts`, and
   `verify.json` (when present) from the guide dir to the staged `/tmp` dir.
   Staged dir name already keys by `slug(shortName)` (shipped) — no keying
   change. **Refactor the staging helpers:** `stagingPathFor`/
   `writeStagedDraft` (`tools/api-learn.ts:68-79`) currently hardcode
   `guide.md` in the path (`join(_stagingRoot, key, "guide.md")`) and return a
   *file* path; multi-file staging needs them to return the staged *directory*
   path so `helper.ts`/`verify.json` write to the same dir. Also update
   `renderCall` (`tools/api-learn.ts:640`), which checks `args.recipeFile` for
   the 📝 icon — switch it to `args.dir`.
2. **Retire `recipeFile`, add `dir` + undescribed `confirmDeletions`.**
   - `dir`: staged directory path (surfaced by fetch/template/scaffold).
   - `confirmDeletions`: boolean in the schema, **not** in the tool
     description — discovered only via the deletion-gate refusal message.
   - `domain` stays cosmetic on save (write target self-keys off the draft's
     `shortName`).
3. **Mirror-save semantics:**
   - Present staged files → overwrite the guides-dir counterpart.
   - Absent staged files (but present in guides dir) → **deletion-safety
     gate** first (see below), then remove.
4. **Deletion-safety gate.** Before mirroring, compute the deletion set
   (siblings in the guides dir but absent from the staged `/tmp` dir). If
   non-empty, refuse with the design-doc message naming the doomed files
   and the `confirmDeletions: true` re-call path. On `confirmDeletions:
   true`, proceed and surface which files were written and which deleted in
   the result. Gate does not fire on fetch→edit→save (all siblings staged)
   or a first-time save of a brand-new guide.
5. **Guide↔helper validation at save time** (after the deletion gate, before
   writing) — self-contained in `tools/api-learn.ts`, does **not** touch
   `core/local-helpers.ts`:
   1. Does any op declare `helper: true` or `transform: true`? No → skip
      helper validation entirely (normal case; a stray staged `helper.ts`
      is inert). Yes → continue.
   2. Is `helper.ts` present in the staged dir? No → refuse, name the
      declaration, offer scaffold-or-drop-declaration. Yes → continue.
   3. `await import(stagedHelperPath)` — refuse on load failure (any throw)
      OR missing declared export (`helper: true` → default export;
      `transform: true` → `transform` named export).
   - No `loadHelper`/`loadTransform` calls (those hit `getUserGuidesDir()`
     and mutate `disabledHelpers` — a save-time check must not).
6. **`verify.json` written as-is** — no JSON validation at save time (valid
   by construction from scaffold; manual edits caught by `loadVerifyJson`
   at verify time).
7. **Non-existent `dir`** → clear error replacing today's
   `recipe_file_unreadable` path for the `dir` case; guides dir untouched.
8. **Update `__tests__/api-learn-fetch-recipe.test.ts`** — rewrite the
   active `recipeFile` call sites (lines ~84, 93, 97, 346, 363) to the `dir`
   parameter and adjust assertions. Not optional: retiring `recipeFile` fails
   these tests as-is.
9. **Update `__tests__/tools.test.ts`** — rewrite the active `recipeFile`
   call sites at lines ~586 (`p.recipeFile = staged` in `callLearn`) and ~866
   (`recipeFile: join(tmpStagingRoot, "escape", "guide.md")` argument) to `dir`.
10. **Update `__tests__/local-helpers.test.ts`** — rewrite the active
    `recipeFile` call sites at lines ~426, 464, 510 (`stagedRecipe(...)`
    arguments) to `dir`.
11. **New `__tests__/api-learn-multi-file.test.ts`** (or extend the updated
   fetch-recipe file) — the 11 design-doc `api-learn` test cases + edge
   cases (no siblings; `new: true` over existing distinct/same `shortName`;
   path-traversal `domain`).
12. **Fold the agent-visible `recipeFile` string sweep into S4** (was S6
   work item 4). S4 retires `recipeFile` from the schema; the 6 source-file
   nudge strings must move to `dir` in the same sprint so no release ships
   a registered `api-learn` that tells the agent to pass a param it no
   longer accepts. Rewrite these sites (verify with grep — line numbers may
   drift):

- `tools/api-guide.ts:80` — `"Call api-learn({domain, recipeFile}) to author one."`
- `tools/api-fetch.ts:65` — `"Call api-learn({domain, recipeFile}) to author a new guide."`
- `tools/api-fetch.ts:522` — `"re-author one guide via api-learn({recipeFile: …})"`
- `tools/api-fetch.ts:582` — `"api-learn({domain: "${domain}", recipeFile: …})"`
- `core/helpers-command.ts:58` — `"Call api-learn({domain, recipeFile}) to author or update a guide"`
- `core/parse-api-guide.ts:2040` — `"call api-learn({domain, recipeFile}) to author one"`

### Acceptance criteria

- [ ] Fetch-recipe stages `guide.md` + present `helper.ts` + present
      `verify.json` to `/tmp/pi-lean-host/<slug(shortName)>/`.
- [ ] `{domain, dir}` save reads all present files from the staged dir and
      writes them to the guides dir. `recipeFile` is gone from the schema,
      the description, and all call sites.
- [ ] **Mirror-save present → overwrite:** staged versions overwrite
      guides-dir files.
- [ ] **Deletion gate refuses without `confirmDeletions`:** a sibling in
      the guides dir but absent from the staged dir makes save refuse and
      name the doomed file; re-call with `confirmDeletions: true` removes it
      and the result surfaces the deletion.
- [ ] **Deletion gate does not fire on the common path:**
      fetch → edit → save (all siblings staged) proceeds without
      `confirmDeletions`.
- [ ] **Declaration + absent helper → refuse:** an op declaring
      `helper: true`/`transform: true` with no staged `helper.ts` refuses;
      error names the declaration and offers scaffold-or-drop.
- [ ] **No declaration → no helper check:** a guide with no helper/transform
      declarations saves fine with no staged `helper.ts`.
- [ ] **Present helper must load:** staged `helper.ts` that throws on
      `import()` (syntax error) → refuse.
- [ ] **Present helper must satisfy declarations:** `helper: true` with no
      default export → refuse (symmetric for `transform: true` + `transform`
      named export).
- [ ] `verify.json` written as-is (no save-time JSON validation).
- [ ] Non-existent `dir` → clear error, guides dir untouched.
- [ ] **`new: true` over existing:** distinct `shortName` → own dir, existing
      guide untouched (no wipe); same `shortName` → deletion gate refuses,
      `confirmDeletions: true` proceeds (overwrite guard refuses slug
      collisions independently).
- [ ] **Path-traversal `domain`:** `assertSafeDomain` rejects before any
      write.
- [ ] `core/local-helpers.ts` has **no new export** for this validation
      (grep confirms the check is self-contained in `tools/api-learn.ts`).
- [ ] `stagingPathFor`/`writeStagedDraft` refactored to directory-level
      (return dir path, not file path); `renderCall` checks `args.dir`.
- [ ] `__tests__/tools.test.ts` and `__tests__/local-helpers.test.ts`
      `recipeFile` call sites rewritten to `dir` (no stale `recipeFile`
      argument reaches `apiLearnTool.execute`).
- [ ] **Agent-visible `recipeFile` strings swept to `dir`** (folded from
      S6): `grep -rn recipeFile packages/pi-lean-host/{tools,core}` returns
      nothing after S4 — the 6 nudge strings are rewritten in the same
      sprint as the schema retirement.
- [ ] `npx vitest run __tests__/api-learn-fetch-recipe.test.ts` green;
      `npx vitest run __tests__/api-learn-multi-file.test.ts` green (if
      split out); `npx vitest run __tests__/tools.test.ts` green;
      `npx vitest run __tests__/local-helpers.test.ts` green.
- [ ] `npm run test:ci` green.

---

## Sprint 5 — toggle + registry wiring

**Goal.** Register `api-scaffold` in the learn toolset, update stale UI text,
export it from the barrel, register it with pi, and add it to the ship
manifest. Mechanical, low-risk, but blocking the tool from actually running.

**Depends on.** Sprint 4 (not Sprint 3 — see the sprint-map note). S5
registers `api-scaffold` with `pi.registerTool`, and its result tells the
agent to pass `dir` to `api-learn` save. Until S4 lands, `api-learn` still
expects `recipeFile`, so registering the tool before S4 ships a broken
scaffold→save handoff. S5's isolated smoke test would not catch this
because it doesn't exercise the save side.

### Work

1. **`core/api-toggle.ts`:** add `"api-scaffold"` to
   `HOST_API_LEARN_SPEC.names`:

   ```typescript
   const HOST_API_LEARN_SPEC: ToolsetSpec = {
     id: "pi-lean-dimension.api-learn",
     names: new Set(["api-learn", "api-probe", "api-scaffold"]),
     persistKey: "toolset-state:pi-lean-dimension.api-learn",
     defaultEnabled: false,
     requires: ["pi-lean-dimension.api"],
   };
   ```

   Update stale UI text that hardcodes "four tools" / "api-learn +
   api-probe" (the `/api learn`, `/api status`, and help strings) to name
   five tools / `api-learn + api-probe + api-scaffold`.
2. **`tools/index.ts`:** export `apiScaffoldTool`; update the barrel comment
   ("all 4 tool definitions" → 5).
3. **`index.ts`:** `pi.registerTool(apiScaffoldTool)`.
4. **`package.json`:** add `"tools/api-scaffold.ts"` to the `files` array.

### Acceptance criteria

- [ ] `api-scaffold` is in `HOST_API_LEARN_SPEC.names`; the toolset still
      `defaultEnabled: false` and `requires: ["pi-lean-dimension.api"]`.
- [ ] `/api on` masks `api-scaffold` off; `/api learn` unmasks it
      (toolset-masking is the only gate — no hard runtime guard added).
- [ ] No focus-guard concern (toggle actuation only, not tool execution) —
      confirm no `isApiLearnEnabled`-style guard was added for `api-scaffold`.
- [ ] Stale UI text updated: grep for "four tools" / "api-learn + api-probe"
      in `core/api-toggle.ts` returns nothing; the updated strings name all
      three learn-gated tools.
- [ ] `tools/index.ts` exports `apiScaffoldTool`; barrel comment says 5.
- [ ] `index.ts` calls `pi.registerTool(apiScaffoldTool)`.
- [ ] `package.json` `files` array includes `"tools/api-scaffold.ts"`.
- [ ] `__tests__/ship-manifest.test.ts` green (the tripwire catches a
      missing `files` entry); `__tests__/tools.test.ts` green (counts 5
      tools if it asserts a count).
- [ ] `__tests__/api-toggle.test.ts` green after the UI-text update.
- [ ] `npm run test:ci` green.
- [ ] **End-to-end smoke** (manual or scripted): with `/api learn` on,
      `api-scaffold({domain, verify: true})` runs and writes to `/tmp`;
      with `/api on`, the tool is masked off (call rejected by masking, not
      by a runtime guard).

---

## Sprint 6 — authoring manual + docs sweep

**Goal.** Land the compact authoring manual in the `api-scaffold` result,
refresh `api-learn`'s manual for the directory-level model, and sweep
package/portal docs for the 4→5 tool count and the new workflow.

**Depends on.** Sprint 4 (the `api-learn` manual references `dir`, not
`recipeFile`).

### Work

1. **`api-scaffold` authoring manual** (the 3-line manual from the design
   doc, prepended to the result): sentinel meaning; fill-one-for-groups;
   source-real-values. Plus the save-first-then-scaffold ordering note.
2. **`api-learn` manual update:** retire `recipeFile` references in
   `AUTHORING_MANUAL` and result strings; describe `dir` and the
   fetch→(scaffold)→save workflow; document the deletion-safety gate and
   `confirmDeletions` discovery pattern (refusal message → re-call).
3. **Docs sweep:** update `packages/pi-lean-host/AGENTS.md` (tool list 4→5,
   `api-scaffold` description, the multi-file staging model, the
   guide↔helper validation, the deletion-safety gate, the `dir`/`confirmDeletions`
   params) and `packages/pi-lean-host/README.md` (tool count, workflow
   summary). Add a CHANGELOG entry.
4. **Runtime `recipeFile` string sweep across source** — moved to S4 work
   item 12 (the sweep must land in the same sprint as the schema retirement).
   S6's remaining `recipeFile`-related work is the doc/AGENTS.md sweep (work
   item 3) and confirming the cross-cutting grep is clean post-S4.

### Acceptance criteria

- [ ] `api-scaffold` result prepends the 3-line manual + the
      save-first-then-scaffold ordering note.
- [ ] `api-learn`'s `AUTHORING_MANUAL` and all result strings reference
      `dir`, never `recipeFile` (grep confirms zero `recipeFile` mentions
      in `tools/api-learn.ts`).
- [ ] `api-learn` manual documents the deletion-safety gate and that
      `confirmDeletions` is discovered via the refusal message (not the tool
      description — the design doc's undescribed-param contract, which is
      novel in this package: every existing `api-learn`/`api-probe` param
      carries a `description:` today, so this is a new pattern, not a
      precedent).
- [ ] `packages/pi-lean-host/AGENTS.md` tool list shows 5 tools with
      `api-scaffold`; the `api-learn` entry describes multi-file staging,
      `dir`/`confirmDeletions`, mirror-save, the deletion gate, and
      guide↔helper validation.
- [ ] `README.md` tool count and workflow summary updated.
- [ ] **Confirm S4's source sweep held** — `grep -rn recipeFile
      packages/pi-lean-host/{tools,core}` still returns nothing after S6's
      doc edits (S4 owns the sweep per work item 12; S6 confirms no regressions).
- [ ] CHANGELOG entry added under the lockstep version block.
- [ ] `npm run test:ci` green (manual text is asserted by existing
      `api-learn`/`api-scaffold` tests — confirm no string-assertion
      regressions).

---

## Cross-cutting acceptance (the whole feature)

These must all hold before the feature is considered done, regardless of
which sprint shipped them:

- [ ] **No new runtime dependency** added to `package.json` (sentinel
      approach, not JSONC/YAML).
- [ ] **`verify.json` format unchanged** — `loadVerifyJson` is not modified
      except for adding the `export` keyword (S3); the verify *loop* that
      consumes its output is the only other touch.
- [ ] **`core/local-helpers.ts` has no new export** — the save-time helper
      validation is self-contained in `tools/api-learn.ts`.
- [ ] **`core/helpers.ts` (`buildQueryParams`) unchanged** — sentinel
      awareness lives only in the verify-loop strip (Sprint 2).
- [ ] **Tool count 4 → 5** consistently across schema, registry, toggle,
      barrel, package.json `files`, AGENTS.md, README.md, and any test that
      asserts a count.
- [ ] **`npm run test:ci` green** end-to-end.
- [ ] **`npm run test:py-bridge`** unaffected (host-only change, but run to
      confirm no monorepo-level regression).
- [ ] **`__tests__/ship-manifest.test.ts` green** — the tarball tripwire
      catches a missing `files` entry or an unintended inclusion.

## Out of scope (explicitly deferred per the design doc)

- Scaffolding optional no-default params in `verify.json`.
- Pruning stale `verify.json` entries on re-scaffold (delete + re-scaffold
  only; no merge-on-re-scaffold).
- Auto-scaffolding on `api-learn` save (explicit invocation only).
- Migrating `verify.json` to JSONC/YAML.
- Save-time JSON validation of `verify.json`.
- A hard runtime guard for `api-scaffold` (toolset masking is the only gate).
