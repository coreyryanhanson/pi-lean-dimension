# Final recommendations — pi-lean-host schema re-review (synthesis pass)

Inputs: `docs/design/schema-v1-pre-release-backlog.md` (doc under revision),
`/tmp/pi-schema-review/phase1-report.md` (adversarial audit),
`research-a-brief.md` / `research-b-brief.md` (live web evidence). Every
load-bearing phase-1 claim below was **re-verified against the code in this
pass** (not trusted from the audit): `validateOperation`, `parseApiGuide`
frontmatter, and `validateResponseShape` were read in full; the four existing
allowlist precedents (`PARAM_SPEC_KEYS`, `AUTH_ALLOWLISTS`,
`PAGINATION_ALLOWLISTS`, SecretRef), the `dateParams` runtime path
(`helpers.ts` query assembly + passthrough loop vs `fillPathTemplate` raw
fill), the `secretQueryRefs` cross-field guard, `LIST_STYLES`, `PaginateResult`,
and the three "mutually exclusive peers" comment locations were each checked.

## Executive summary

1. **No existing P1/P2 item is mis-tiered** — every classification re-traced
   against code is correct or correctly conservative; all verdicts are KEEP.
2. **One P0 is reinstated** (P0-1): the unknown-key allowlist tripwire landed
   for param-spec/auth/pagination/SecretRef but never for the three largest
   authored surfaces — op blocks, guide frontmatter, `responseShape`.
   Completing it after publish is a parse tightening → a `schemaVersion` bump.
   Empirically confirmed (live parse probe) + re-verified in code here.
3. **P1-1's premise is partially falsified by evidence**: the HathiTrust Data
   API (OAuth 1.0 HMAC-SHA1-signed read GETs) puts request-derived credentials
   squarely inside the doc-data corpus — the seam note must land now and the
   trigger is recorded. Still not a build-now.
4. **Research closures**: no Bearer-plus-query/path-token dual-credential API
   exists among prominent read APIs (Etsy's Bearer + `x-api-key` header is
   expressible today via oauth2 `secretRefs`); semicolon lists are
   StackExchange-only, but **pipe** (MediaWiki Action API) is a stronger
   missing `listStyle` value; date-in-path read APIs are confirmed (Polygon,
   Frankfurter v1), justifying the dead-`dateParams`-on-path-token rejection
   inside the P0 pass.
5. New items: **P1-6** (local-helper return-contract freeze), a new pin folded
   into **P1-4** (transform per-item semantics), **P2-6** (`listStyle`
   semicolon/pipe), plus closures added to the verified-fine list (renumbered
   P2-7). Two P1 doc-only actions are confirmed **still un-landed in code**.

## Per-item verdicts (existing backlog)

