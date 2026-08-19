# API-Guide Authoring-Flow Redesign — Implementation Plan

> Companion to [`authoring-flow-redesign.md`](./authoring-flow-redesign.md).
> That doc owns the *what* and *why* (the 11 decisions + 1 non-decision);
> this doc owns the *when* and *done*: sprints, scope per sprint, and
> acceptance criteria. References like "D7" / "D9" point at decisions in the
> design doc.
>
> Ponytail framing applies: D2 and D3 are **non-changes** (parser already
> implements respect-if-present/default-today; `api-fetch` already read-only),
> D1 is the one-workstream framing — none of the three produce code. They are
> listed as acceptance criteria under the sprints that *touch* their
> invariants, not as standalone work.

## Sprints at a glance

| Sprint | Wave | Decisions shipped | Command-surface change? | New files |
|--------|------|-------------------|-------------------------|-----------|
| S0 — Foundation | 1 | D7, D-bootstrap (revised: stamp + floor-default + stale detection), D6 (worked-example half) | No | — |
| S1 — Probe scaffold | 2 | D6 (probe-scaffold half), D11 | No | — |
| S2 — Fetch-recipe | 2 | D9, D12 | No | — |
| S3 — `/api verify` | 2 | D4 | Yes (new subcommand) | `core/verify-command.ts` |
| S4 — `/api delete` | 2 | D10 | Yes (new subcommand) | `core/delete-command.ts` |
| S5 — Release | — | ship-manifest, CHANGELOG, docs | — | — |

