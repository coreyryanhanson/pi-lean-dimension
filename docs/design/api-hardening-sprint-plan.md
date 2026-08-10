# API Hardening + Proof Recipes — Sprint Plan

> Drafted 2026-08-10. The executable sprint breakdown for
> [`api-hardening-and-proof-recipes.md`](./api-hardening-and-proof-recipes.md)
> (the design doc — three core fixes + four proof recipes + one addendum).
> This doc is the *how/when*, not the *what/why*; read the design doc for
> rationale, evidence, and the escape-valve upgrade rules.
>
> Inherits the per-guide workflow from
> [`packages/pi-lean-host/api-guides/CONTRIBUTING.md`](../../packages/pi-lean-host/api-guides/CONTRIBUTING.md):
> one guide per turn, plan file before YAML, read the official docs with the
> browser tools, no inference in lieu of documentation.

## What ships

- **3 core fixes:** A1 XML single-record array normalization, A2
  namespaced-XML (`removeNSPrefix`), A3 Retry-After HTTP-date parsing.
- **4 proof recipes:** `arxiv.org`, `gitlab.com`, `eutils.ncbi.nlm.nih.gov`
  (PubMed E-utilities), `data-api.ecb.europa.eu` (ECB SDMX).
- **1 addendum:** DNB SRU 200-OK `<diagnostics>` surfacing (recipe-level, no
  core change).
- **First release of `pi-lean-host` is gated on Sprint 6** (Batch 3 done).

## Scope (inherited, restated for the preliminary sprint)