| Item | Verdict |
|---|---|
| P1-1 request-derived credentials seam | **KEEP P1** — amend rationale + record trigger (edits 5–7) |
| P1-2 linkHeader freeze | **KEEP P1** — unchanged |
| P1-3 requiresAnyOfGroups freeze + comment fix | **KEEP P1** — comment fix confirmed outstanding (edit 8) |
| P1-4 pin XML / `$` idioms | **KEEP P1** — merge in the transform-per-item pin (edit 9) |
| P1-5 reserved-seam watch items | **KEEP P1** — unchanged |
| P2-1 csv/ndjson formats | **KEEP P2** — unchanged |
| P2-2 dateParams extensions | **KEEP P2** — unchanged (path-token dates are handled by P0-1's rejection + future additive relaxation) |
| P2-3 maxOffset guardrail | **KEEP P2** — unchanged |
| P2-4 derive: base64 | **KEEP** (closed conclusion) — unchanged |
| P2-5 OAuth2 grant coverage | **KEEP P2** — unchanged |
| P2-6 verified-fine closures | **KEEP** — renumber to P2-7, add closures (edits 11–12) |

**Justifications.**

- **P1-1 — KEEP, amended.** The ordering claim re-verified in the audit holds
  (`resolve-op.ts` resolves auth before the executor builds the URL;
  `SecretResolution` carries no request context), so the freeze rationale is
  intact. But web evidence **confirms an in-class trigger exists**: the
  HathiTrust Data API — a scholarly digital library, exactly the doc-data
  corpus caritas targets — requires OAuth 1.0 HMAC-SHA1-signed GETs on its
  read resources (`getmeta`, `getstructure`, `getpageocr`, …), with signature
  params appended to the URL. The doc's premise that the class is
  "crypto/trading/AWS — plausible caritas territory, **not the current
  doc-data corpus**" is falsified; the "zero bundled recipes need it" claim
  remains true, so build-now is still wrong (signing machinery must be
  designed against a live provider), but the seam note's urgency rises and
  the trigger must be recorded. Separately, the audit verified the doc-only
  action **has not landed**: `core/api-guide-types.ts` contains neither the
  seam paragraph nor the `tokenKey` reserved-seam paragraph it is supposed to
  sit next to (`tokenKey` appears nowhere under `core/` — it lives only in
  AGENTS.md).
- **P1-2 — KEEP.** Re-verified: `PaginateResult` (`helpers.ts`) exposes no
  headers; all extraction fields resolve body-only. The frozen shape
  (`linkHeader` style + `linkRel`, SSRF keyed off the new style,
  `totalCountHeader` later) remains correct. No new evidence.
- **P1-3 — KEEP.** The additive escape is already reserved in code
  (`api-guide-types.ts`: "a multi-group `requiresAnyOfGroups` upgrade is
  purely additive"). The comment fix is confirmed **still outstanding in
  three locations** — `core/api-guide-types.ts:325` (field doc comment),
  `core/parse-api-guide.ts:1564` and `:1620` (the latter inside a
  user-visible `fix:` string). The doc should record the status so it isn't
  read as done.
- **P1-4 — KEEP, gains one pin.** Verified: no dedicated canonical-Atom
  contract test exists (axis-units exercises `@_`/`#text` incidentally);
  `itemsPath: "$"` is documented nowhere in-repo. The re-audit's transform
  finding (N3) folds in as pin #4: `transform: true` on `via: paginate` is
  per-item by documented contract, and whole-envelope transforms must land as
  a new field (`transformPage?`), never by changing what `transform` receives
  — a behavior-level re-meaning of the exact class the doc exists to prevent.
- **P1-5 — KEEP.** All five watch items re-verified accurate against code.
- **P2-1/P2-2/P2-3 — KEEP.** `VALID_FORMAT`, `DATE_PARAM_FORMATS`, and the
  absence of a max-offset guard all re-verified; classifications unchanged.
  Q4's evidence (date-in-path APIs) does not promote P2-2: agents pre-format
  dates reliably, and the path-token footgun is closed by P0-1's dead-
  declaration rejection, with normalization-as-a-feature left as a future
  additive relaxation.
- **P2-4 — KEEP (closed conclusion).** `SecretRef` resolution still
  verbatim+prefix; pre-encode-at-provisioning remains the right call. Web
  evidence did not surface a contradicting pattern.
- **P2-5 — KEEP.** `OAUTH2_GRANTS` closed at 2 grants; `paramStyle: query`
  still hardcodes `access_token`; the recorded sub-gap is intact. HathiTrust
  is OAuth **1.0**, which belongs to P1-1's derived-credential class, not to
  a new oauth2 grant.
- **P2-6 → P2-7 — KEEP, renumbered, closures added.** Spot-checks in the
  audit matched the doc's claims. New closures from research: Etsy
  (Bearer + second header = expressible via oauth2 `secretRefs`) and the
  honest negative search for Bearer-plus-query/path-token dual credentials
  (Amadeus refuted as an exchange-not-layering). See edit 12.

## New items (backlog house style)

### P0-1. Closed-schema pass — op blocks, guide frontmatter, and `responseShape` silently ignore unknown keys

*(Full text in edit 4 — this is the item to insert.)*

- **Pattern:** N/A — schema-integrity, the exact class of the completed
  pagination-allowlist item. Trigger is every authoring session:
  `errorPaths:` for `errorPath:`, `paggination:`, a stray `unknownOpKey:` on
  an op, or `totallyUnknownGuideKey:` at guide level all **parse OK and
  silently no-op**. Worst instance: the typo'd error envelope never fires —
  the guide runs and returns data while the author believes 200-with-error
  pages are being caught.
- **Gap (re-verified in this pass):** the unknown-key tripwire exists for
  four authored sections — param-spec (`PARAM_SPEC_KEYS`, enforced),
  auth (`AUTH_ALLOWLISTS`, enforced), pagination
  (`PAGINATION_ALLOWLISTS`, enforced), SecretRef (validated) — but not the
  three largest surfaces. `validateOperation` (`parse-api-guide.ts`) reads
  its known keys and constructs the op without ever rejecting
  `Object.keys(o)` members outside the legal set; the guide frontmatter in
  `parseApiGuide` reads keys selectively into `const guide` with no allowlist;
  `validateResponseShape` reads `format`/`charset` only. Empirically
  confirmed by a live `parseApiGuide` probe (phase-1 report).
- **Classification:** **P0.** Completing the allowlists later is a
  parse-behavior tightening — per the bump rule it forces a `schemaVersion`
  bump after publish; free now. Same shape, severity, and free-now rationale
  as the pagination allowlist P0 this doc already shipped.
- **Fix shape (free only now):** mirror the existing pattern three times,
  each with the both-directions allowlist↔parser tripwire test:
  `OP_ALLOWLIST` (name, via, path, accept, params, pathParamDocs,
  requiresAnyOf, dateParams, helper, transform, passthrough, parse,
  errorPath, pagination, gatherAllMax), `GUIDE_ALLOWLIST` (kind, domains,
  shortName, updated, icon, apiHost, verified, docs, organization,
  description, schemaVersion, gatherAllMax, auth, responseShape,
  operations, pagination — nothing else), `RESPONSE_SHAPE_ALLOWLIST`
  (format, charset). Fold in two adjacent dead-declaration rejections while
  the window is open: (a) a `dateParams` key naming a **path token** is
  declared-but-dead — re-verified: normalization runs only in query assembly
  (`helpers.ts` `buildQueryParams` + the passthrough loop);
  `fillPathTemplate` fills path tokens raw — reject it like `secretPathRefs`
  rejects declared-but-unused (a future relaxation that normalizes
  path-token dates is additive; confirmed real pattern: Polygon.io
  aggregates `{from}`/`{to}` and Frankfurter v1 `/{date}` put ISO dates in
  path segments with no query alternative); (b) `secretQueryRefs` names are
  checked against op `params` maps but **not against effective pagination
  wire names** (`pageParam`/`cursorParam`/`tokenParam`/tokenBag continuation
  keys) — re-verified: the cross-field guard covers only declared op params,
  so an injected query secret can be dead or overwritten by continuation
  writes. Caveat: audit the caritas corpus and any user-authored guides for
  benign stray keys before flipping the frontmatter allowlist on.
- **Confidence:** high — empirically confirmed (phase-1 parse probe) and
  independently re-verified in code in this synthesis pass.

### P1-6. Reserved seam — local-helper return contract (magic-wrapper trap)

*(Full text in edit 10.)*

- **Pattern:** the escape-valve doc itself anticipates helper upgrades
  ("break freely to generalize"). The foreseeable one: a helper that also
  needs to set **request headers** (per-op `Accept-Version`, required
  X-headers) or tweak the **path** pre-call. No single named API is needed —
  the freeze exists so the fix shape stays additive when the first one
  arrives.
- **Gap:** `HelperFn` returns the params record itself (`local-helpers.ts`;
  escape-valve doc pins `(params, ctx) => params`). The lazy future fix —
  interpreting a returned object that happens to contain reserved wrapper
  keys (`{ params, headers, path }`) as a structured result — **re-means a
  legitimate params record** whose query params are literally named
  `params`, `headers`, or `path`. Same magic-value class as the
  `nextLinkPath: "header:Link"` overload P1-2 exists to prevent.
- **Classification:** P1 freeze, doc-only — a commitment, no code, no schema
  field.
- **Frozen shape:** reserved-seam note in `local-helpers.ts` next to the
  contract block + the escape-valve doc: richer pre-call control (headers,
  path rewrite) lands as a NEW named export (e.g. `buildRequest`) or a new
  op field — never by overloading the default export's return shape with
  reserved wrapper keys.

### P2-6 (new). `listStyle` enum gaps — `semicolon` and `pipe`

*(Full text in edit 11.)*

- **Pattern:** StackExchange `tagged` is semicolon-delimited with no comma
  fallback — live-checked by the researcher (`tagged=java,python` →
  `total: 0`); <https://api.stackexchange.com/docs/questions>. Stronger
  adjacent case: the MediaWiki Action API's list params are **pipe**-exclusive
  (`siprop=general|namespaces|…`) with no comma form — and MediaWiki/Wikidata
  is squarely in the corpus (the repo carries a `wikidata-search` axis
  fixture). <https://en.wikipedia.org/w/api.php?action=help&modules=query+siteinfo>
- **Gap:** `LIST_STYLES = ["comma", "repeat", "bracket"]`. The prior
  operations lane proposed `semicolon` and it silently didn't land in the
  implementation.
- **Classification:** additive convenience (agents can pre-join `;`/`|`;
  undeclared values pass through raw) — enum extension is a non-event. P2 so
  it's tracked rather than re-derived.
- **Fix shape:** add the enum values when a recipe needs them; if the
  closed-schema pass (P0-1) touches the list-style surface, add both at once.

## P0 verdict

**Yes — one P0: P0-1 above.** The phase-1 audit proposed it; this pass
verified it directly rather than endorsing on trust: `validateOperation`,
the `parseApiGuide` frontmatter section, and `validateResponseShape` were
read in full and none rejects unknown keys, while the four smaller authored
sections each do (the parser itself already contains the pattern to mirror,
including the tripwire-test precedent). Beyond P0-1, nothing found that a
bundled axis-guide fixture or imminent caritas recipe will hit whose fix is
breaking-shaped — enums are open-ended-additive, `SecretRef` survives
verbatim schemes, slot-key seams unchanged, and the stores are host-side
JSON shapes (additive by construction).

## Precise edits to `docs/design/schema-v1-pre-release-backlog.md`

Apply in order. Quotes are exact current text; replacements are exact new
text.

---

**Edit 1 — header comment (re-add P0 to the tier list).**

Old:
```
<!-- markdownlint-disable MD025 -- multiple top-level headings are deliberate:
     one H1 per priority tier (P1/P2) for backlog tooling. -->
```

New:
```
<!-- markdownlint-disable MD025 -- multiple top-level headings are deliberate:
     one H1 per priority tier (P0/P1/P2) for backlog tooling. -->
```

---

**Edit 2 — intro blockquote (record the second pass).**

Old:
```
> the complete findings ledger from that review, priority-ordered. It is
> deliberately broader-scope than the authoring/design docs: each item here
```

New:
```
> the complete findings ledger from that review, priority-ordered. A second
> adversarial pass (post-v1-reshape code re-audit + live web evidence;
> reports at `/tmp/pi-schema-review/`) reinstated the P0 tier (P0-1) and
> added P1-6, P2-6, and closures to the verified-fine list. It is
> deliberately broader-scope than the authoring/design docs: each item here
```

---

**Edit 3 — priority model (define P0).**

Old:
```
## Priority model

- **P1 — freeze decisions now (cheap, prevents later breaks).**
```

New:
```
## Priority model

- **P0 — free only now.** Parse-behavior tightenings whose lazy future
  landing forces a `schemaVersion` bump (the closed-schema window the
  completed pagination-allowlist item already used).
- **P1 — freeze decisions now (cheap, prevents later breaks).**
```

---

**Edit 4 — insert the P0 section** immediately before the line
`# P1 — Freeze decisions now (doc/commitment items)`:

```
# P0 — Free only now (parse tightenings that would bump after publish)

## P0-1. Closed-schema pass — op blocks, guide frontmatter, and `responseShape` silently ignore unknown keys

- **Pattern:** N/A (schema-integrity — the exact class of the completed
  pagination-allowlist item). The trigger is every authoring session: an
  author writing `errorPaths:` instead of `errorPath:`, `paggination:`, a
  stray `unknownOpKey:` on an op, or a guide-level
  `totallyUnknownGuideKey:` gets a **parse-OK guide that silently no-ops**
  the intended behavior. Worst instance: the typo'd error envelope never
  fires — the guide runs and returns data while the author believes
  200-with-error pages are being caught.
- **Gap:** the unknown-key tripwire landed for four authored sections —
  param-spec (`PARAM_SPEC_KEYS`), auth (`AUTH_ALLOWLISTS`), pagination
  (`PAGINATION_ALLOWLISTS`), SecretRef — but not the three largest
  surfaces: `validateOperation` reads its known keys and constructs the op
  without rejecting `Object.keys(o)` members outside the legal set; the
  guide frontmatter in `parseApiGuide` reads keys selectively into
  `const guide` with no allowlist; `validateResponseShape` reads
  `format`/`charset` only. Empirically confirmed by a live `parseApiGuide`
  probe (second-pass report).
- **Classification: P0.** Completing the allowlists later is a
  parse-behavior tightening — per the bump rule it forces a
  `schemaVersion` bump after publish. Same shape, severity, and free-now
  rationale as the pagination allowlist item this doc already shipped.
- **Fix shape (free only now):** mirror the existing pattern three times,
  each with the both-directions allowlist↔parser tripwire test:
  `OP_ALLOWLIST` (name, via, path, accept, params, pathParamDocs,
  requiresAnyOf, dateParams, helper, transform, passthrough, parse,
  errorPath, pagination, gatherAllMax), `GUIDE_ALLOWLIST` (kind, domains,
  shortName, updated, icon, apiHost, verified, docs, organization,
  description, schemaVersion, gatherAllMax, auth, responseShape,
  operations, pagination — nothing else), `RESPONSE_SHAPE_ALLOWLIST`
  (format, charset). Fold in two adjacent dead-declaration rejections while
  the window is open: (a) a `dateParams` key naming a **path token** is
  declared-but-dead (normalization runs only in query assembly;
  `fillPathTemplate` fills path tokens raw) — reject it like
  `secretPathRefs` rejects declared-but-unused; a future relaxation that
  actually normalizes path-token dates is additive (real pattern:
  Polygon.io aggregates `{from}`/`{to}` and Frankfurter v1 `/{date}` put ISO
  dates in path segments, no query alternative —
  <https://polygon.io/docs/stocks/get_v2_aggs_ticker__stocksticker__range__multiplier___timespan___from____to>,
  <https://frankfurter.dev/v1/>); (b) `secretQueryRefs` names are checked
  against op `params` maps but **not** against effective pagination wire
  names (`pageParam`/`cursorParam`/`tokenParam`/tokenBag continuation
  keys) — an injected query secret can be dead or overwritten by
  continuation writes. Caveat: audit the caritas corpus and any
  user-authored guides for benign stray keys before flipping the frontmatter
  allowlist on.
- **Confidence:** high — code-verified and empirically probed.

```

---

**Edit 5 — P1-1, "Why not build now" bullet.**

Old:
```
- **Why not build now:** new auth `kind` = additive whenever it lands (new enum
  values are non-events under the bump rule), so waiting is free schema-wise.
  Zero bundled recipes need it (crypto/trading/AWS APIs — plausible caritas
  territory, not the current doc-data corpus), and SigV4's canonical-request
  machinery (header sorting, URI-encoding rules, payload hashes) is too
  intricate to spec blind — an untestable, unused implementation would be
  wrong and still have to be redone.
```

New:
```
- **Why not build now:** new auth `kind` = additive whenever it lands (new enum
  values are non-events under the bump rule), so waiting is free schema-wise.
  Zero current recipes need it. **Re-audit correction (evidence):** the class
  is *not* confined to crypto/trading/AWS — the HathiTrust Data API, squarely
  in the doc-data corpus, signs its read GETs with OAuth 1.0 HMAC-SHA1 query
  signatures (recorded under the trigger below). Still not a build-now: no
  recipe targets it, and signing machinery (SigV4's canonical requests, OAuth 1
  nonce/timestamp/base-string) is too intricate to spec blind — an
  untestable, unused implementation would be wrong and still have to be
  redone.
```

---

**Edit 6 — P1-1, "cheap-now action" bullet (append status).**

Old:
```
  Plus one discipline rule: when touching resolve-op, do not entrench
  auth→URL ordering further.
```

New:
```
  Plus one discipline rule: when touching resolve-op, do not entrench
  auth→URL ordering further.
  **Status (re-audit): not landed** — `core/api-guide-types.ts` contains
  neither the seam paragraph nor the `tokenKey` reserved-seam paragraph it
  sits "next to" (`tokenKey` appears nowhere under `core/`; it lives only in
  AGENTS.md). Add BOTH paragraphs to the types file — AGENTS.md is
  agent-facing; the types file is where author/developer eyes land.
```

---

**Edit 7 — P1-1, "Trigger to act for real" bullet.**

Old:
```
- **Trigger to act for real:** a caritas recipe targets Binance/AWS-class
  signed GETs. At that point, design the kind against the live provider, not
  speculatively.
```

New:
```
- **Trigger to act for real:** a caritas recipe targets a signed GET. First
  recorded in-class candidate (re-audit): the **HathiTrust Data API** —
  OAuth 1.0 HMAC-SHA1-signed read GETs (`getmeta`, `getstructure`,
  `getpageocr`, …), spec at
  <https://www.hathitrust.org/documents/hathitrust-data-api-v2_20150526.pdf>
  (v0.9 revision line: "Updated to reflect OAuth 1.0 signed URL
  requirements"), corroborated by the widely-used wrapper
  <https://github.com/rlmv/hathitrust-api/blob/master/hathitrust_api/data_api.py>.
  Binance/AWS-class signed GETs remain the other trigger family. At that
  point, design the kind against the live provider, not speculatively.
```

---

**Edit 8 — P1-3, comment-fix bullet (append status).**

Old:
```
  multi-group design (e.g. wrongly auto-deriving exactly-one semantics, which
  WOULD be a re-meaning). The `default`-ban on members remains correct.
```

New:
```
  multi-group design (e.g. wrongly auto-deriving exactly-one semantics, which
  WOULD be a re-meaning). The `default`-ban on members remains correct.
  **Status (re-audit): the fix is still outstanding in three code locations** —
  `core/api-guide-types.ts:325` (the field's doc comment) and two parser
  messages (`core/parse-api-guide.ts:1564` and `:1620`, the latter inside a
  user-visible `fix:` string). The additive escape itself IS already reserved
  in code (`api-guide-types.ts`: "a multi-group `requiresAnyOfGroups` upgrade
  is purely additive").
```

---

**Edit 9 — P1-4, add pin #4.**

Old:
```
3. **`requiresAnyOf` comment correction** — folded into P1-3 above.
```

New:
```
3. **`requiresAnyOf` comment correction** — folded into P1-3 above.
4. **`transform`'s per-item semantics on `paginate`** (added by the re-audit):
   `transform: true` on `via: paginate` is per-item by documented contract
   (both executors; the escape-valve doc). Whole-envelope transforms — an
   OpenAlex-style `{meta, results}` page where `meta` is what a transform
   author wants alongside per-item shaping — land as a NEW field
   (`transformPage?: boolean`), never by changing what `transform` receives
   on paginate ops: that is a behavior-level re-meaning of an existing field
   that every paginating guide with a transform can never take back cheaply.
```

---

**Edit 10 — insert P1-6** immediately before the line
`# P2 — Additive backlog (safe anytime, ordered by expected recipe pain)`:

```
## P1-6. Reserved seam — local-helper return contract (magic-wrapper trap)

- **Pattern:** the escape-valve doc anticipates helper upgrades ("break
  freely to generalize"); the foreseeable one is a helper that also needs to
  set **request headers** (per-op `Accept-Version`, required X-headers) or
  tweak the **path** pre-call. No single named API required — the freeze
  exists so the fix shape stays additive whenever the first one arrives.
- **Gap:** `HelperFn` returns the params record itself (`local-helpers.ts`;
  the escape-valve doc pins `(params, ctx) => params`). The lazy future fix —
  treating a returned object that happens to contain reserved wrapper keys
  (`{ params, headers, path }`) as a structured result — **re-means a
  legitimate params record** whose query params are literally named
  `params`, `headers`, or `path`. Same magic-value class as the
  `nextLinkPath: "header:Link"` overload P1-2 exists to prevent.
- **Classification: P1 freeze, doc-only.** No code, no schema field — a
  commitment, same class as P1-3.
- **Frozen shape:** reserved-seam note in `local-helpers.ts` next to the
  contract block + the escape-valve doc: *"The default export's return stays
  the params record. Richer pre-call control (headers, path rewrite) lands
  as a NEW named export (e.g. `buildRequest`) or a new op field — never by
  overloading the default export's return shape with reserved wrapper
  keys."*
- **Confidence:** high on the trap mechanics (contract read directly); the
  first demand's timing is unknowable — which is exactly why it's a freeze,
  not a build.

```

---

**Edit 11 — new P2-6 + renumber old P2-6 → P2-7.**

Old:
```
## P2-6. Verified fine — cleared, no action (recorded to close the review)
```

New:
```
## P2-6. `listStyle` enum gaps — `semicolon` and `pipe`

- **Pattern:** StackExchange `tagged` is semicolon-delimited with no comma
  fallback (live-checked: `tagged=java,python` → `total: 0`) —
  <https://api.stackexchange.com/docs/questions>. Stronger adjacent case:
  MediaWiki Action API list params are **pipe**-exclusive
  (`siprop=general|namespaces|…`, no comma form) — and MediaWiki/Wikidata is
  squarely in the corpus (`wikidata-search` axis fixture) —
  <https://en.wikipedia.org/w/api.php?action=help&modules=query+siteinfo>.
- **Gap:** `LIST_STYLES = [comma, repeat, bracket]`; the prior operations
  lane proposed `semicolon` and it silently didn't land in the
  implementation.
- **Classification:** additive convenience (agents can pre-join `;`/`|`;
  undeclared values pass through raw) — enum extension is a non-event.
- **Fix shape:** add the enum values when a recipe needs them; if the
  closed-schema pass (P0-1) touches the list-style surface, add both at
  once.

## P2-7. Verified fine — cleared, no action (recorded to close the review)
```

---

**Edit 12 — add closures to the (renumbered) P2-7 list.**

Old:
```
- **Out-of-bounds (noted, dropped):** POST-based pagination (GitHub GraphQL),
```

New:
```
- **OAuth2 Bearer + second credential on one endpoint (Etsy-shaped):** Etsy
  v3 requires `x-api-key: <keystring>:<secret>` AND `Authorization: Bearer`
  simultaneously on scoped read GETs — expressible today via oauth2
  `secretRefs` (the store holds the composite; the scrub still works).
  <https://developers.etsy.com/documentation/essentials/authentication/>
  No prominent read API was found requiring Bearer **plus a query-param or
  path-token** credential (Amadeus refuted — key/secret are exchanged once
  for the token, nothing rides the calls:
  <https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/API-Keys/authorization/>).
  If one ever appears, the fix is adding `secretQueryRefs` /
  `secretPathRefs` / literal `headers` to the `OAuth2Auth` allowlist — an
  allowlist addition, a non-event, not a SecretRef reshape. Recorded so it
  isn't re-derived.
- **Out-of-bounds (noted, dropped):** POST-based pagination (GitHub GraphQL),
```

---

**Edit 13 — downstream-doc note reference.**

Old:
```
The verified-fine list (P2-6) and
out-of-bounds drops belong in the authoring-reference doc, not a fix doc.
```

New:
```
The verified-fine list (P2-7) and
out-of-bounds drops belong in the authoring-reference doc, not a fix doc.
```

---

## Standing constraints honored

Read-only forever (no proposed delta introduces a mutation or non-GET
transport), one parser / two call sites (all fixes are parser-internal
tightenings or doc commitments), host-only boundary, one local helper per
domain (P1-6 preserves the single-helper contract by routing richer control
through a new named export, not a second helper).

## What still needs the main agent

Nothing blocking. The one judgment call embedded above: P0-1's two fold-ins
((a) dead `dateParams`-on-path-token rejection, (b) `secretQueryRefs` ×
pagination wire-name collision check) are included in the P0 scope because
both are parse tightenings of the same free-now class; if the main agent
prefers a minimal P0-1 (allowlists only), the fold-ins can be dropped from
edit 4 without affecting anything else — but they then need a new P1
reserved-seam note, because post-publish they'd bump too.