S0 has no dependencies and closes both HIGH-severity CMC issues (issue #1 via
D6's `static-key` docs, issue #2 via D7). It also stands up the **schemaVersion
detection** feature end-to-end (parser floor-default + save-stamp + stale
warning), which is the realization of the "schemaVersion as breaking-change
detection" intent (see *Schema-version framing correction* below). S1–S4
compose on S0 in dependency order; S3 and S4 share command-dispatch plumbing,
so S4 should land only after S3 has wired the `verify` / `delete` peers into
the dispatch switch (the plumbing for the second command is then one `case`).

### Schema-version framing correction (load-bearing)

The design doc's D-bootstrap framed `schemaVersion` as "attribution, never
enforcement" and proposed defaulting an *absent* field to `GUIDE_SCHEMA_VERSION`
(current) on read. That framing is **superseded** by review: `schemaVersion`'s
purpose is **detection of which guides might have been broken by an intervening
schema bump**, since schema changes are treated as breaking changes with **no
backwards-compat shims** (guides are user-authored and easily updateable; the
field was introduced when `~/caritas` was split off). Three consequences, all
resolved by review:

1. **Stamp on save** — `api-learn` writes `schemaVersion: <GUIDE_SCHEMA_VERSION>`
   into `guide.md` on every save so each guide records the schema vintage it
   was authored against. Without a per-guide vintage on disk there is nothing
   to detect against. (The S1 scaffold template emits the same literal.)
2. **Absent-on-read defaults to `0` (the floor), not current** — an unversioned
   guide must flag as potentially-stale after any bump, not silently inherit
   the new current version. This realigns the code with the *existing*
   `AGENTS.md` text ("absent defaults to `0`") — D-bootstrap had proposed the
   opposite — and fixes the doc/code drift the design doc flagged, in the
   direction the field's purpose requires.
3. **Stale detection surface** — a loaded guide whose `schemaVersion <
   GUIDE_SCHEMA_VERSION` gets a `⚠ schemaVersion N < current M — guide may
   need updating` line in the `api-guide()` catalog/disambiguation view **and**
   a note on `api-fetch`. **Never a gate** — the guide still loads and runs;
   detection, not enforcement. This **overturns** the current `AGENTS.md` /
   `schema-version.test.ts` "never warns" rule (see S5).

The bump rule itself ("bump only when a guide that used to parse now fails to
parse") is unchanged — it was always the breaking-change definition; what's
new is the *response* to a bump (warn on stale guides) instead of silent
attribution.

## S0 — Foundation (Wave 1)

**Goal.** Close both HIGH-severity CMC issues **and** stand up schemaVersion
drift detection end-to-end — all with no command-surface changes and no new
files (pure edits to the parser, `api-learn`'s write path, the worked example,
and the `api-guide` / `api-fetch` render surfaces). Landable and reviewable in
isolation.

### Scope

- **D7 — Delimiter diagnostic.** In `parseApiGuide` (`core/parse-api-guide.ts`
  ~L1027–1036), the `!match` branch currently always says "no frontmatter
  found". When the opening delimiter is present but `FRONTMATTER_RE` doesn't
  match, the real cause is a closing-`---` problem. Diagnose that specifically,
  covering two edge cases a bare `startsWith("---\n")` check misses:
  - **CRLF line endings.** Detect the opening delimiter with `/^---\r?\n/`
    (not `startsWith("---\n")`) so a `---\r\n`-prefixed file is recognized as
    having its opener and routed to the closing-`---` diagnostic instead of
    the misleading "no frontmatter found".
  - **Closing `---` present but malformed.** `FRONTMATTER_RE` requires a
    trailing `\r?\n` after the closing `---`, so `---\nfoo: bar\n---` (no
    trailing newline at EOF) fails to match even though the closer is there.
  Distinguish "no closing `---` at all" from "closing `---` present but
  malformed/missing trailing newline" (e.g. check whether `\n---` appears
  after the opening delimiter) so the `fix` hint points at the right edit.
- **D-bootstrap (parser) — absent `schemaVersion` defaults to `0` (floor).**
  In `parseApiGuide` (~L1172–1185) an absent `schemaVersion` is currently left
  `undefined`; default it to `0` (the floor / oldest known vintage), **not**
  `GUIDE_SCHEMA_VERSION`. This realigns the code with the existing `AGENTS.md`
  text ("absent defaults to `0`") and is what makes drift detectable after a
  bump (an unversioned guide must not silently inherit the new current). A
  malformed (non-integer / negative / non-integer-float) value still falls back
  to `0` rather than rejecting the guide — the guide always loads.
- **D-bootstrap (write path) — `api-learn` stamps `schemaVersion` on save.**
  On the save path (`api-learn.ts`, after `parseApiGuide` succeeds, before
  `writeFileSync`), ensure the raw recipe's frontmatter carries
  `schemaVersion: <GUIDE_SCHEMA_VERSION>`. Implement the line-level frontmatter-isolation approach (`FRONTMATTER_RE` →
  operate on the frontmatter block only → reassemble), which S3's verify stamp later reuses: if the field is present,
  line-replace `^schemaVersion:\s*.+$`; if absent, insert before the closing
  `---`. Do **not** YAML-round-trip (reformats + strips comments). This is the
  per-guide vintage that detection compares against.
- **D-bootstrap (detection) — stale warning on `api-guide` + `api-fetch`.**
  Factor a pure helper `isStaleSchema(guideSchemaVersion, currentSchemaVersion):
  boolean` (so tests can exercise it without a real bump). When a loaded
  guide's `schemaVersion < GUIDE_SCHEMA_VERSION`:
  - `api-guide()` catalog / disambiguation view **and `renderGuideDetail()`**: append a `⚠ schemaVersion N
    < current M — guide may need updating` line (peer of the existing
    `⚠ malformed — <dirName>: <field>` line at `parse-api-guide.ts:1468` —
    note the code reads `mal.filename`, which is set to the directory name at load
    time, so the rendered text is the `dirName`).
  - `api-fetch`: append a staleness note to the fetch result text (not the
    `details` machine channel — the note is for the agent/human reader).
  - **Never a gate**: the guide still loads and `api-fetch` still runs. This is
    detection, not enforcement.
  - **Mode boundary**: the `api-fetch` note is read-only (writes nothing to
    `guide.md`) and is not learn-mode behavior (hygiene note, not authoring) —
    D1/D3 invariants hold.
- **D6 (worked-example half).** In `tools/api-learn.ts` the `WORKED_EXAMPLE`
  const (L37+) hardcodes `updated: 2026-07-15` / `verified: 2026-07-15` and
  documents only `auth: kind: none`. Drop the two hardcoded dates (replace
  with a comment that the tool stamps them when omitted — this is the
  load-bearing D2 close) and add a second `auth:` example showing
  `kind: static-key` with `requires` + `secretRefs` + `headerPrefixes`.

### Out of scope (explicitly)

- D6 probe-scaffold half → S1.
- D2/D3 *code* — none needed; this sprint *verifies* the invariants hold (see
  acceptance criteria) but writes no D2/D3 code.

### Acceptance criteria

- **D7**
  - A recipe that opens with `---\n` but has no closing `---` produces an
    error whose message names the **missing closing `---`** (not "no
    frontmatter found"), with a `fix` hint pointing at the closer.
  - A recipe with no opening `---` at all still produces the existing
    "no frontmatter found" diagnostic (the common case is unchanged).
  - Existing well-formed guides parse unchanged (regression: `all-guides-parse`
    test stays green).
- **D-bootstrap (parser)**
  - A guide with no `schemaVersion` frontmatter parses to
    `parsed.guide.schemaVersion === 0` (the floor — **not** current).
  - A guide with an explicit valid `schemaVersion` keeps that value.
  - A guide with a malformed `schemaVersion` (e.g. `"zero"`, `-1`, `1.5`)
    falls back to `0` instead of rejecting the guide.
- **D-bootstrap (write path)**
  - `api-learn({domain, recipe})` saves a `guide.md` whose frontmatter
    contains `schemaVersion: <GUIDE_SCHEMA_VERSION>`, whether or not the
    agent-supplied recipe included the field.
  - The stamp touches **only** the `schemaVersion:` line inside the isolated
    frontmatter block; a `schemaVersion:` string in the prose body is never
    matched. Comments and key ordering elsewhere in the frontmatter are
    preserved (no YAML round-trip) — same rules as the S3 `verified` stamp.
- **D-bootstrap (detection)**
  - A loaded guide with `schemaVersion < GUIDE_SCHEMA_VERSION` renders a
    `⚠ schemaVersion N < current M — guide may need updating` line in the
    `api-guide()` catalog and a staleness note on `api-fetch`.
  - A guide with `schemaVersion === GUIDE_SCHEMA_VERSION` renders no warning.
  - The warning **never blocks** load or fetch — the guide still parses and
    `api-fetch` still executes (detection, not a gate).
  - `api-fetch` writes nothing to `guide.md` (D3 read-only invariant holds);
    the note is render-only.
  - `isStaleSchema(0, 1)` → true; `isStaleSchema(1, 1)` → false;
    `isStaleSchema(2, 1)` → false (a guide stamped ahead of current is not
    stale — it was authored against a newer schema than the running host).
- **D-bootstrap (test rewrite — hard gate)**
  - `__tests__/schema-version.test.ts` is rewritten: it currently encodes
    the old "attribution, never enforcement / never warns" framing and would
    fail the moment detection lands, so the rewrite ships **in the same S0
    PR** — S0 is not done while the old test remains. The rewritten test keeps
    the "never gates load" assertion, inverts the "never warns" assertion
    (a stale guide now warns in the `api-guide` catalog + on `api-fetch`, a
    current guide does not), and asserts absent → `0` (not current) + the
    `isStaleSchema` truth table.
- **D6 (worked-example half)**
  - The `WORKED_EXAMPLE` const contains no literal `updated:` / `verified:`
    date; a comment notes the tool stamps them when omitted.
  - The worked example shows both `auth: kind: none` **and** a `kind:
    static-key` block with `requires`, `secretRefs`, and `headerPrefixes`.
  - The worked example still parses cleanly (`all-guides-parse` / `tools`
    tests that exercise it stay green).
- **D2 invariant (no code, verify only)**
  - A recipe supplied to `api-learn` *without* `verified` saves with
    `verified === TODAY()` (parser default path unchanged).
  - A recipe supplied *with* an explicit `verified` saves with that exact
    value (parser respect-if-present path unchanged — no strip/override on the
    save path).
- **D3 invariant (no code, verify only)**
  - `api-fetch` imports only `findGuidesByDomain` from `guide-store` (no write
    import); a successful `api-fetch` does not touch `guide.md` mtime. The S0
    staleness note is render-only and does not change this. (Covered by the
    existing host-only-boundary / fetch tests — confirm still green.)

### Tests to add / rewrite

- `parse-api-guide.test.ts`: missing-closing-`---` case asserts the new
  diagnostic; no-opening-`---` case asserts the old one is preserved.
- `schema-version.test.ts` **(rewrite — it encodes the old "never warns"
  framing and is now wrong)**: absent → `0` (not current); malformed → `0`
  fallback; explicit valid → kept; and the **detection** behavior — a stale
  guide (`schemaVersion < current`) surfaces a warning in the `api-guide`
  catalog and on `api-fetch`, while a current guide does not. The "never gates
  load" assertion stays; the "never warns" assertion is inverted.
- `api-learn` schemaVersion-stamp test: saving a recipe with no
  `schemaVersion` and one with an explicit older `schemaVersion` both produce a
  `guide.md` whose frontmatter carries `schemaVersion: <GUIDE_SCHEMA_VERSION>`;
  the stamp touches only that line (prose-body `schemaVersion:` fixture never
  matched); comments + key order preserved.
- `isStaleSchema` pure-helper test: `(0,1)`→true, `(1,1)`→false, `(2,1)`→false.
- `tools.test.ts` (or `api-learn` test): assert the worked-example string no
  longer contains a literal `2026-07-15` date and contains a `static-key`
  block.

Note on testability: during beta `GUIDE_SCHEMA_VERSION === 0`, so no real guide
is stale yet. The detection tests force staleness via the pure helper
(`isStaleSchema(0, 1)`) and via a fixture guide carrying `schemaVersion: 0`
compared against a `current` arg — they do not depend on a real bump.

---

## S1 — Probe scaffold (Wave 2)

**Goal.** `api-probe({scaffold: true})` emits the whole recipe skeleton (not
just the op block) when no guide exists for the domain, and auto-degrades to a
single op block + merge note when one or more guides already claim the domain.
Closes issues #4 (probe auth shape ≠ guide schema), #6 (no full-scaffold), and

# 7 (no keyed-auth guide to crib from — addressed by scaffold emitting the

`auth:` block).

**Depends on:** S0 (the worked example's `static-key` block is the docs-side
discoverability that composes with this tool-side scaffold).

### Scope

- **D6 (probe-scaffold half).** Add a `scaffold: true` opt-in param to
  `api-probe`. In scaffold-bootstrap mode, `emitDraft` is preceded by the
  top-level recipe skeleton: `kind: api`, `domains: [<hostname-derived>]`,
  `apiHost`, `responseShape: json`, `gatherAllMax: 1000`, a `schemaVersion:
  <GUIDE_SCHEMA_VERSION>` literal (the same value `api-learn` would stamp on
  save — so a probe-scaffolded guide is detection-ready the moment it's
  saved), and an `auth:` block **translated from the probe's existing
  auth-injection params**
  (`secretRefs` / `headerPrefixes` / `secretQueryRefs` → `kind: static-key` +
  `requires: [<names>]`). Op block = today's `emitDraft` output.
  **Pagination stays op-level only** (per the risk note: a single probe
  justifies one op's `pagination:`, never a top-level default).
- **D11 — Scaffold auto-degrade.** The scaffold decision is driven by
  `findGuidesByDomain(domain)` (already returns `{ guide, dirName }[]`):
  - **0 guides** → full skeleton (bootstrap).
  - **1 guide** → single guide-formatted op block + merge note naming the
    target `dirName` (e.g. "merge into `archive.org`").
  - **N guides** → single op block + merge note listing **every** candidate
    `dirName`; defers the merge-target choice to S2's `api-learn({domain,
    guide})` selector. No new param on `api-probe`.
- Opt-in, not always-on (preserves today's paste-just-op workflow). The agent
  can pass `scaffold: true` on every probe safely and never get conflicting
  `---` blocks.

### Acceptance criteria

- **D6**
  - `api-probe({apiHost, path, scaffold: true, auth: {secretRefs: {Authorization: apiKey}, headerPrefixes: {Authorization: "Bearer "}}})` with **no existing guide** for the hostname emits a recipe
    that parses cleanly and whose `auth` block is `kind: static-key` with
    `requires: [apiKey]` and the matching `secretRefs` / `headerPrefixes`.
  - The scaffolded skeleton includes `domains`, `apiHost`, `responseShape`,
    `gatherAllMax`, `schemaVersion: <GUIDE_SCHEMA_VERSION>`, and the `auth:`
    block; pagination is **op-level only** (no top-level `pagination:` in the
    scaffold).
  - `api-probe` without `scaffold: true` is byte-identical to today's output
    (op block only) — the existing workflow is preserved.
- **D11**
  - With one guide claiming the domain, `scaffold: true` emits **no** `---`
    frontmatter (single op block) + a merge note naming the one `dirName`.
  - With N guides claiming the domain, `scaffold: true` emits a single op
    block + a merge note listing every candidate `dirName`.
  - The decision is driven by `findGuidesByDomain(domain)` — no new store
    lookup machinery, no new param on `api-probe`.
- The tool description names `scaffold: true` and its auto-degrade behavior.

### Tests to add

- `api-probe.test.ts`: scaffold-bootstrap emits a parseable skeleton with
  `auth: static-key` translated from injection params (issue #4 close);
  single-guide and N-guide cases assert op-block-only + the merge note names
  the right `dirName`(s); `scaffold` absent → today's output unchanged
  (snapshot/byte-equality).
- Assert no top-level `pagination:` appears in any scaffold output (the
  issue-#5 guardrail).

---

## S2 — Fetch-recipe (Wave 2)

**Goal.** Close the read loop for editing: `api-learn({domain})` with no
`recipe` returns the current raw recipe (instead of today's "Recipe is
required" error), with `dirName` surfaced to prevent the multi-recipe
sibling-clobber accident. Adds the `new: true` fresh-template gesture and the
manual-vs-template entry-point split.

**Depends on:** S0 (entry-point split reuses the worked-example refactor).
Composes with S1 (probe op blocks merge into fetched recipes).

### Scope

- **D9 — Fetch-recipe affordance.** Repurpose the `domain + no recipe` branch
  of `api-learn` from "error" to "return current raw recipe", keyed by guide
  count. **Note: the guide store caches parsed `ApiGuide` objects only, not
  raw strings** — returning the raw recipe requires a new
  `readFileSync(join(getUserGuidesDir(), dirName, "guide.md"), "utf-8")` call
  in the `api-learn` path; this is new file I/O, not wiring up an existing
  primitive. The 0-guide and `new:true` branches return a template (no read
  needed); only the 1-guide / N-guide branches read the raw file:
  - **0 guides** → fresh domain-specific template (pre-fills `domains:
    [<domain>]`; reuses the `new:true` template branch).
  - **1 guide** → that guide's raw recipe **with `dirName` surfaced** ("pass
    this as `domain` when re-saving").
  - **N guides** → D12 disambiguation menu, then the selected guide's raw
    recipe with `dirName` surfaced.
- **D9 — `dirName` surfacing.** The write path keys on `domain` = literal
  subdirectory name (`api-learn.ts:277–281`); the fetch-recipe response
  **must** surface the resolved `dirName` so the agent passes the dirName, not
  the routing domain, back on save (zero new write-path params).
- **D9 — `new: true` gesture.** `api-learn({domain, new: true})` returns the
  domain-specific template regardless of existing guides (the second-guide-on-
  a-domain path). Pre-fills `domains` only; other fields are placeholders for
  the agent to fill (op block sourced from `api-probe({scaffold: true})` in
  S1). Reuses the bootstrap template branch. Note: `new` is a reserved word — destructure as `{ new: isNew }` or access via `params['new']`.
- **D9 — Entry-point split.** Bare `api-learn()` → the **manual** (field
  reference, defaults, semantics) + a pointer to `api-learn({domain, new:
  true})` for a domain-specific starter; **no** worked-example recipe
  (superseded by `new:true`). `api-learn({domain, new: true})` → the
  **template** only, no instruction block. The template is a separate const
  (`WORKED_EXAMPLE`); the instruction block is inline in the `execute`
  function and must be extracted into a named const before routing.
- **D12 — Disambiguation menu.** When a domain claims N guides, both
  fetch-recipe and (later, S4) delete return a menu keyed by `shortName` /
  `dirName` and require a `guide` selector otherwise. Single-guide domains
  stay zero-friction (no menu).

### Out of scope (explicitly, per D9 Scope)

- Malformed-guide fallback in `api-learn({domain})` — `findGuidesByDomain`
  can't address a malformed sibling by routing domain (its `domains:` block is
  unreadable). Malformed guides are already surfaced by the `api-guide()`
  catalog (`⚠ malformed — <dirName>: <field>`) and recovered by the human
  (`bash`-read at the known path, or `/api delete` from S4). `ponytail:` defer
  until a metadata sidecar lets malformed guides be addressed by routing
  domain.

### Acceptance criteria

- **D9**
  - `api-learn({domain})` with no `recipe` and **0 guides** for the domain
    returns a domain-specific template with `domains: [<domain>]` pre-filled
    (same path as `new:true`).
  - `api-learn({domain})` with **1 guide** returns that guide's raw recipe
    string and surfaces the resolved `dirName` in the response with an
    instruction to pass it as `domain` on re-save.
  - `api-learn({domain})` with **N guides** returns a disambiguation menu by
    `shortName`; `api-learn({domain, guide})` returns the selected guide's raw
    recipe with `dirName` surfaced.
  - `api-learn({domain, new: true})` returns a fresh template regardless of
    existing guides, with `domains: [<domain>]` pre-filled and other fields as
    placeholders; does not touch existing guides.
  - `api-learn({domain, recipe})` (the existing save path) is unchanged —
    validates-then-writes, no regression.
- **D9 entry-point split**
  - Bare `api-learn()` returns the manual (field reference + defaults +
    semantics) **and** a pointer to `api-learn({domain, new: true})`; it does
    **not** include the worked-example recipe body.
  - `api-learn({domain, new: true})` returns the template only, no
    instruction block.
  - The tool description names both entry points (bare = manual; `{domain,
    new: true}` = template).
- **D12**
  - Single-guide domains require no `guide` selector (zero-friction
    invariant preserved).
  - N-guide domains return a menu when no `guide` is supplied and resolve
    cleanly when one is.
  - Mirrors `api-guide`'s existing multi-recipe disambiguation pattern
    (resolves by `shortName`).
- **dirName surfacing (overwrite mitigation)**
  - An agent that fetches via routing `domain: "archive.org"` + `guide:
    "wayback"` is shown `dirName: archive.org-wayback` and told to pass it as
    `domain` on save (prevents clobbering the sibling `archive.org/guide.md`).

### Tests to add

- `tools.test.ts` (or a new `api-learn-fetch-recipe.test.ts`): the 0 / 1 / N
  guide rows of the fetch-recipe table; `new:true` returns a template that
  doesn't touch existing guides; entry-point split (bare = manual + pointer,
  no recipe; `{domain, new:true}` = template only).
- A multi-recipe case asserting `dirName` is surfaced and differs from the
  routing domain (the sibling-clobber regression guard).

---

## S3 — `/api verify` (Wave 2)

**Goal.** A dedicated, always-available `/api verify <domain> [guide] [--force]`
command that fetches every runnable op and stamps `verified: today` only on
all-runnable-ops success. Names the post-save `api-fetch` self-check the agent
already performs. The single biggest sprint — the second stamp-to-file
routine in the redesign (S0's `schemaVersion` save-stamp is the first; verify
stamps only `verified`, never `schemaVersion` — the two stay cleanly
separated: schemaVersion vintage is set once at authoring/save time, `verified`
is the refreshable run-confirmed signal).

**Depends on:** S2 (verify shares command-dispatch plumbing with `/api delete`
in S4; the guide-store cache-invalidation precedent already exists in
`api-learn`'s save path). Independent of S1/S2 at the decision level, but
landing S2 first keeps the two commands' dispatch wiring in one review arc.

### Scope

- **D4 — Command registration.** Add `verify` to the `/api` subcommand switch
  in `core/api-toggle.ts` as a peer of `status` / `helpers` / `secrets`
  (always-available, **not** learn-gated, **focus-mode guard does not apply** —
  it doesn't write toolset state, mirroring `secrets` at L284–286). New file
  `core/verify-command.ts` (`handleVerifySubcommand`), mirroring
  `secrets-command.ts`'s shape.
- **D4 — Auth precheck (fail-fast).** Before the fetch loop, run the same
  auth resolution `api-fetch` does (`resolveSecretHeaders` +
  `resolveSecretQueryParams`, `auth.ts`). If any `requires` secret is
  unprovisioned, short-circuit with one message naming the secret and the fix
  (`/api secrets <domain>`) — do not run N ops that all fail identically.
- **D4 — Param precheck + `verify.json` sidecar.** Before the loop, check each
  op for unsatisfiable params (a path `{token}` with no default, or a
  `required: true` query param with no default). Such an op is **skipped, not
  run**. Opt-in override: a co-located
  `~/.pi/agent/pi-lean-host/api-guides/<domain>/verify.json` sidecar, shape
  `{ "<opName>": { "<param>": "<value>" } }`, supplies the params map
  **verbatim** to the existing executor (`helpers.ts` ~L134 flat `params` map;
  the `restGet`/`paginate` signatures sit ~L437–440).
  Best-effort load in the verify path only; file-miss = today's skip behavior;
  malformed file = parse error caught at load, not a runtime crash. Param
  resolution reuses the executor verbatim (no new resolution code):
  - *Coverage*: verify.json value feeds both path tokens and query params,
    keyed by param name; path-vs-query split by the op's existing `pathParams`
    set.
  - *Precedence*: verify.json > `params[key].default` > missing.
  - *Skip vs run*: path param absent from verify.json → `fillPathStrict`
    throws → skip; supplied → runs.
  - *Passthrough ops*: verify.json may supply undeclared keys for
    `passthrough: true` ops (else they can't be verified at all).
  - Implementation is one line: `const params = verifyJson[opName] ?? {}`
    before the existing precheck / executor call.
- **D4 — Fetch loop.** For each op (in declared order): skip if unsatisfiable
  params; otherwise run via the executor helpers + `auth.ts` + `transport.ts`
  **directly** (not the `api-fetch` tool — verify is a command with its own
  internal loop, so tool masking is irrelevant). Note: Verify replicates
  api-fetch's guide-resolution + auth-resolution + dispatch setup. Consider
  extracting a shared `resolveOpForExecution(guide, op, params, opts)` helper
  to avoid drift, or accept the duplication with a `ponytail:` marker. Bump
  `maxRetries` (e.g. 4)
  on the verify fetch calls (deliberate one-shot gesture; reuses the
  transport's existing `waitForRetry` 429/Retry-After/exponential-backoff — no
  `--sleep` flag).
- **D4 — Strict threshold.** Any runnable-op failure (partial **or** all-fail)
  → **no stamp** + a report naming what's broken. Skipped ops are **not**
  failures and don't block the stamp, but are named in the report so the
  signal isn't quietly inflated. **All ops skipped → no stamp** + a warning
  naming the fix (`verify.json` or manual `api-fetch`). The all-fail case is N
  identical lines (ugly but not incorrect — general root-cause detection is
  deferred: `ponytail:` defer until a real user hits it and `--force` isn't
  enough).
- **D4 — Stamp-to-file routine.** On all-ops success,
  line-replace (or insert if absent) the `verified:` line with today's date in
  the raw `guide.md`. Three pinned rules, all reusing existing code:
  1. Isolate the frontmatter block with `FRONTMATTER_RE`
     (`parse-api-guide.ts:42`) → operate on `frontmatter` only → reassemble
     (a stray `verified:` in prose/`description:` can never be touched).
  2. Line-match `^verified:\s*.+$` (anchored to line start; tolerate
     `verified: 2026-07-15` / `verified:"x"` etc.) → replace the whole line
     with `verified: <TODAY()>`. **Match the key, not a date pattern.**
  3. Absent → append `verified: <TODAY()>` as the last frontmatter entry,
     immediately before the closing `---`.
  - The stamp is **unconditional** (refreshes regardless of prior value) and
    does **not** parse dates. Then `invalidateCache()` so the next
    `api-guide` / `api-fetch` sees the fresh date immediately.
  - Do **not** `yamlParse` → mutate → `yaml.stringify` — that reformats the
    entire frontmatter and strips comments (rejected in D4/D5).
- **D4 — `--force` escape valve (human-typed only).** `/api verify <domain>
  --force` stamps `verified: today` **without running any ops**, then
  `invalidateCache()`s. Documented semantic: "human-attested good" for that
  one stamp, not "confirmed by running ops." Stays user-typed (peer of `/api
  delete`); the agent has no `--force` surface.
- **D4 — Report UX.** Partial-fail lists which ops broke; all-fail is N
  identical lines; skipped ops listed as "skipped — requires agent-supplied
  params (`{id}`, `query.since`) — verify manually via `api-fetch`". Exact
  format is an implementation detail to pin in review; the **semantic** is
  strict (any runnable-op failure → no stamp) and is the acceptance bar.
- Verify is **not free**: N live HTTP requests against the target API
  (transport is GET-only — no mutation side-effects, but real quota/rate-limit
  cost). Document this in the command's `--help` / status output.

### Acceptance criteria

- **Dispatch**
  - `/api verify <domain>` is recognized in the `/api` switch; usage line
    updated to include `verify`.
  - It is always-available (runs in **on** mode, not just **learn**) and is
    **not** refused by the focus-mode guard (it writes no toolset state).
  - Verify runs even when the `api-fetch` / `api-guide` tools are masked off
    (it calls executor/auth/transport directly, not the tools).
- **Auth precheck**
  - A guide with unprovisioned `requires` secrets short-circuits before the
    loop with one message naming the secret + `/api secrets <domain>` fix —
    not N identical op failures.
- **Param precheck + sidecar**
  - An op with an unsatisfiable path/query param and no sidecar is **skipped**
    (reported as skipped, not failed) and does not block the stamp when every
    runnable op passes.
  - A `verify.json` sidecar supplying that op's params makes the op **run**
    instead of skip; verify.json value wins over `params[key].default`.
  - A malformed `verify.json` produces a load-time parse error (not a runtime
    crash); a missing `verify.json` is today's skip behavior.
  - A `passthrough: true` op is verifiable when verify.json supplies its
    undeclared keys.
- **Threshold + stamp**
  - All runnable ops pass, ≥1 op ran (not all skipped) → `verified:` line in
    `guide.md` is today; the next `api-guide({domain})` sees the fresh date
    without a reload (cache invalidated).
  - Any runnable-op failure (partial or all-fail) → **no stamp** + a report
    naming the failing op(s); `guide.md` `verified:` line unchanged.
  - All ops skipped → **no stamp** + a warning naming the fix (verify.json /
    manual api-fetch).
  - The stamp routine touches **only** the `verified:` line inside the
    isolated frontmatter block; a `verified:` string in the prose body or a
    `description:` field is never matched (covered by a fixture with a
    `verified:`-in-prose guide).
  - An absent `verified:` field is inserted as the last frontmatter entry
    before the closing `---`; an existing `verified: <old>` line is replaced
    in place regardless of the old value's format.
  - Comments and key ordering elsewhere in the frontmatter are preserved (no
    YAML round-trip).
- **`--force`**
  - `/api verify <domain> --force` stamps today **without any HTTP requests**
    and invalidates the cache; documented as "human-attested."
  - There is **no** agent-facing `--force` surface (it's user-typed only).
- **Rate limiting**
  - Verify reuses the transport's existing 429 retry (`waitForRetry`) with a
    bumped `maxRetries`; there is **no** `--sleep` flag.

### Tests to add

- `verify-command.test.ts` (mocked transport): all-pass → stamp + cache
  invalidation; partial-fail → no stamp + report names the failing op;
  all-fail → no stamp + N identical lines; all-skipped → no stamp + warning;
  auth-precheck short-circuit; param-precheck skip; verify.json makes a
  skipped op run; verify.json precedence over default; malformed verify.json
  → load error; passthrough op verifiable via sidecar.
- `verify-stamp.test.ts`: stamp touches only the `verified:` line in the
  isolated frontmatter (the `verified:`-in-prose fixture is never matched);
  absent field inserted before closing `---`; existing line replaced in place
  regardless of format; comments + key order preserved (no YAML round-trip);
  `--force` stamps without HTTP.
- Dispatch test in `api-toggle.test.ts`: `verify` recognized, always-
  available, not refused by focus-mode guard, runs with `api-fetch`/`api-guide`
  masked off.

---

## S4 — `/api delete` (Wave 2)

**Goal.** A dedicated, always-available `/api delete <domain> [guide]` command
that removes a guide directory and invalidates the per-session guide-store
cache (closing the ghost-guide cache bug that `bash rm` leaves behind). The
agent is **not** given a delete tool; `api-learn`'s collision/malformed errors
tell it to ask the human.

**Depends on:** S3 (shares command-dispatch plumbing; S3 already added the
`verify` peer, so `delete` is one more `case`).

### Scope

- **D10 — Command registration.** Add `delete` to the `/api` subcommand
  switch in `core/api-toggle.ts` as a peer of `secrets` / `status` /
  `helpers` / `verify` (always-available, not learn-gated, focus-mode guard
  does not apply — it writes no toolset state). New file
  `core/delete-command.ts` (`handleDeleteSubcommand`).
- **D10 — Delete semantics.** Whole-domain delete: interactive confirm
  (mirror `/api secrets --delete` whole-domain confirm). Single-guide delete
  via `guide` selector: no confirm (mirror `/api secrets --delete <domain>
  <name>` no-confirm). After the `rm -rf` of the directory, call
  `invalidateCache()` so the next `api-guide` / `api-fetch` doesn't see a
  ghost guide (the load-bearing reason this beats `bash rm`).
- **D10 — Existence + disambiguation guard.** Require the guide to exist; if
  a domain claims N guides and no `guide` selector is supplied, return the
  D12 disambiguation menu. The confirm message names the exact directory
  removed.
- **D10 — No agent surface.** No `api-learn({delete: true})` affordance. The
  destructive op stays off the agent's tool surface entirely. `api-learn`'s
  collision/malformed error messages tell the agent the path exists ("if a
  guide is wrong, ask the user to run `/api delete <domain>`").
- Recovery-by-rewriting (the more common case — API changed / bad content) is
  **not** delete's job: that's S2 fetch-recipe + re-save + `/api verify`.

### Acceptance criteria

- **Dispatch**
  - `/api delete <domain>` is recognized in the `/api` switch; usage line
    updated to include `delete`.
  - Always-available (runs in **on** mode), not refused by the focus-mode
    guard (writes no toolset state).
- **Semantics**
  - Whole-domain delete prompts an interactive confirm naming the exact
    directory; confirming removes the directory and invalidates the cache so
    the next `api-guide` catalog no longer lists it (ghost-guide bug closed).
  - Single-guide delete (with `guide` selector) removes that directory with no
    confirm and invalidates the cache.
  - Deleting a non-existent domain/guide produces a clear "not found" message
    and removes nothing.
  - N-guide domain with no selector returns the disambiguation menu (D12),
    removes nothing.
- **No agent surface**
  - There is no `api-learn` param that deletes. The only delete path is the
    user-typed command.
  - `api-learn`'s collision/malformed error text names `/api delete <domain>`
    as the recovery gesture (docs/error-string check).

### Tests to add

- `delete-command.test.ts` (temp `api-guides` dir fixture): whole-domain
  delete with confirm → directory gone + cache invalidated (next catalog
  lookup empty); single-guide delete → that directory gone, siblings intact,
  cache invalidated; non-existent → not-found message, nothing removed;
  N-guide no-selector → disambiguation menu, nothing removed.
- Dispatch test in `api-toggle.test.ts`: `delete` recognized, always-
  available, not refused by focus-mode guard.
- `api-learn` error-string test: collision/malformed errors name `/api
  delete`.

---

## S5 — Release

**Goal.** Close out the redesign across the published surface.

### Scope

- **Ship-manifest / `api-guides` exclusion** checks still pass (the axis
  guides are unaffected by this redesign — confirm `ship-manifest.test.ts`
  stays green and `api-guides/` is excluded from the npm tarball).
- **CHANGELOG** entries per sprint (the package has no CHANGELOG today — add
  one with entries for S0–S4, or fold into the monorepo CHANGELOG per the
  repo's convention; confirm with the release script `scripts/release.mjs`).
- **`schemaVersion` bump rule** (per `AGENTS.md`): this redesign adds no
  required field, no new enum value, and relaxes no parse-enforced constraint
  — the save-stamp and stale-detection are behavioral/doc changes, not schema
  changes — so `GUIDE_SCHEMA_VERSION` stays `0` (a non-event). Confirm the
  bump rule holds and no spurious bump ships.
- **Schema-versioning framing rewrite** (`AGENTS.md` package doc + this plan's
  design-doc companion): the section currently says "attribution, never
  enforcement: it never gates, warns, or alters parse behavior" and "absent
  defaults to `0`". After S0 the framing becomes: **`schemaVersion` is
  breaking-change detection** — stamped on save (each guide records its
  authoring vintage), absent-on-read defaults to `0` (the floor, unchanged),
  and a guide with `schemaVersion < current` gets a **non-blocking warning** in
  the `api-guide` catalog and on `api-fetch` (detection, never a gate — the
  guide still loads and runs). "Never gates" stays true; "never warns" is
  dropped. The bump rule text is unchanged. The `schema-version.test.ts` that
  encoded the old "never warns" rule is rewritten in S0 (not here).
- **Docs sync** — `AGENTS.md` package doc: update the tool/command counts (the
  `/api` subcommand list grows from `on | off | learn | status | helpers |
  secrets` to include `verify` and `delete`) and the `api-learn` / `api-probe`
  behavior descriptions (fetch-recipe, scaffold mode, save-stamps
  `schemaVersion`). Also update the `schemaVersion` JSDoc on
  `core/api-guide-types.ts` (`ApiGuide.schemaVersion`, ~L216–222), which still
  says "absent stays `undefined` (semantic default 0). Never gates/warns/alters
  parse." — after S0 it becomes "absent defaults to `0`; a stale value
  (`< current`) warns non-blockingly in the `api-guide` catalog/detail and on
  `api-fetch`; never gates." The `api-guides/` section's "synthetic axis guides"
  framing is unchanged.

### Acceptance criteria

- `npm run test:ci` green (structural + contributed-backend contract tests,
  host included).
- `npm run test:py-bridge` green (unaffected, but run to confirm no
  cross-package breakage).
- `npm run publish:dry` tarballs exclude `api-guides/` and include the new
  `core/verify-command.ts` + `core/delete-command.ts`.
- `/api` subcommand list in `AGENTS.md` + `api-toggle.ts` usage string
  includes `verify` and `delete`.
- `AGENTS.md` schema-versioning section reflects the new framing:
  detection of breaking changes; stamped on save; absent-on-read → `0`;
  stale (`< current`) → non-blocking warning on `api-guide` + `api-fetch`;
  never a gate. The rewritten `schema-version.test.ts` (S0) is green and
  encodes this.
- `GUIDE_SCHEMA_VERSION` unchanged at `0` with a CHANGELOG line noting the
  non-bump rationale (behavioral/doc changes, not a schema change) per the
  bump rule.

---

## Cross-cutting testing notes

- **Subject-under-test split** (per `AGENTS.md` testing principle): all new
  tests are **structural** — mocked transport, mocked auth resolution, temp
  `api-guides` dirs. No live endpoints, no env gate. Host CI stays
  "structural only, fast, deterministic."
- **Mode-boundary invariant** (D1/D2/D3): every sprint that touches a use-mode
  tool (`api-fetch`, `api-guide`) must keep it free of learn-mode behavior and
  read-only w.r.t. `guide.md`. The host-only-boundary test + the existing
  fetch tests are the regression tripwires.
- **`ponytail:` markers** to leave behind (deliberate deferrals, per the
  design doc):
  - General all-fail root-cause detection in verify (D4) — defer until a real
    user hits it and `--force` isn't enough.
  - Malformed-guide fetch fallback in `api-learn({domain})` (D9 Scope) — defer
    until a metadata sidecar lets malformed guides be addressed by routing
    domain.
  - Staging / candidate-guide verification (Dropped D8) — defer as an
    additive `_staging/` dir + promote command if editing-clobber pain proves
    real; the git-init-your-api-guides-dir safety net is the v1 answer.
  - Per-operation `lastVerified` runtime health — out of scope (runtime-health
    feature, bigger than authoring flow).

## Open questions for review

The schemaVersion questions are settled (stamp on save; absent → `0`; warn on
stale in catalog + fetch — see *Schema-version framing correction* under S0).
Two S3-internal details remain, both "implementation details to pin" the
design doc explicitly defers — neither affects sprint ordering:

1. **Verify report UX format.** The semantic is pinned (strict any-runnable-op
   failure → no stamp; skips named; all-skipped → no stamp + warning). The
   *exact* text layout of the partial-fail / all-fail / skipped report is left
   to pin during S3 review. (D4: "The exact report format is an implementation
   detail to pin.")
2. **`maxRetries` bump value.** D4 says "e.g. 4" — confirm 4 (vs. the default
   2) is the right verify-call value, or pick another during S3.