**In scope:** every read-only information-retrieval endpoint on each new
domain — `GET` and read-only equivalents (Atom feeds, OAI-PMH `ListRecords`,
E-utilities `esearch`/`esummary`/`efetch`, SDMX `data`/metadata queries).
**Be comprehensive** for the new endpoints: enumerate *all* documented
read-only endpoint families in the plan file, not a curated subset, then
group by shape. One operation per documented endpoint family still lands in
`guide.md` (the design doc's "one op per documented endpoint family" rule);
the plan file is where the full surface is recorded.

**Out of scope:** anything that creates, updates, deletes, uploads,
authorizes, or mutates state. Write/mutation/auth-admin endpoints are
dropped in the plan file with a one-line reason, per the
[CONTRIBUTING.md](../../packages/pi-lean-host/api-guides/CONTRIBUTING.md)
docs-reading rules.

## Sprints

| Sprint | Contents | Gated on | Network? |
|--------|----------|----------|----------|
| 0 | Doc/spec gathering + comprehensive endpoint enumeration for all 4 new domains + DNB recheck | none | yes (web tools) |
| 1 | Core: A1 + A2 + A3 with unit tests | none | no |
| 2 | arXiv guide (B1) — proves A1 + A2 | 0 (arXiv plan) + 1 | yes (`HOST_INTEGRATION=1`) |
| 3 | GitLab guide (B2) + DNB addendum (C1) | 0 (GitLab plan) + 1 | yes |
| 4 | PubMed E-utilities (B3) — A1 third confirmation | 0 (PubMed plan) + 1 | yes |
| 5 | ECB SDMX (B4) — A2 hard proof | 0 (ECB plan) + 1 | yes |
| — | **Release gate:** ship `pi-lean-host` v1 | Sprint 5 done | — |

Sprints 1 and 0 are independent and may run in parallel. Sprints 2–5 each
depend on Sprint 1 (the fix they prove) *and* on Sprint 0's plan for their
own domain. Sprints 2–5 are otherwise independent of each other and can be
parallelized across agent turns once their plan exists — **but** the design
doc orders arXiv before GitLab (A1 has the most surface area, prove it
first) and PubMed before ECB (second A1 confirmation before A2's hard
proof). Honor that order when sequencing serially.

---

## Sprint 0 — Doc/spec gathering + endpoint enumeration (preliminary)

**Goal:** for each of `arxiv.org`, `gitlab.com`, `eutils.ncbi.nlm.nih.gov`,
`data-api.ecb.europa.eu`, and a DNB recheck, land the authoritative docs
locally and write a comprehensive `endpoint-coverage-plan.md` per domain —
*before* any core code or `guide.md` is touched. This applies the
[CONTRIBUTING.md](../../packages/pi-lean-host/api-guides/CONTRIBUTING.md)
docs-reading workflow to the four new domains, with the bar set to
"every read-only endpoint family, not a curated subset."

**One domain per turn** (the one-guide-per-turn batching rule — keeps each turn's
context bounded to one API's surface).

### 0.1 — Find the canonical docs URL

The design doc names docs URLs for three domains; verify each and resolve
the remaining two:

| Domain | Design-doc docs pointer | Action |
|--------|------------------------|--------|
| `arxiv.org` | `info.arxiv.org/help/api/user-manual.html` (plain HTML, verified) | confirm, fetch |
| `gitlab.com` | "GitLab's API docs — plain; web-fetch first, browser fallback" | `web-search` to resolve the canonical REST API reference URL |
| `eutils.ncbi.nlm.nih.gov` | "NCBI Bookshelf (E-utilities chapter) — plain HTML" | `web-search` for the Bookshelf E-utilities chapter URL |
| `data-api.ecb.europa.eu` | "ECB data API documentation — verify at plan drafting" | `web-search` for the ECB SDMX data API docs |
| `services.dnb.de` (recheck) | existing guide's `docs:` URL | refetch to confirm the `<diagnostics>` behavior is still documented |

Use `web-search` whenever the design-doc pointer is a landing page or
"verify at plan drafting" rather than an exact endpoint reference. Record
the resolved canonical URL + retrieval date in the plan file — docs drift.

### 0.2 — Download the docs with the web tools

**Tool priority (inherited from [CONTRIBUTING.md](../../packages/pi-lean-host/api-guides/CONTRIBUTING.md)):**

1. **`web-fetch`** first — fast, stateless, Markdown. Good for
   server-rendered HTML (arXiv's user-manual, NCBI Bookshelf, most of these).
2. **`browser-navigate`** when `web-fetch` returns a CAPTCHA / WAF challenge
   page, an empty JS-only shell, or an OpenAPI/Swagger UI that renders
   endpoints client-side. A real Chromium session loads what `curl`/`web-fetch`
   cannot. For Swagger UI, `browser-console` can pull the full OpenAPI spec
   object (`window.ui.specSelectors.specJson().toJS()`) — the single most
   reliable way to get the authoritative path/param/enum list in one shot.
   GitLab's REST reference is a large docs site; expect to need the browser
   here.
3. **`web-search`** to find the real endpoint reference when a page is a hub.
4. **`web-guide`** `bot-detection` / `cookie-consent` if a page resists even
   in the browser.

> **Do not infer endpoints from probing the live API to compensate for
> unreadable docs** (a hard-won lesson: an earlier Federal Register plan
> invented an endpoint and missed six real ones that way). Read the official
> docs; probe only to *confirm* shapes.

**Cache large/multi-page references locally** into
`packages/pi-lean-host/api-guides/<domain>/spec/` as markdown — use
`uvx --from 'markitdown[pdf]' markitdown` for PDF specs (ECB SDMX docs are
PDF-heavy; expect this). The `spec/` dir is gitignored from the npm tarball;
it's a local dev reference so later sprints don't re-fetch.

### 0.3 — Enumerate every read-only endpoint comprehensively

Into a per-domain `endpoint-coverage-plan.md` (mirror the
boe.es / archive.org plans), record:

1. **Status quo** — which ops (likely zero for new domains) the would-be
   `guide.md` already declares.
2. **Verification table** — every documented endpoint: HTTP method, path,
   one-line purpose, auth, params, response format, in-scope ✅/❌ with a
   one-line reason for dropped (write/mutation/auth-admin) rows. **This is
   the authoritative list and it must be complete for read-only endpoints.**
3. **Grouping** — families of identical shape (same path prefix, params,
   response format), added family-by-family.
4. **Proposed `guide.md` YAML** for each new operation (one op per
   documented endpoint family, per the design doc).
5. **Implementation phases** — smallest/highest-value family first.
6. **Pagination decision per op** — offset-limit, `page` style, single-shot
   `restGet`, or server-supplied `nextLink` (cited from docs or live probe,
   not assumed — the no-speculative-pagination rule).

### 0.4 — Confirm shapes live with `probe-op.ts`

`api-guides/_shared/probe-op.ts` is the existing helper for exercising a
candidate operation through the *real* executor (`restGet` / `paginate` from
`core/helpers.ts`) without writing a guide. Once a draft op exists in the
plan file, probe it live to confirm `via` / `itemsPath` / pagination style /
params before any YAML lands in `guide.md`:

```bash
npx tsx packages/pi-lean-host/api-guides/_shared/probe-op.ts <domain> <op-name> \
  [--params '{"k":v}'] [--gatherAll]
```

> `probe-op.ts` reads the guide from `api-guides/<domain>/guide.md`, so it
> can only probe ops that are *already in the YAML*. For pre-YAML shape
> discovery during Sprint 0, either (a) write a throwaway one-op `guide.md`
> to probe against, or (b) defer probing to the implementation sprint
> (Sprints 2–5) where `guide.md` exists. **Recommended:** Sprint 0 writes
> the plan from the docs alone; `probe-op.ts` is the verification step at
> the *start* of Sprints 2–5 (confirm the planned op's shape live before
> writing the coverage test). For pagination decisions the docs don't
> state, `--gatherAll` walks every page and prints the real per-page URLs —
> this is how the GitLab `page`-style-vs-header decision gets live evidence.

### 0.5 — DNB recheck (for Sprint 3's addendum)

Refetch the DNB SRU docs and confirm the 200-OK `<diagnostics>` envelope is
documented (or at least observable). Record the finding in
`api-guides/services.dnb.de/endpoint-coverage-plan.md` as an addendum
section so Sprint 3 has the evidence inline. No new endpoints unless the
recheck surfaces a documented read-only one the guide missed.

### Sprint 0 exit criteria

- `api-guides/<domain>/spec/` populated for each domain that needed caching.
- `api-guides/<domain>/endpoint-coverage-plan.md` written for all four new
  domains, each with a complete read-only endpoint table (no write endpoints
  silently dropped — they're dropped *with a stated reason*).
- DNB plan addendum section written.
- No `guide.md` or `helper.ts` edits yet (the plan file is the deliverable).

---

## Sprint 1 — Core fixes A1 + A2 + A3 (Batch 1)

**Goal:** the three small core changes, each with a unit test, no network.
Shippable alone.

### Tasks

1. **A1 — XML single-record array normalization.** In
   `core/helpers.ts` `paginate`, immediately after
   `resolveJsonPath(data, itemsPath)` (~line 646): if the resolved node is a
   non-null non-array object/scalar, wrap it in `[node]` (~2 lines). Keep it
   at the `paginate` call site (not inside `parseResponse`, which is also
   called from `restGet` with no `itemsPath`).
2. **A2 — Namespaced XML.** `core/helpers.ts:238`: add `removeNSPrefix: true`
   to the `XMLParser` config. This is a **global** change — the parser is a
   module-level singleton, so all XML recipes (DNB, MusicBrainz, BOE, not
   just the new ones) shift inner field names prefixed→unprefixed. Re-run
   `__tests__/axis-units.test.ts` axis B to confirm zero itemsPath-resolution
   regression (no unit test asserts inner field names).
3. **A3 — Retry-After HTTP-date.** `core/transport.ts` `waitForRetry`:
   `parseInt` for delay-seconds, `Date.parse` fallback for HTTP-date; if the
   parsed date is in the past, fall through to backoff (never negative/zero
   delay). **Export `waitForRetry`** for direct unit testing.
4. **Tests:**
   - Extend `__tests__/axis-units.test.ts` with the PubMed single-`<Id>`
     fixture (A1) and an ECB-shape `message:`/`generic:`-prefixed fixture (A2).
   - New `__tests__/transport.test.ts` (A3): delay-second, HTTP-date, and
     past-dated-HTTP-date (backoff fallback) cases. The existing 429 retry
     test in `__tests__/helpers.test.ts:~1369` stays as-is.

### Sprint 1 exit criteria

- `npm run test:ci` green (no network).
- `npm run test:py-bridge` unaffected.
- All three fixes merged with their unit tests. No recipe touched yet.
- **Regression check (optional, network):** run existing XML recipe
  coverage tests under `HOST_INTEGRATION=1` (DNB, MusicBrainz, BOE) to
  confirm the global `removeNSPrefix` change causes no live regression in
  inner field-name expectations. Unit tests don't assert inner XML field
  names; only live coverage tests surface downstream agent-facing shifts.

---

## Sprint 2 — arXiv guide (B1)

**Goal:** ship `api-guides/arxiv.org/` proving A1 (single-record XML boxing
on every `max_results=1` call) and A2 (`opensearch:`/`arxiv:` prefixed
fields) on a high-value scholarly axis. Fully unauthenticated, read-only.

**Gated on:** Sprint 0's arXiv plan + Sprint 1.

### Tasks

1. Re-read `api-guides/arxiv.org/endpoint-coverage-plan.md` (from Sprint 0).
2. Write `api-guides/arxiv.org/guide.md` with one op per documented endpoint
   family (search by query, fetch by `id_list`, recent-by-category).
   Pagination: offset-limit (`start`/`max_results`), empty-page termination.
   `totalCountPath` becomes `totalResults` after A2.
3. **Probe each op live with `probe-op.ts`** to confirm `itemsPath`
   (`feed.entry`), `via`, and params before writing tests. Use `--gatherAll`
   on the search op to confirm offset-limit drains to empty.
4. No `helper.ts` expected (XML→JSON carries title/summary/authors; YAGNI on
   transforms) — only add one if a probe proves a transform necessary.
5. Co-located `endpoint-coverage.test.ts` (`HOST_INTEGRATION=1`-gated):
   every op live **+** the `max_results=1` array assertion that *is* the A1
   proof (`feed.entry` is still an array with one entry).

### Exit criteria

- `HOST_INTEGRATION=1 npx vitest run api-guides/arxiv.org/` green.
- `npm run test:ci` still green (test skipped without the env var).
- The `max_results=1` assertion passes against the live endpoint — A1 is
  *proven*, not just unit-tested.

---

## Sprint 3 — GitLab guide (B2) + DNB addendum (C1)

**Goal:** ship `api-guides/gitlab.com/` proving `page` style (built-in, zero
recipes use it yet) + paginated root-array via `itemsPath: $`, and settle
the header-pagination decision with live evidence. Then land the DNB
`<diagnostics>` addendum (recipe-level, no core change).

**Gated on:** Sprint 0's GitLab + DNB plans + Sprint 1.

### 3a — GitLab

1. Re-read `api-guides/gitlab.com/endpoint-coverage-plan.md`.
2. Write `guide.md` with read-only ops: list/search projects, users, issues
   (per the plan; comprehensive read-only coverage, one op per family).
   Pagination: `page` style + `itemsPath: $` (`page`/`per_page`, `[]` past
   last page terminates). **Note:** GitLab's `page` param is 1-based. The
   `paginate` code seeds `page` from `params[pageParam] ??
   operation.params[pageParam]?.default ?? 0` (`helpers.ts:544`), so the
   guide must declare `page` with `default: 1` — otherwise the first
   request sends `page=0`, which GitLab may interpret as page 1 or reject.
3. **Probe with `probe-op.ts --gatherAll`** to confirm `[]`-termination
   against the live API and record the header-style decision (`Link`,
   `x-next-page` verified live but *not needed*) in the guide's plan file
   per the escape-valve upgrade rules.
4. Co-located coverage test: a >1-page pagination drains to empty against
   the live API.

### 3b — DNB addendum

1. Re-read the Sprint 0 DNB plan addendum.
2. Add to `api-guides/services.dnb.de/guide.md`: a prose note on the
   200-OK `<diagnostics>` envelope that silently swallows errors (same
   family as GitHub `incomplete_results` — recipe-level, not framework).
3. Add a live coverage assertion that a `diagnostics` response is
   *surfaced*, not silently empty. **Surfacing mechanism:** a
   `<diagnostics>` response with no `<records>` makes `itemsPath`
   (`searchRetrieveResponse.records.record`) resolve to `undefined`, hitting
   the `else { break }` branch in `paginate` (`helpers.ts:667`) and yielding
   `items: [], totalFetched: 0` — indistinguishable from a genuine
   zero-results query. Surface it at the recipe level (the design doc's
   "recipe-level, not framework" rule): add a prose note in the guide's
   docs explaining the diagnostic envelope, and write a coverage assertion
   against a known diagnostic-triggering query that documents the
   `totalFetched === 0` behavior — making the swallowed-error case
   explicit rather than silent. A helper transform is *not* the right tool
   here (no core change, per the design doc).

### Exit criteria

- GitLab: `HOST_INTEGRATION=1` coverage green incl. drain-to-empty.
- DNB: diagnostics assertion surfaces the error, not an empty list.
- Header-pagination decision recorded with live evidence in the GitLab plan.

---

## Sprint 4 — PubMed E-utilities (B3)

**Goal:** ship `api-guides/eutils.ncbi.nlm.nih.gov/` — A1 on a **third
independent API** (`esearch`/`efetch` sized with small `retmax` box a
single `<Id>`/`<PubmedArticle>`), broadening XML *and* JSON coverage on one
domain (`retmode=json` and `retmode=xml` side by side). Fully
unauthenticated, read-only (3 req/s without a key — note the rate in the
guide).

**Gated on:** Sprint 0's PubMed plan + Sprint 1.

### Tasks

1. Re-read `api-guides/eutils.ncbi.nlm.nih.gov/endpoint-coverage-plan.md`.
2. Write `guide.md` with one op per documented endpoint family: `esearch`
   (search → ID list + counts), `esummary` (batch metadata by ID),
   `efetch`/`elink` if the plan includes them. Pagination: offset-limit
   (`retstart`/`retmax`), empty-`IdList` termination.
3. **Probe each op with `probe-op.ts`**; for XML ops, confirm the A1
   single-record box at `retmax=1` live. No `helper.ts` expected (A1
   normalization makes single-ID pages list-shaped) — revisit only if a
   transform proves necessary.
4. Co-located `endpoint-coverage.test.ts`: every op live + a `retmax=1`
   array assertion (same shape as arXiv's) — the third independent A1
   confirmation.

### Exit criteria

- Coverage green under `HOST_INTEGRATION=1`.
- `retmax=1` array assertion passes on a third independent API.

---

## Sprint 5 — ECB SDMX (B4)

**Goal:** ship `api-guides/data-api.ecb.europa.eu/` — the only
prefix-everywhere XML recipe (`message:GenericData`, `generic:Obs`,
`common:…`), hard-proving A2 beyond the unit fixture. High-value economics
axis (exchange rates, interest rates, money aggregates), fully
unauthenticated, read-only.

**Gated on:** Sprint 0's ECB plan + Sprint 1.

### Tasks

1. Re-read `api-guides/data-api.ecb.europa.eu/endpoint-coverage-plan.md`.
   Expect the plan to have cached the SDMX docs (likely PDF) into `spec/`
   via `markitdown` during Sprint 0. **Sprint 0 is the long pole** — five
   domains of doc gathering, and ECB SDMX docs are PDF-heavy. Budget
   accordingly. If `markitdown`/`uvx` fails or a PDF is too complex, fall
   back to browser-rendered PDF (`browser-navigate`) or manual endpoint
   enumeration from a web page. If a domain's docs are behind a WAF/captcha
   that resists even `browser-navigate` + `web-guide` bot-detection guides,
   flag it in the plan file rather than inferring endpoints from probing.
2. Write `guide.md` with the `service/data/{flow}/{key}` family as SDMX-ML
   XML (`format=sdmx-json` available as a JSON sibling op). Treat as
   single-shot `restGet` ops unless the Sprint 0 probe showed pagination
   (no-speculative-pagination rule). Single `<DataSet>` per response is
   normal `restGet` behavior — A1 is a `paginate`-only fix, so ECB's real
   proof target here is **A2** (prefix-free `itemsPath` on prefix-everywhere
   XML).
3. **Probe with `probe-op.ts`** to confirm the prefix-free `itemsPath`
   resolves against the live SDMX-ML response (this *is* the A2 hard proof).
4. CSV variant (`format=csvdata`): declared as `format: text` (raw
   passthrough — `parseResponse` returns the body string as-is, no
   `helper.ts` / transform needed). The agent receives the raw CSV and
   splits it. *Exercises* the parked CSV path live; the built-in CSV
   `ResponseFormat` promotion stays parked (out of scope here).

   When implementing this op, leave a `ponytail:` TODO in the ECB guide
   (or a co-located code comment) noting that CSV promotion to a
   first-class `ResponseFormat` is deferred until a guide needs
   structured cell access beyond raw passthrough.
5. Co-located coverage test asserting the prefix-free `itemsPath` resolves
   against the live SDMX-ML response.

### Exit criteria

- Coverage green under `HOST_INTEGRATION=1`.
- Prefix-free `itemsPath` resolves on prefix-everywhere XML live — A2 hard
  proof done.

---

## Release gate

After Sprint 5: all three fixes proven live on ≥2 independent APIs (A1 on
arXiv + PubMed + ECB, A2 on arXiv + ECB, A3 spec-correct with unit test),
four new high-value read-only guides shipped, DNB addendum landed. Ship
`pi-lean-host` v1. Bump the lockstep version via
`scripts/sync-versions.js` (per the monorepo AGENTS.md release pipeline),
then run `npm run publish:dry` to inspect tarballs (the `api-guides/` dir
and `spec/` caches are excluded from the tarball — confirm with the
ship-manifest test) before `npm run publish`.

## Cross-cutting rules (inherited, non-negotiable)

- **Cite the source** in every plan/guide; record the live docs URL +
  retrieval date. Docs read with `web-fetch` first, `browser-navigate` when
  WAF/JS/SPA/captcha — never infer endpoints from probing to compensate.
- **Comprehensive read-only enumeration** in every Sprint 0 plan file;
  writes/mutations/auth-admin dropped with a stated reason, never silently.
- **No speculative helpers, no speculative pagination.** `page` for GitLab
  because empty-array termination was verified live; `nextLink` stays
  server-supplied-only. `probe-op.ts --gatherAll` is how pagination
  decisions get live evidence.
- **Read-only only;** one operation per documented endpoint family in
  `guide.md`; tests co-located in the guide dir, never in
  `packages/pi-lean-host/__tests__/`.
- **Plan file before YAML** — no `guide.md`/`helper.ts` edits in the same
  turn that drafts the plan (the plan-before-YAML rule). Sprint 0
  writes plans; Sprints 2–5 implement from approved plans.
- **One guide per turn** within Sprint 0 and within the implementation
  sprints — keeps each turn's context bounded to one API's surface.

## Out of scope (deferred, from the design doc)

- **CSV `ResponseFormat`** — parked; local path exists (`format: text`
  raw passthrough, agent splits the CSV). Promote to a first-class
  `ResponseFormat` with proper row/cell parsing when a guide needs
  structured cell access beyond raw passthrough. ECB's CSV variant
  *exercises* the parked path live but does not promote it.
- **Header-aware pagination style** — parked with the GitLab decision
  record (Sprint 3). Revisit only if a header-*only* API surfaces.
- Rejected during research: JSON:API vendor media type, query-param API
  keys, NDJSON, epoch timestamp params, big-int fields.
