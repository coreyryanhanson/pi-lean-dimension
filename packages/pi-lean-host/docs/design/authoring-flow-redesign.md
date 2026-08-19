# API-Guide Authoring-Flow Redesign

> Design record for the `api-learn` / `api-probe` authoring loop in
> `pi-lean-host`. The *what* of the current tools is visible in the code; this
> doc captures the *why* behind the redesign — the evidence that drove it, the
> 11 decisions (and one deliberate non-decision) that compose the target flow,
> the tradeoffs each one rejected, and the risks a future implementer should
> know. It is the output of a brainstorming session; review precedes any
> implementation plan.

## Goals

1. **Close the observed authoring friction** documented in the CoinMarketCap
   authoring report (below) — primarily round-trip cost, not character-level
   correctness.
2. **Fix frontmatter ownership** — deterministic fields should be tool-stamped,
   not hand-written by an agent that copies stale literals.
3. **Keep the agent off the filesystem** during authoring — every authoring
   activity (draft, edit, validate, recover) should flow through tools, not
   `bash`-reading `guide.md`.
4. **Preserve the clean mode boundary** — use-mode tools stay use-mode;
   learn-mode behavior is never smuggled onto a use-mode tool; irreversible ops
   stay with the human.

## Evidence: CoinMarketCap authoring friction report

A live `/api-learn` authoring session against a keyed, header-auth,
per-endpoint-versioned API. The guide saved successfully; the friction, in cost
order:

- **5 `api-learn` calls** (1 success, 4 validation rejections).
- **3 of 4 rejections = auth-schema guessing** — the worked example documents
  only `kind: none`; a keyed-API author reverse-engineered `static-key` from
  error messages.
- **1 rejection = misleading frontmatter error** — the validator said "no
  frontmatter found" when the real problem was a missing closing `---`.
- Validator error messages were praised (precise field paths, expected values,
  fix hints) — the pain was *upstream* of them.

### Ranked issue ledger

| # | Severity | Issue | Closed by |
|---|---|---|---|
| 1 | HIGH | Static-key auth schema undocumented → 3 wasted round-trips. | D6 |
| 2 | HIGH | Misleading frontmatter error: "no frontmatter found" when closing `---` missing. | D7 |
| 3 | MEDIUM | No validate-only / dry-run; every rejection re-sends the whole (~200-line) recipe. | D5 (rejection-count lever + `/api verify` behavioral check) |
| 4 | MEDIUM | `api-probe` auth shape ≠ guide auth schema; probe draft omits the `auth:` block. | D6 |
| 5 | MEDIUM | Probe can't infer pagination from a single response (inherent; comment already honest). | Out of scope |
| 6 | LOW | Probe draft omits top-level fields — no full-scaffold mode. | D6 |
| 7 | LOW | No existing keyed-auth guide to crib from (chicken-and-egg). | D6 |
| 8 | LOW (env) | web-fetch temp files vanished mid-session (portal issue, not api-learn). | Out of scope |

### What went right (preserve)

- Validator error messages: precise, actionable field paths + fix hints.
- `api-probe` version resolution, `itemsPath` detection, paste-ready op block.
- **`api-fetch` end-to-end verification right after save** — the de-facto
  verify step the agent already performs. The redesign *names* this behavior
  rather than inventing a new one.
- `requires` / `secretRefs` cross-check guard.

## Constraints & assumptions

- **Agent is the author; human is the reviewer/owner of saved guides** —
  including irreversible ops like deletion.
- **Backwards compatibility is loader-side and already handled.** The parser
  reads an agent-written `verified` today (`parse-api-guide.ts` L1109–1110) and
  tolerates it; new saves overwrite it. Existing guides need no migration.
- **The parser is one-way.** No YAML serializer exists, and building one for an
  incremental-edit feature was rejected (see D5). Edits are whole-recipe
  re-send.
- **The store caches per session.** `guide-store.ts` caches loaded guides and
  invalidates on write; there is no delete primitive today, and `bash rm` leaves
  a ghost guide in the cache until reload.
- **The toggle already gates `api-learn`.** Learn-mode-only behavior is free to
  add to `api-learn` / `api-probe`; use-mode tools (`api-guide`, `api-fetch`)
  must stay free of learn-mode behavior.
- **`api-fetch` is read-only w.r.t. `guide.md`** (confirmed: it imports only
  `findGuidesByDomain`; writes go to `/tmp` spill). This is a load-bearing
  invariant — D3 and D4 both depend on it.
- **Users who want version control can `git init` the api-guides dir
  themselves.** This is the editing-clobber safety net that lets the redesign
  defer staging (see Dropped D8).

## Code-grounded starting points

These facts were established by reading the source, not assumed:

- **`verified` & `updated` already default to `TODAY()`** in `parseApiGuide()`
  (~L1098–1110) when omitted, and an explicitly-supplied `verified` is
  **respected** (not stripped). This is already D2's target behavior — the
  gap is only that the worked example trains the agent to copy a stale literal
  (closed by D6).
- **The worked example hardcodes** `updated: 2026-07-15` / `verified:
  2026-07-15` — trains stale-literal copying. It also documents only `auth:
  kind: none` (the #1 root cause).
- **`api-learn` already validates-then-writes** (parse → no write on error →
  `writeFileSync` on success). Structural validation is free on every save.
- **`api-probe` `emitDraft()`** emits only the `operations[]` block — no
  top-level scaffold, no `auth:`. Its `auth` injection param uses `secretRefs` /
  `headerPrefixes` / `secretQueryRefs` but **not** `kind` / `requires` — the
  shape mismatch behind issue #4. Probe is **per-endpoint** (one call = one op
  block).
- **`api-guide({domain})` returns a rendered human-readable view, not the raw
  recipe string.** Editing an existing guide today requires `bash`-reading
  `guide.md` from disk; `domain + no recipe` currently errors ("Recipe is
  required").
- **`/api secrets --delete`** exists as a user-typed destructive-op command
  precedent (interactive confirm for whole-domain, no-confirm for single name).
- Frontmatter fields already tool-defaulted: `kind` (api), `icon` (📖),
  `shortName` (filename), `updated` (TODAY), `verified` (TODAY),
  `gatherAllMax` (1000), `responseShape` (json/utf-8). `schemaVersion` is
  metadata-only and currently left `undefined` when absent — D-bootstrap
  folds in a one-line default to `GUIDE_SCHEMA_VERSION` (currently `0`) so the
  doc's "absent defaults to 0" claim holds. Agent-authored: `domains`,
  `apiHost`, `docs`, `organization`, `description`, `auth`, `pagination`,
  `operations`.

## Decisions

### D1 — One workstream

Frontmatter-stamping is folded into the same flow redesign as the friction
fixes (round-trips, auth docs, scaffold). The user's original framing emphasized
frontmatter hygiene (`verified` deterministic, `lastModified`); the CMC report
emphasized friction. These optimize for different things, but treating them as
one coherent authoring-flow overhaul keeps the design legible and avoids two
half-coordinated changes.

**Rejected:** two workstreams (a small frontmatter change + a separate larger
friction effort) — risks designing each without the other.

### D2 — `verified`: respect-if-present, default-today (no strip, no `lastModified`)

The parser keeps its existing behavior unchanged: an explicitly-supplied
`verified` is **respected**, an omitted one **defaults to `TODAY()`**. The tool
does **not** strip or override agent-supplied values on the save path. No
`lastModified` field is added — `verified` serves as the drift signal; `/api
verify` (D4) is the authoritative refresh gesture that stamps today on
deterministic success.

**Rationale.** The parser already implements respect-if-present /
default-today (`parse-api-guide.ts` L1109:
`typeof m["verified"] === "string" ? (m["verified"] as string) : TODAY()`), and
`api-learn` writes the raw recipe string as-is — so this requires **zero new
write mechanism** on the save path. The stale-literal root cause (agents
copying the worked example's hardcoded `verified: 2026-07-15`) is closed by D6
working the example to omit the dates and demonstrate the tool-stamped default,
*not* by the parser outsmarting the agent.

**Why respect a copied value instead of stripping it.** Distinguishing a
deliberately-included `verified` from a copy-paste artifact would require
heuristics (compare against the worked example's known stale date, etc.) —
overengineering for a case `/api verify` already covers authoritatively: any
stale `verified` is one verify gesture away from being corrected to today. If
an author goes to the trouble of writing the field, we take it at face value.
The semantic split is honest: `api-learn`'s `verified` = the author's assertion
(porting a guide and preserving its prior date is legitimate); `/api verify`'s
`verified` = last deterministically checked against the live API.

**Why no `lastModified`.** `verified` already serves as the drift signal (a
guide not touched since X). A separate `lastModified` would be a second date
field tracking the same thing (file mtime) — redundant. The two-fields options
considered (`lastModified` + semantic `verified` = "last confirmed against live
API"; or tool-stamping both) added either machinery or ambiguity without a clear
downstream consumer of the distinction.

**Rejected:**

- *Strip/override agent-supplied `verified`; always tool-stamp today (the
  brainstorm's first proposal).* Requires new write-path code (regex-replace
  before write) to undo a value the parser currently respects — mechanism for a
  signal `/api verify` already owns. Also discards legitimate intent (porting a
  guide and preserving its prior verified date).
- *Add `lastModified`; keep `verified` agent-owned/defaulted = "last confirmed
  via api-fetch."* Two distinct signals, but no downstream logic consumes the
  distinction today, and it leaves `verified` in the agent's hands.
- *Tool-stamp both.* Redundant — both track "when the file last moved."

### D3 — No passive `verified` bump on `api-fetch`

`api-fetch` stays read-only w.r.t. `guide.md`. A successful fetch during a task
does not advance `verified`.

**Rationale.** Passive bumping conflates "used" with "verified" — a single
working endpoint would mark the whole guide "verified today" while masking a
broken one (the partial-success problem). It would also add a write side-effect
to a currently stateless tool, with cache-invalidation and concurrency costs.
Keeping `verified` as a save-date drift signal (honest, if coarse) and adding an
*explicit* verify gesture (D4) keeps "using" and "verifying" cleanly separated.

### D4 — Explicit verify gesture: `/api verify` command, always-available

A dedicated **`/api verify <domain> [guide] [--force]`** command — **always-available
(not learn-gated)** — fetches the guide's operations and stamps `verified:
today` only on **all-runnable-ops success**. `api-fetch` stays pure read-only;
no new manifest tool. All-ops threshold with a partial-failure report (op X of
N failed → not verified, here's which). `verified` means **"last confirmed
all-ops-good as of `<date>`"** — not merely "last checked." The threshold is
**strict: any runnable-op failure (partial *or* all-fail) → no stamp** + a
report naming what's broken. A stale date is more honest than a fresh one
stamped on a broken guide, and a flaky-API false negative has a clean escape
via `--force` (below) — so verify itself stays strict and never silently
half-passes. Skipped ops (below — structurally unverifiable without
agent-supplied params) are **not** failures; they don't block the stamp but
are named in the report so the signal isn't quietly inflated. **All ops
skipped → no stamp** + a warning (stamping `verified: today` on a guide never
actually tested would inflate the signal; the warning names the fix — supply
params via `verify.json` or verify manually via `api-fetch`).

**Rationale.** The CMC report shows the agent already runs a post-save
`api-fetch` to verify — this names an existing behavior rather than inventing
one. A *command* (not a tool) is the right shape because verify is a deliberate
gesture, not something the agent should discover as another tool surface; and it
keeps the manifest from growing. The all-ops threshold is the honest one: a
guide is verified when every operation works, with a clear report when one
doesn't.

**Auth precheck (fail-fast before the loop).** Before the fetch loop, verify
MUST run the same auth-resolution precheck `api-fetch` does
(`resolveSecretHeaders` + `resolveSecretQueryParams`, check `absentRequired`).
If any `requires` secret is unprovisioned, short-circuit with a single message
naming the secret and the fix (`/api secrets <domain>`) — do **not** run N ops
that all fail identically. This reuses `auth.ts`'s existing `absentRequired`
machinery verbatim. Without it, the most common verify failure on a fresh or
newly-installed host (an authed guide whose secrets haven't been provisioned
yet — secrets don't travel with the guide) renders as N identical op failures
with the actionable hint buried under the all-ops-threshold framing.

**Param-precheck + `verify.json` sidecar (opt-in override for skipped ops).**
Before the fetch loop, verify checks each op for **unsatisfiable params**: a
path param with no default (a `{token}` that needs an agent-supplied value),
or a query param with `required: true` and no `default`. Such an op is
**skipped, not run** — there's no plugin-owned param resolution (values are
agent-supplied per-task from context; there's no params-store and there
shouldn't be — a second secrets-store for non-secret data is overengineering).
Skipped ops are reported as "skipped — requires agent-supplied params (`{id}`,
`query.since`) — verify manually via `api-fetch`" and don't block the stamp.

The fix for a user who wants full verify coverage on a required-param guide is
a co-located **`verify.json`** sidecar at
`~/.pi/agent/pi-lean-host/api-guides/<domain>/verify.json`, shape
`{ "<opName>": { "<param>": "<value>" } }` — just the param values that make
the op runnable. Best-effort load in the verify path only: file-miss = today's
skip behavior; a malformed file is a parse error caught at load, not a runtime
crash. When the sidecar supplies an op's params, the op runs instead of
skipping. This reuses the established co-location convention
(`local-helpers.ts` already loads a co-located `helper.ts` from the same
directory via dynamic `import()`), but with a deliberate downgrade:
`verify.json` is **JSON data, not executable code** (params are values, not
logic), so there's no user-code execution surface and no output-channel-audit
concern (values are agent-visible params, not secrets). The co-located vitest
`.test.ts` files (e.g. `api-guides/api.github.com/static-key.test.ts`) are a
**category mismatch** for this — they need the vitest runner, use mocked
transport, and `api-guides/` is excluded from the npm tarball, so a user
running `/api verify` in their pi session has neither the runner nor the
files; verify cannot load them. The sidecar is the honest runtime shape.

**`verify.json` param-resolution mechanics (pin before implementation).**
The sidecar reuses the executor's existing param mechanics verbatim — no
new resolution code. `api-fetch`'s executor takes a single flat
`params: Record<string, unknown>` map (`helpers.ts:443`) that feeds *both*
`fillPathStrict(path, params)` for `{token}` path templating *and*
`buildQueryParams(operation, params)` for query-string assembly; the op's
existing `pathParams` set (inferred from `{token}` in `path`) is what splits
a key into "path" vs "query" — there is no separate path-params input. So
the sidecar's per-op object `{ "<param>": "<value>" }` **is that `params`
map, passed verbatim** to the existing executor, and the contract is three
lines:

1. **Coverage:** a verify.json value feeds both path tokens and query
   params, keyed by param name. Path vs query is determined by the op's
   existing `pathParams` set — no new disambiguation, no separate path /
   query namespaces in the sidecar.
2. **Precedence:** verify.json value > op's `params[key].default` > missing.
   This falls out of `buildQueryParams` L150–152
   (`let val = params[key]; if (val === undefined && spec.default !== undefined) val = spec.default`):
   verify.json sits in `params[key]`, so it wins; the default only fills
   when verify.json omits the key. No new merge logic.
3. **Skip vs. run:** a path param absent from verify.json makes
   `fillPathStrict` throw → which is exactly the "unsatisfiable param" the
   param-precheck detects → **skip**. When verify.json supplies it, the op
   runs instead of skipping. The precheck and the sidecar compose: precheck
   skips *unless* verify.json fills the gap.

**One edge worth naming:** `passthrough: true` ops (`helpers.ts:173–184`)
forward undeclared caller params onto the query string. Since verify is the
sole param source in the verify path, verify.json **must be allowed to
supply undeclared keys** for passthrough ops (otherwise a passthrough op
can't be verified at all). This falls out of passing verify.json as the
`params` map, but is non-obvious enough to state explicitly.

In code the sidecar is one line: `const params = verifyJson[opName] ?? {}`
before the existing precheck / executor call — the op then either runs
(params satisfy every unsatisfiable slot) or is skipped (they don't). No
params-store, no param-resolution DSL — the flat map already does it.

**All-fail root-cause detection — deferred (YAGNI).** A general "detect the
singular root cause when every op fails" heuristic is deferred: the auth
precheck (above) already fail-fasts the most common all-fail case
(unprovisioned secrets), and `--force` lets a human override a strict false
negative. The partial-failure report lists which ops broke; the all-fail case
is just N identical lines (ugly but not incorrect). `ponytail:` defer general
root-cause detection until a real user hits it and `--force` isn't enough.

**Verify is not free.** `/api verify` makes N live HTTP requests against the
target API (transport is GET-only, so no mutation side-effects, but real
quota / rate-limit cost). Callers should treat it as a deliberate N-request
check, not a zero-cost date refresh.

**Rate limiting reuses the transport, not a new flag.** The transport already
retries 429s adaptively — `waitForRetry()` honors `Retry-After` (seconds or
HTTP-date), falling back to exponential backoff (1s → 2s → 4s, cap 30s), up to
`maxRetries` (default 2). That adaptive path is strictly better than a fixed
human-supplied inter-op sleep: it backs off based on what the server *says*,
and it doesn't tax the common non-rate-limited verify by slowing every op.
Verify's only rate-limit adjustment is to **bump `maxRetries` (e.g. 4)** on its
fetch calls — verify is a deliberate one-shot gesture where the human is
waiting, so spending more backoff attempts is the right trade. A 429'd op that
exhausts retries is reported as failed → no stamp (the honest outcome: that
op couldn't be confirmed in this window); the human re-runs verify or uses
`--force`. No `--sleep` flag — it would re-invent `waitForRetry` with a worse
human-guessed value, and `--force` already covers the tight-window case.

**Write mechanism (the one new stamp-to-file routine in this redesign).** On
all-ops success, `/api verify` line-replaces (or inserts if absent) the
`verified:` line in the raw `guide.md` with today's date. There is no YAML
serializer (see D5); the save path (`api-learn`) needs no such routine because
D2 keeps the parser's respect-if-present default and writes the recipe as-is.
The verify stamp is **unconditional** — it refreshes `verified` regardless of
the prior value, which is the correct semantic for a "last confirmed
all-ops-good" gesture (the one case where we *do* override, deliberately).

**The stamp swaps one predictable line, it does not parse dates.** The match
keys on the `verified:` key, not on a date-shaped value — the existing date is
irrelevant to the match and is simply overwritten. The mechanics are three
pinned rules, all reusing code that already exists:

1. **Anchor inside the frontmatter block** (the real fragility the stamp must
   avoid is matching a stray `verified:` in the prose body or in a
   `description:` field). Isolate the block first with the existing
   `FRONTMATTER_RE` (`parse-api-guide.ts:42`: `^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$`),
   which yields `(frontmatter, body)`; operate on `frontmatter` only and
   reassemble. A `verified:` string outside the block can never be touched.
2. **Line-match the key, tolerate format variance.** Within the isolated
   frontmatter, match `^verified:\s*.+$` (anchored to line start) — so
   `verified: 2026-07-15`, `verified:"2026-07-15"`, and `verified: "x"` all
   match and the whole line is replaced with `verified: <TODAY()>`. Do **not**
   match a date pattern; match the key.
3. **Absent → insert before the closing `---`.** The parser already defaults an
   absent `verified` to `TODAY()` on read (`parse-api-guide.ts:1109`), so an
   absent field is already semantically "today" — the insert just makes it
   visibly present. Append the line as the last frontmatter entry, immediately
   before the closing `---`.

This is line-level replacement within a well-delimited block, not YAML
round-tripping. The alternative — `yamlParse` → mutate → `yaml.stringify` —
is worse here: re-serialization reformats the *entire* frontmatter (reorders
keys, normalizes quoting, **strips comments**), clobbering a hand-tuned guide
everywhere instead of on one line. The doc already rejected building a YAML
serializer for the save path (D5); the same reasoning applies to the verify
stamp. Touching one predictable line preserves the agent's formatting
elsewhere.

**Why always-available, not learn-gated.** Verify is deterministic, safe, and
idempotent — gating it would be ceremony that adds a gate check + a refusal
message + a test for the refusal, all to protect a faint signal-hygiene
preference ("`verified` should only move during deliberate authoring"). The
honest reading is that `verified` = "last confirmed all-ops-good" is a
*refreshable* signal, and a user who wants to refresh it in any mode shouldn't
have to toggle learn mode on first. Gating restricts what users can do with
their own software for no real payoff.

**Focus-mode guard does not apply (corollary, grounded in the `secrets`
precedent).** The guard at `api-toggle.ts:232` refuses exactly the actuating
subcommands (`on` / `off` / `learn`) while `pi-tool-masking` holds focus
(inclusion mode or allowlist focus) — those write `{enabled}` entries that
would be focus-indistinguishable. `/api verify` and `/api delete` do **not**
write toolset state (verify stamps a date in `guide.md`; delete removes a
directory + invalidates the guide-store cache), so they are non-actuating
peers of `secrets` / `status` / `helpers`, which are already exempt
(`api-toggle.ts:285–286`, `secrets-command.ts:18`). This is a decision, not a
risk to confirm — the precedent is in code. Verify also does not depend on
the `api-fetch` / `api-guide` tools being enabled: it is a command with its
own internal fetch loop that calls the executor helpers (`helpers.ts`),
`auth.ts` resolution, and `transport.ts` directly, not the `api-fetch` tool —
so tool masking (which gates agent-invokable tool surfaces, not commands) is
irrelevant to whether verify runs.

**`--force` escape valve (human-typed only).** `/api verify <domain> --force`
stamps `verified: today` **without running any ops**, then `invalidateCache()`s.
Use case: a flaky API 503s on one endpoint *after* a prior successful verify,
and the human judges the guide still good — they outsource the judgment
entirely outside the plugin. `--force` earns its keep over `bash`-editing the
date for the same reason `/api delete` earns its keep over `bash rm`: the
command invalidates the per-session guide-store cache, so the next
`api-guide` / `api-fetch` sees the fresh date immediately (a raw file edit
leaves a ghost-date until reload). The semantic is explicit and documented:
`--force` makes `verified` = "human-attested good" for that one stamp, not
"confirmed by running ops" — an escape valve, not a shortcut past a genuinely
broken guide. Stays user-typed (peer of `/api delete`); the agent has no
`--force` surface, so the footgun that drove D10 (keep destructive ops off the
agent tool surface) does not apply.

**Rejected:**

- *`api-fetch verify:true` flag (per-op threshold).* Smuggles a learn-mode
  behavior (writing `guide.md`) onto a use-mode tool, breaking the mode boundary
  and undoing D3's read-only invariant. The per-op threshold also conflates
  one-good-op with guide-verified.
- *Per-operation `lastVerified` (sidecar or op field).* Fully resolves partial
  success by granularity, but it's a runtime-health feature — schema change or
  sidecar — bigger than the authoring-flow scope.
- *Learn-gated `/api verify`.* See "why always-available" above — ceremony.
- *Retry logic / flake detection / partial-pass thresholds in the verify
  loop.* The machinery `--force` lets you defer: retry-with-backoff, flake
  heuristics, "M of N ops passing counts as verified" thresholds. A blunt
  human-judgment flag is one boolean on an existing command; flake-tolerance
  is a subsystem. Defer with a `ponytail:` marker until a real user hits
  flaky-verify often enough that `--force` isn't enough.
- *Reusing the co-located vitest `.test.ts` files at runtime.* Category
  mismatch — they need the vitest runner, use mocked transport, and
  `api-guides/` is excluded from the npm tarball, so end users have neither
  the runner nor the files. The `verify.json` sidecar is the honest runtime
  shape.
- *A `/api params` command or param-store.* Overengineering a second
  secrets-store for non-secret data. The sidecar covers the opt-in case; the
  skip covers the default. Add when a user genuinely needs runtime param
  provisioning beyond a static file.
- *Agent-facing `--force`.* Would re-open the D10 footgun (a self-serve
  destructive signal-mutation on an agent-invokable surface). Stays
  human-typed.
- *`--sleep` / inter-op pacing flag.* Re-invents the transport's existing
  429 retry (`waitForRetry` honors `Retry-After` + exponential backoff) with a
  fixed human-guessed value that can't know the server's window, and taxes the
  common non-rate-limited verify by slowing every op. The only adjustment
  verify makes is bumping `maxRetries` on its fetch calls; an API so
  rate-tight that even that fails is flaky by definition → `--force`.

### D5 — Monolithic-write mechanism: scaffold/docs + `/api verify` (no validate-only flag, no staging)

The monolithic-write pain (issue #3) is addressed by a **combo of two levers**:

1. **Scaffold/docs to cut rejection count** (D6) — the report's 3/4 rejections
   were an undocumented auth schema; better discoverability means the agent's
   first save is far more likely valid.
2. **`/api verify` behavioral check** (D4) — catches the semantic errors a
   structural validator cannot (wrong `itemsPath`, dead endpoint), which are the
   class of "valid-but-broken" saves that a dry-run flag would *not* have caught
   anyway.

**No `validate:true` / dry-run flag.** Structural validation already happens
free on every save (invalid recipes don't write); the flag's only added
behavior would be "don't write a structurally-valid recipe" — ceremony. The
token saving it appeared to offer is marginal (the recipe is already in the
agent's context; re-sending it as a tool arg costs output tokens either way).
The flag was dropped after interrogation.

**No incremental-patch / add-op / staging machinery.** The parser is one-way;
building a YAML serializer for structured edits is substantial machinery for a
residual-rejection case that the scaffold/docs lever already shrinks. The
editing-clobber case (experimenting with a variation on a working guide) is
covered *enough* by D9 (fetch-recipe) + git/re-authoring as the safety net.

**Deferred (additive future).** If editing-clobber pain proves real, a
`_staging/` directory + promote command is an additive feature that breaks
nothing existing — safe to defer with a `ponytail:` marker.

**Rejected:**

- *Validate-only flag.* Dropped (see above). Oversold as a token saver; its real
  value ("check before mutate") is covered by fetch-recipe + the fact that
  saves already validate.
- *Incremental/structured edit ops (`add-op`, `set-auth`).* Heaviest machinery;
  reopens the serializer question; merge/overwrite semantics + collision with
  hand-edits become real. Not worth it for the residual case.
- *Scaffold/docs alone (no behavioral check).* Leaves the wrong-`itemsPath`
  class undetected until a real `api-fetch` fails in the wild.
- *Validate-only alone (no scaffold/docs).* Reduces cost-per-rejection but not
  rejection count — the report's dominant pain.

### D6 — Auth discoverability: probe scaffold mode + expanded worked example

Two coordinated changes close issues #1, #4, #6, and #7:

1. **`api-probe` grows a scaffold mode** (`scaffold: true`) that emits the
   *whole* recipe skeleton — top-level fields (`domains` defaulted from
   hostname, `apiHost`, `responseShape`, `gatherAllMax`) + an `auth:` block
   *translated from the probe's auth-injection params* (synthesizing
   `kind: static-key` + `requires: [<names>]`) + the op block. **Pagination
   stays op-level only** — a single probe sees one response from one endpoint,
   which can justify that op's `pagination:` block (as `emitDraft` already does
   at `api-probe.ts:581`) but cannot justify a top-level `pagination:` default
   claiming every op pages the same way. Top-level pagination is a manual
   hoist during the D9 fetch→edit→save loop, once the author has verified
   several ops page identically.
2. **The worked example expands in-place** to document `static-key` alongside
   `none`, **and drops its hardcoded `updated`/`verified` dates** to
   demonstrate the omit-and-default pattern (with a comment noting the tool
   stamps them). This is load-bearing for D2: the stale-literal root cause is
   closed by not training the agent to copy a date, not by the parser
   outsmarting a copied value.

**Rationale.** The report's 3/4 rejections came from an agent reverse-engineering
the `static-key` schema from error messages. The probe already takes
auth-injection params; translating them into the guide's `auth:` schema at
scaffold time removes the hand-assembly that caused the guessing. The worked
example is the other discoverability surface — expanding it in-place (rather
than a separate reference doc) meets the agent where it already looks.

**Rejected:**

- *Docs-only (expanded example + a dedicated auth field reference; probe
  unchanged).* Least machinery, but bets on the agent reading docs — the CMC
  report shows it doesn't always.
- *Multi-example picker (replace the single worked example with a menu of
  none/static-key-header/static-key-query).* More explicit discoverability, but
  more example surface to maintain and a two-step (pick then fill) the
  in-place expansion avoids.
- *Probe scaffold + multi-example picker (both).* Max discoverability, max
  maintenance surface — more than the pain warrants.

### D7 — Delimiter error fix: diagnose the missing closing `---`

Change the "no frontmatter found" diagnostic in `parseApiGuide` to diagnose a
*missing closing `---` delimiter* when the opening `---` is present but the
closer isn't.

**Rationale.** Issue #2 was a misleading error that cost a round-trip. The
worked example shows the closing `---`, but it's easy to drop when pasting a
recipe together. A correct message points at the cause. Low-cost, in-scope
regardless of the other decisions.

### D9 — Editing existing guides: fetch-recipe affordance on `api-learn`

`api-learn` with `domain` but **no `recipe`** returns the current raw recipe
string (instead of today's "Recipe is required" error). Edit stays
whole-recipe re-send; it composes with the (now-dropped) validate flag's
absence by relying on the save path's existing structural validation.

**Role split (load-bearing):**

| Tool | Mode available | Returns | Job |
|---|---|---|---|
| `api-guide` | on + learn | **rendered** view (op list, prose, auth summary) | *use* a guide / navigate the API |
| `api-learn` | learn only | **raw** recipe (template, or existing guide to edit) | *author/edit* a guide |

**Rationale.** The real editing friction wasn't the edit mechanism (whole-recipe
re-send works) — it was that there was no tool path to *fetch the current raw
recipe*, because `api-guide` returns a rendered view only, forcing a `bash`-read
of `guide.md`. Repurposing the `domain + no-recipe` branch from "error" to
"return current recipe" closes the read loop so the whole edit flow (fetch →
modify → save) runs through tools. The role split is clean: on-mode = use
(rendered); learn-mode = author (raw). The affordance is learn-gated for free
because `api-learn` is learn-only.

**Fetch-recipe behavior by guide count** (`api-learn({domain})` with no
`recipe`, no `new`):

| Guides for `domain` | Behavior | Calls to edit |
|---|---|---|
| 0 | fresh domain-specific template (bootstrap — same path as `new:true`) | 1 |
| 1 | that guide's raw recipe, **with the `dirName` surfaced** (see below) | 1 |
| N | D12 disambiguation menu (by `shortName`), then the selected guide's raw recipe **with `dirName` surfaced** | 2 |

The **0-guide row** is the natural bootstrap: no existing recipe to fetch, so
return a fresh template (pre-filling `domains: [<domain>]`). This is the same
template path `new:true` reuses, so there is one template-producing branch,
gated by "(no guide exists) OR `new:true`."

**`dirName` surfacing (load-bearing — overwrite mitigation).** The write path
keys on `domain` = literal subdirectory name (`api-learn.ts:277–281`:
`join(guidesDir, domain)`), while the D12 disambiguation menu resolves by
`shortName`. For a multi-guide domain (`archive.org` claims `archive.org/` +
`archive.org-wayback/`), an agent that fetches via routing `domain: "archive.org"`

- `guide: "wayback"` and then re-passes that routing `domain` on save would
write to `archive.org/guide.md` and **clobber the sibling guide**. The
fetch-recipe response therefore **must surface the resolved `dirName`**
(e.g. `Directory: archive.org-wayback — pass this as \`domain\` when re-saving`)
so the agent passes the dirName, not the routing domain, back on save. This is
the smallest close: zero new write-path params, zero new resolution logic on
the write side — the agent copies the dirName it was just shown. (Read-side
disambiguation alone is necessary but not sufficient; it makes the agent *aware*
which guide it's editing but does not hand it the key the write path needs.)

**Fresh-template gesture: `new:true`.** `api-learn({domain, new: true})` returns
a domain-specific starter template regardless of existing guides for that
domain — the path for authoring a *second* guide on a domain that already has
one. Pre-fills only what is reliably known: `domains: [<domain>]`. Other fields
(`apiHost`, `organization`, `shortName`, `operations`) are left as placeholders
for the agent to fill, with the op block sourced from `api-probe({scaffold:
true})` (D6). Reuses the bootstrap template branch; does not touch existing
guides. The agent already knows whether it is editing or creating, so an
explicit `new:true` is cheaper than forcing every edit through a menu.

**Entry-point split (load-bearing).** The template and the instruction/field-
reference blocks are already separable strings in `api-learn.ts` (`WORKED_EXAMPLE`
const at L37 vs the inline `## Required fields` block at L138–180); the split
routes them to distinct entry points so each does one thing:

- Bare `api-learn()` → the **manual** (field reference, defaults, semantics) +
  a pointer to `api-learn({domain, new: true})` for a domain-specific starter.
  No worked-example recipe (superseded by `new:true`, which is domain-specific
  and therefore strictly more useful than a generic `boe.es` example).
- `api-learn({domain, new: true})` → the **template** (domain-specific,
  `domains` pre-filled), no instruction block.

Tool description updated to name both entry points.

**Scope:** D9 covers well-formed guides only. `api-learn` validates-then-writes
(`parseApiGuide` → no write on error → `writeFileSync` on success), so the
agent **cannot produce a malformed guide** through the tool path. Malformed
guides arise only from hand-edits, schema drift, or pre-existing files — all
human-initiated or migration edges, not agent authoring flows. They are already
surfaced by the `api-guide()` catalog (`⚠ malformed — <dirName>: <field>` at
`parse-api-guide.ts:1466`), and recovery is the human's (`bash`-read at the
known path, or `/api delete <dirName>` from D10) — not D9's. `findGuidesByDomain`
cannot address a malformed sibling by routing domain (its `domains:` block is
unreadable), so any fallback there would only catch the degenerate
no-healthy-siblings slice and produce mixed behavior; `ponytail:` defer
malformed-recipe fetch until a metadata sidecar lets malformed guides be
addressed by routing domain without guessing.

**Rejected:**

- *Nothing — editing already works via bash-read + re-send.* Maximalist-minimal,
  but leaves the filesystem detour that's a real fumble source for an agent that
  doesn't always know the on-disk path.
- *Structured edit ops (`add-op`, `set-auth`).* Disruptive — reopens the
  incremental-patch machinery rejected in D5 (needs a serializer; parser is
  one-way).
- *Malformed-guide fallback in `api-learn({domain})`.* Only catches the
degenerate no-healthy-siblings slice (routing domain unknown when `domains:` is
unreadable); produces mixed behavior — raw-recipe in some cases, raw+error in
others — while silently missing the 1-of-n case it nominally covered. See Scope
above.
- *Always show the disambiguation menu when a domain is claimed (even for
1 guide).* Taxes the common single-guide edit (1 call → 2) to serve the rare
"fresh template for a second guide" case — backwards from D12's stated
zero-friction-on-the-common-case rationale. The rare case is better served by
an explicit `new:true` gesture that lets the agent say "fresh template"
directly, without a menu round-trip on every edit.
- *Read-side disambiguation alone (no `dirName` surfacing).* Necessary but not
sufficient: the menu resolves by `shortName`, the write keys on `dirName`, and
the agent cannot pass the key it was never shown. Leaves the sibling-clobber
accident open. See `dirName` surfacing above.

### D10 — Recovery by deletion: `/api delete` command, always-available

**Delete is a new capability, realized as a user-typed `/api delete <domain>
[guide]` command, always-available (like `/api secrets`).** There is no delete
path today — neither a tool nor a command; the only way to remove a guide is
`bash rm`. Interactive confirm for a whole-domain; mirroring `/api secrets
--delete`. The agent is **not** given a delete tool; `api-learn`'s docs +
collision/malformed errors tell it the path exists ("if a guide is wrong, ask
the user to run `/api delete <domain>`").

**Rationale.** A destructive, irreversible op on an agent-invokable tool is a
footgun — the agent is demonstrably fallible (the CMC report), the human is the
owner of saved guides, and deletion can't be undone. Realizing delete as a
user-typed command (not an `api-learn` param) keeps the destructive op off the
agent's tool surface entirely, eliminating both the footgun and the context
clutter of a destructive param. The command earns its keep over `bash rm`
because it **invalidates the per-session cache** (a `bash rm` leaves a ghost
guide that `api-guide` / `api-fetch` still see until reload), plus path
discoverability and consistency with the existing `/api secrets --delete`
precedent.

Recovery-by-rewriting (API changed / bad content) — the more common case — is
covered by D9 (fetch-recipe) + re-save + `/api verify`. Full removal is the
human's judgment call.

**Rejected:**

- *An `api-learn({domain, delete: true})` affordance (the brainstorm's first
  proposal).* Keeps the agent off the filesystem but puts a destructive mutation
  on a tool whose other branches are read/validate/write — and gives the agent a
  self-serve destructive op.
- *Nothing — `bash rm` is enough.* Leaves the filesystem detour and the
  ghost-guide cache bug.
- *Soft delete / archive.* Over-engineered for a flat-file store the user can
  git-track; an archived-state concept the loader must skip is more machinery
  than the case warrants.

### D11 — Scaffold mode default + multi-probe: opt-in, auto-degrade

`scaffold: true` is **opt-in** and **auto-degrades**:

- **No guide exists for the domain** → emit the full skeleton (bootstrap).
- **One guide exists** → emit a single guide-formatted op block + a merge
  note naming the target dir (e.g. "merge into `archive.org`").
- **N guides claim the domain** (multi-recipe) → emit a single guide-formatted
  op block + a merge note listing every candidate dirName ("guides exist for
  this domain: `archive.org`, `archive.org-wayback` — fetch the target recipe
  via `api-learn({domain, guide})` and merge"). The probe is per-endpoint and
  domain-keyed, so it cannot know which guide a new op belongs to; it surfaces
  the choice instead of guessing. The candidate `dirName`s come free from the
  existing `findGuidesByDomain(domain)` lookup (returns `{ guide, dirName }[]`),
  and the agent picks via D9's selector — no new param on `api-probe`.

The tool decides based on guide presence; the agent can pass `scaffold: true`
on every probe safely and never get conflicting `---` blocks.

**Rationale.** The user caught a real flaw in "always emit the full skeleton":
probe is per-endpoint, so `scaffold: true` on every probe would emit N
conflicting full skeletons. The full skeleton only makes sense *once*
(bootstrap); subsequent probes should contribute op-only blocks to merge.
Auto-degrade removes that decision from the agent (which the CMC report shows
doesn't always choose well) at the cost of one guide-store lookup in the probe.

**Why opt-in, not always-on.** Always-on would break the current paste-just-op
workflow the CMC author actually used successfully; opt-in preserves it and adds
the scaffold as a discoverability lever for first-time authors.

**Rejected:**

- *Always full skeleton + docs say "first probe only."* Simplest, but bets on
  the agent reading docs — and re-introduces the exact fumble this redesign
  prevents.
- *Separate bootstrap gesture (scaffold off the probe).* Cleanest separation,
  but a second surface, and detaches the scaffold from the live fetch that
  informed it.
- *Enum `scaffold: full | op | single`.* With `single` defined as "one
  guide-formatted op block" (= today's default), the enum collapses to
  `full | single` — a two-value enum that's the boolean renamed, with
  auto-degrade removed. Lateral move: it trades implicit-but-safe for
  explicit-but-requires-choosing, re-introducing a decision the agent can get
  wrong.

### D12 — Multi-recipe composition: disambiguation menu + selector

When a domain claims multiple guides, **both** fetch-recipe (D9) and the delete
command (D10) require a guide selector (`shortName` / `dirName`) and return a
disambiguation menu otherwise. Single-guide domains need no selector. The
delete guard is: require-exists + selector-disambiguates + clear confirmation
naming the exact directory removed.

**Rationale.** Mirrors `api-guide`'s existing disambiguation pattern (which
already resolves multi-recipe domains by `shortName`). Keeps the common
single-guide case zero-friction while making the destructive delete op
unambiguous when there's any doubt.

**Rejected:**

- *Operate on `dirName == domain` directly.* Simpler, but leans on the agent
  knowing the subtle routing-domain vs. dirName distinction (e.g.
  `archive.org-wayback`).
- *Fetch returns all matching recipes concatenated.* Avoids a menu round-trip
  for fetch, but hands the agent a blob to split — a fumble source.

### D-bootstrap — `schemaVersion` defaults to `GUIDE_SCHEMA_VERSION` when absent

The parser currently leaves `schemaVersion` `undefined` when the frontmatter
field is absent. Fold in a one-line default to `GUIDE_SCHEMA_VERSION`
(currently `0`) — mirroring how `updated`/`verified` default to `TODAY()` — so
the doc's "absent defaults to 0" claim holds and every parsed guide carries
the attribution. Metadata-only as ever: never gates, warns, or alters parse
behavior (per the schema-versioning rules in `AGENTS.md`); a malformed
value still falls back to the default rather than rejecting the guide.

**Rationale.** The reviewer found that the code-grounded starting points
listed `schemaVersion (0)` as tool-defaulted when the code actually left it
`undefined` — a doc/code drift. Bootstrapping the default is a one-line change
that makes the claim true, closes the drift, and is zero behavioral risk
(metadata stays silent). Clearly in scope of the frontmatter-ownership goal
(D1).

**Rejected:**

- *Leave it `undefined` and fix only the doc.* Honest about current behavior,
  but ships no attribution on absent-field guides and leaves the drift alive
  on the code side.

### Dropped D8 — Validate-only flag (non-decision, recorded)

A `validate: true` / `dryRun: true` flag on `api-learn` was proposed and
**dropped**. Structural validation already happens on every save (invalid
recipes don't write); the flag's only added behavior would be "don't write a
structurally-valid recipe" — ceremony. It appeared to offer a token saving, but
the recipe is already in the agent's context and is re-emitted as a tool arg in
both scenarios, so the saving is marginal. Its real value ("check before
mutate" during editing) is covered by D9 (fetch-recipe) + the save path's
existing validation + git/re-authoring as the clobber safety net. The staging
feature that would have filled the genuine gap (behaviorally verify a candidate
without saving it as the real guide) is deferred as an additive future feature.

**Why this is recorded.** A future implementer who reads the CMC report's "no
dry-run mode" complaint (issue #3) will reasonably reach for a validate flag.
This record explains why the redesign answers #3 with scaffold/docs + `/api
verify` instead, and what the deferred staging feature would look like
(`_staging/` dir + promote command) if the editing-clobber pain proves real.

## The target authoring flow (end-to-end)

**Initial authoring (no guide exists for the domain):**

1. `api-probe({apiHost, path, params, scaffold: true, auth: {...}})` → emits
   the full recipe skeleton (top-level + `auth:` translated from injection
   params + op block).
2. Agent fills in the skeleton, calls `api-learn({domain, recipe})` → validates
   and writes (structural validation free on every save; `verified` tool-stamped).
3. `/api verify <domain>` (user-typed, or the agent's post-save `api-fetch`
   self-check first) → fetches all ops, stamps `verified` on success, reports
   partial failure otherwise.

**Adding an operation to an existing guide:**

1. `api-probe({apiHost, path, params, scaffold: true})` → auto-degrades to a
   single op block + merge note (guide already exists).
2. `api-learn({domain})` (no recipe) → returns the current raw recipe.
3. Agent merges the new op block into the recipe, calls `api-learn({domain,
   recipe})` → validates + writes.
4. `/api verify <domain>` → confirms the new op works.

**Recovering from a bad/obsolete guide:**

- *Fix it:* `api-learn({domain})` → fetch raw recipe → edit → `api-learn({domain,
  recipe})` → `/api verify`.
- *Remove it:* user runs `/api delete <domain> [guide]` (interactive confirm;
  cache invalidated).

**Drift check on a stale guide:**

- User runs `/api verify <domain>` in any mode → stamps `verified: today` if
  every op still works, reports which failed otherwise.

## Risks, tensions & edge cases

- **Verify report UX.** `/api verify` reports runnable-op pass/fail plus a
  "skipped — requires agent-supplied params" list. The exact report format is
  an implementation detail to pin; the semantic is **strict any-runnable-op
  failure → no stamp** (partial or all-fail), skips don't block the stamp but
  are named so the signal isn't quietly inflated — **except the all-ops-skipped
  case, which produces no stamp + a warning** (stamping `verified: today` on a
  guide never actually tested would inflate the signal; the warning names the
  fix — `verify.json` or manual `api-fetch`). The partial-fail case lists which
  ops broke; the all-fail case is N identical lines (ugly but not incorrect —
  general root-cause detection is deferred, see D4). `--force` is the
  documented escape when strictness produces a false negative (flaky API).
- **Scaffold auto-degrade on multi-recipe domains.** The "guide exists"
  check is per-domain, not per-directory. For a domain claiming several
  guides, the merge note lists *every* candidate `dirName` and defers the
  merge-target choice to D9's `api-learn({domain, guide})` selector — the
  probe cannot know which guide a new op belongs to, so it surfaces the
  choice rather than guessing. No new param on `api-probe`; the candidate
  `dirName`s are already in hand from the `findGuidesByDomain(domain)`
  lookup.
- **Scaffold top-level `pagination:`.** Scaffold mode emits pagination
  per-op only (as `emitDraft` already does at `api-probe.ts:581`), never a
  top-level `pagination:` default. A single probe sees one response from one
  endpoint, which can justify that op's pagination but not an API-wide
  default — generalizing from one sample would repeat the issue-#5 guesswork
  the redesign explicitly scopes out. A verified top-level default is a
  manual hoist during the D9 fetch→edit→save loop.
- **`verified` backwards compat.** The parser already respects an
  agent-supplied `verified` and defaults to `TODAY()` when absent (L1109–1110)
  — this is exactly D2's target behavior, so the save path needs **no new
  write mechanism**. `/api verify` (D4) is the only new stamp-to-file routine:
  it unconditionally refreshes `verified` to today on all-ops success. Existing
  guides need no migration; an old guide with a stale agent-written `verified`
  is one `/api verify` away from correction.
- **Two new `/api` commands.** `/api delete` and `/api verify` join a surface
  currently of `on | off | learn | status | helpers | secrets`. They must
  integrate cleanly with the existing subcommand dispatch; both are
  always-available (peer of `status` / `helpers` / `secrets`, not of
  `on` / `off` / `learn`).
- **Deferred staging.** If editing-clobber pain proves real, a `_staging/` dir +
  promote command is additive — safe to defer with a `ponytail:` marker. The
  git-init-your-api-guides-dir safety net is the honest v1 answer.

## Out of scope

- **Probe pagination inference (issue #5)** — inherent to single-shot probing;
  the existing honest comment is the fix.
- **web-fetch temp-file lifetime (issue #8)** — a portal issue, not an
  api-learn concern.
- **Staging / candidate-guide verification** — deferred additive future feature
  (see Dropped D8).
- **Per-operation `lastVerified` runtime health** — a runtime-health feature,
  bigger than the authoring-flow scope.
- **`oauth2` realization, cookie-login, general mutations** — pre-existing
  deferred seams, unaffected by this redesign.

## Rollout / next steps

This doc is for review. After review:

1. **Ship in two waves.** Wave 1 (independent, closes both HIGH-severity CMC
   issues first, no command-surface changes): D7 (delimiter diagnostic) + the
   worked-example half of D6 (drop stale dates, document `static-key`) +
   D-bootstrap (one-line `schemaVersion` default). Wave 2 (composes on wave 1):
   D6 probe-scaffold half + D11 auto-degrade + D9 fetch-recipe + D12
   disambiguation + D4 `/api verify` + D10 `/api delete` (the two commands
   share dispatch plumbing). D2 and D3 are framing — D2 is already the parser's
   target behavior (zero new write code; the only D2 code is the worked-example
   edit in D6), and D3 is a non-change (`api-fetch` stays read-only). D1 is the
   one-workstream framing decision, not code.
2. Testing plan — structural: parser diagnostic (D7), scaffold auto-degrade
   (D11), fetch-recipe + disambiguation (D9/D12), tool-stamped `verified`
   (D2); behavioral: `/api verify` partial-failure, `/api delete` cache
   invalidation + confirm.
3. Ship-manifest / `api-guides` exclusion checks still apply (the axis guides
   are unaffected).
