# Phase 1 — Adversarial schema re-review (post v1 auth reshape, schemaVersion 1, unpublished)

Reviewer: base oracle (this session). Grounding: `core/api-guide-types.ts` (full read),
`core/parse-api-guide.ts` (full read of validateOperation / validateAuth / validateOAuth2Auth /
validatePagination / validateResponseShape / parseApiGuide / allowlist constants),
`core/helpers.ts` (serializeParamValue, PaginateResult, paginate header handling),
`core/local-helpers.ts`, `core/resolve-op.ts`, `docs/design/api-helper-escape-valve.md`,
all four prior lane reports, the backlog doc, plus one **empirical parser probe** (vitest run
against the real `parseApiGuide`, since deleted).

Standing constraints honored throughout: read-only forever (no fix proposes mutations),
one parser / two call sites, host-only boundary, one local helper per domain.

## Executive summary

The prior review's *API-pattern* coverage holds up well under adversarial re-reading — every
remaining P1/P2 classification I re-traced against code is correct or correctly conservative.
What the prior review **missed** is a *schema-integrity* axis it had already established the
precedent for: the unknown-key allowlists it demanded for pagination (the cleared P0) were
implemented for pagination, auth, param-specs, and SecretRefs, but **never for the operation
block, the guide frontmatter, or `responseShape`** — the three largest authored surfaces. I
empirically confirmed (`parseApiGuide` probe) that a typo'd `errorPaths:` on an op, a stray
`unknownOpKey:`, and a guide-level `totallyUnknownGuideKey:` all **parse fine and silently
no-op**. Completing that closed-schema pass later is a parse-behavior tightening → a
schemaVersion bump. That is the one genuine **P0-class** miss. Beyond it: two new P1 freeze
notes (helper return-contract magic-value trap; transform-per-item semantics pin), one P1
status finding (the backlog's own "cheap-now" doc actions from P1-1/P1-3 have **not landed in
code comments** — the `tokenKey` reserved-seam anchor they reference doesn't even exist in
`api-guide-types.ts`), and three small P2/watch additions.

---

## RE-AUDIT of existing backlog items (all verdicts code-grounded)

| Item | Verdict | Reason (one line) |
|---|---|---|
| P1-1 request-derived credentials seam | **KEEP P1 — but still OPEN** | Ordering claim verified (`resolve-op.ts:120–208`: helper→transform-load→auth at step 3, before executor builds URL; `SecretResolution` carries no request context). **The doc-only action has not landed**: `core/api-guide-types.ts` contains no request-derived-credentials seam note, and the `tokenKey` reserved-seam paragraph it says to sit "next to" also does not exist there (it lives only in AGENTS.md) — grep `tokenKey` in `core/*.ts` returns nothing. |
| P1-2 linkHeader freeze | **KEEP P1** | Verified: `PaginateResult` (`helpers.ts:94–120`) exposes no headers; all extraction fields resolve body-only. Frozen shape still correct; `linkRel` + SSRF-keying-off-style still the right call. |
| P1-3 requiresAnyOfGroups freeze + comment fix | **KEEP P1 — comment fix still OPEN** | The additive escape is reserved in code (`api-guide-types.ts:327–328`), but the misleading **"mutually exclusive peers"** comment is still present at `api-guide-types.ts:325` **and** in two parser error messages (`parse-api-guide.ts:1564`, `:1620`). The doc's "fix the comment while it's free" has not been executed. |
| P1-4 pin XML / `$` idioms | **KEEP P1 — partially landed** | `@_`/`#text`/removeNSPrefix are exercised incidentally by axis-units (`axis-units.test.ts:663–666`) but there is **no dedicated canonical-Atom contract test** asserting the exact parsed shape, and the `itemsPath: "$"` idiom is documented nowhere in-repo (authoring reference is caritas-side). Downstream-doc item; still open, correctly tiered. |
| P1-5 watch items | **KEEP** | All five still accurate against code (no `host?` on Operation, no per-op auth, `pathParams` inference unchanged, tokenBag `continuationParams: string[]` unchanged). |
| P2-1 csv/ndjson | **KEEP P2** | `VALID_FORMAT = {json,xml,text}` (`parse-api-guide.ts:115`); `format: text` + paginate still silently yields 0 items. Additive, correctly tiered. |
| P2-2 dateParams epoch/millis/yyyy-mm-dd | **KEEP P2** | `DATE_PARAM_FORMATS` still the 3-value set (`:116–120`); `normalizeDateParam` regex unchanged. |
| P2-3 maxOffset | **KEEP P2** | No max-offset guard in `PaginationConfig`/allowlists; correct additive classification. |
| P2-4 derive base64 | **KEEP (closed conclusion)** | `SecretRef` resolution still verbatim+prefix; conclusion (pre-encode at provisioning) still the right call. |
| P2-5 oauth2 grants deferred | **KEEP P2** | `OAUTH2_GRANTS` closed at 2; `paramStyle: query` still hardcodes `access_token` (recorded sub-gap intact). |
| P2-6 verified-fine closures | **KEEP** | Spot-checked: cursorPath/`itemsPath:"$"` independence, errorPath presence (`!== undefined`) semantics, refresh rotation carry-forward, quoted-bracket dotted keys (`axis-units.test.ts` axis G) — all match the doc's claims. |

**No existing item is mis-tiered.** No demotions or promotions among the survivors.

---

## NEW FINDINGS

### N1. BREAKING-RISK (P0-class) — operation-block, guide-frontmatter, and `responseShape` blocks silently ignore unknown keys

1. **PATTERN**: N/A (schema-integrity finding — the exact class of the cleared P0 pagination-allowlist item). The trigger is every authoring session: an author writing `errorPaths:` instead of `errorPath:`, `dateParam:`, or `paggination:` gets a parse-OK guide that silently no-ops the intended behavior.
2. **GAP**: `validateOperation` (`parse-api-guide.ts:1271–1901`) reads its known keys and constructs the op (`:1876`) without ever rejecting `Object.keys(o)` members outside the legal set. Same for guide-level frontmatter in `parseApiGuide` (`:1901–2268`, `m` keys read selectively, `const guide` at `:2268`) and for `validateResponseShape` (`:655–694`, format/charset only). Contrast the four sections that DID get the tripwire: param-spec (`PARAM_SPEC_KEYS` `:107`, enforced `:1423–1440`), auth (`AUTH_ALLOWLISTS` `:136`, enforced `:781–793`), pagination (`PAGINATION_ALLOWLISTS` `:168`, enforced `:458–469`), SecretRef (`:889`). **Empirically confirmed** (live `parseApiGuide` probe, vitest): a guide carrying `errorPaths:`, `unknownOpKey:`, and `totallyUnknownGuideKey:` parses OK — the typo'd error envelope never fires at runtime.
3. **CLASSIFICATION**: **P0-class BREAKING-RISK.** The natural future fix (add the three missing allowlists) is a parse-behavior tightening — per the bump rule ("changing a parse-enforced constraint's meaning"), landing it after publish forces a schemaVersion bump. Same shape, same severity, same free-now rationale as the pagination allowlist P0 that was already implemented. The typo'd-`errorPaths` case is the worst instance: the guide parses, runs, and returns data while the author believes error envelopes are being caught.
4. **PROPOSED DELTA**: mirror the existing pattern three times — `OP_ALLOWLIST` (name, via, path, accept, params, requiresAnyOf, dateParams, helper, transform, passthrough, parse, errorPath, pagination, gatherAllMax) with an allowlist↔parser tripwire test; `GUIDE_ALLOWLIST` (kind, domains, shortName, updated, icon, apiHost, verified, docs, organization, description, schemaVersion, gatherAllMax, auth, pagination, responseShape, operations — nothing else); `RESPONSE_SHAPE_ALLOWLIST` (format, charset). Fold in two adjacent dead-declaration rejections while the window is open: (a) a `dateParams` key naming a **path token** is declared-but-dead (path values are never date-normalized — `buildQueryParams` only; parser check absent at `:1628–1672`), reject it like `secretPathRefs` rejects declared-but-unused; (b) optionally, `secretQueryRefs` × pagination **wire-name** collision (unchecked — the cross-field guard at `:2196–2201` covers only op `params` maps, not pageParam/cursorParam/tokenParam/tokenBag wire names). One caveat to execute with the delta: audit the caritas corpus (and any user-authored guides) for stray-but-benign keys before flipping the frontmatter allowlist on — the whole point is doing this before those exist at scale.
5. **CONFIDENCE**: **High — empirically verified** (live parse probe), not just code-read.

### N2. BREAKING-RISK (P1 freeze) — local-helper return contract: the magic-wrapper trap

1. **PATTERN**: The escape-valve doc itself anticipates helper upgrades ("break freely to generalize"). The foreseeable upgrade: a helper that also needs to set **request headers** (e.g. per-op `Accept-Version`, X-headers the API requires) or tweak the **path** pre-call. (No single named API is required to justify the freeze — the freeze exists to keep the *fix shape* additive whenever the first one arrives.)
2. **GAP**: `HelperFn` returns `Record<string, unknown>` — *the params record itself* (`local-helpers.ts:70–89`; escape-valve doc line 48 pins "signature `(params, ctx) => params`"). The lazy future fix — interpret a returned object that happens to contain reserved wrapper keys (`{ params, headers, path }`) as a structured result — **re-means a legitimate params record** whose query params are literally named `params`, `headers`, or `path`. That is the `nextLinkPath: "header:Link"` magic-value class: a re-meaning of an existing shape that breaks working guides.
3. **CLASSIFICATION**: P1 freeze (doc-only, one paragraph). No code, no schema field — a commitment, same class as P1-3.
4. **PROPOSED DELTA**: reserved-seam note in `local-helpers.ts` (next to the contract block) + the escape-valve doc: *"The default export's return stays the params record. Richer pre-call control (headers, path rewrite) lands as a NEW named export (e.g. `buildRequest`) or a new op field — never by overloading the default export's return shape with reserved wrapper keys."*
5. **CONFIDENCE**: High on the trap mechanics (contract read directly); the timing of the first demand is unknowable — which is exactly why it's a P1 freeze, not a build.

### N3. P1 freeze addition — pin `transform`'s per-item semantics on `paginate` (fold into P1-4's contract-pinning)

1. **PATTERN**: Envelope-metadata APIs (OpenAlex-style `{meta, results}`) tempt a future "let transform see the whole page" generalization — `meta` is exactly the kind of thing a transform author wants alongside per-item shaping.
2. **GAP**: `transform: true` on `via: paginate` is **per-item by documented contract** (AGENTS.md + escape-valve doc: "per-item (`paginate`)"). A future natural fix that hands the whole page to `transform` on paginate ops would re-mean an existing field's behavior for every paginating guide with a transform — a behavior-level re-meaning of the exact class the schema can never take back cheaply.
3. **CLASSIFICATION**: P1 doc-only (one sentence in P1-4's pin list / escape-valve doc): whole-envelope transform lands as a new field (e.g. `transformPage?: boolean`), never by changing what `transform` receives on paginate.
4. **CONFIDENCE**: High (contract is explicitly documented today; the temptation is real and adjacent to a verified API pattern).

### N4. P2 — `listStyle: "semicolon"` was proposed by the operations lane but not landed

1. **PATTERN**: StackExchange `tagged=c;java` (operations lane, verified). `LIST_STYLES = [comma, repeat, bracket]` (`api-guide-types.ts` / `parse-api-guide.ts`) — semicolon was in the lane's proposed delta and silently dropped from the implementation.
2. **GAP/CLASSIFICATION**: Convenience-only (agents can pre-join with `;`; undeclared values pass through raw). Enum extension = non-event whenever. Correct to keep P2 — but the backlog doesn't record it at all, so it should be tracked (see research Q3).
3. **PROPOSED DELTA**: one P2 line; add the enum value when a recipe needs it.
4. **CONFIDENCE**: High on the mechanics; the frequency question goes to research.

### N5. P2/watch — `OAuth2Auth` cannot declare `headers` / `secretQueryRefs` / `secretPathRefs`

1. **PATTERN**: APIs requiring an OAuth2 Bearer **plus** a second credential in a query param or path token, or a literal non-secret header, on the same read endpoints (candidate class: Amadeus-style `apikey`+token layering — see research Q1; Twitch's `Client-Id` is already covered by `secretRefs`).
2. **GAP**: `OAuth2Auth` carries only `secretRefs` (request headers). `AUTH_ALLOWLISTS.oauth2` rejects `headers`, `secretQueryRefs`, `secretPathRefs` on an oauth2 block — expressible only via a sibling static-key guide, which then can't also inject the Bearer.
3. **CLASSIFICATION**: **Additive-relaxation, NOT breaking-shaped** (allowlist additions are non-events per the bump rule) — so this is a P2 expressibility note / watch item, not a freeze. Record it so it isn't re-derived later.
4. **CONFIDENCE**: High on the code state; the real-world frequency is research Q1.

### N6. Closed — no P0 among the API-pattern axes

Beyond N1, nothing found that an existing bundled axis-guide fixture or imminent caritas
recipe WILL hit whose fix is breaking-shaped: `via`/auth-kind/grant/format/style enums are all
open-ended-additive; `SecretRef` survives verbatim schemes (prior lane verdict re-verified);
slot-key seams unchanged; verify.json sidecar and token stores are host-side JSON shapes
(additive by construction). **The single P0-class item is N1.**

---

## P0 verdict

**Yes — one P0-class item (N1): the three missing unknown-key allowlists (operation, guide
frontmatter, responseShape), optionally with the two dead-declaration rejections folded in.**
It is the same class as the already-cleared pagination-allowlist P0, it is empirically
confirmed, the fix is ~40–80 lines mirroring four existing in-repo precedents, and it bumps if
landed after publish. Recommend scheduling it before the hard-gate flip (the
schema-version-hard-gate plan makes post-publish bumps strictly more expensive).

## Status corrections for the backlog (cheap-now actions that silently didn't land)

1. **P1-1's reserved-seam paragraph is not in `api-guide-types.ts`** — and the `tokenKey`
   reserved-seam comment it was to sit next to isn't either (AGENTS.md-only). Both should be
   added to the types file now; AGENTS.md is agent-facing, the types file is author/developer-facing
   where the seam actually gets consulted.
2. **P1-3's "mutually exclusive peers" comment fix** is still outstanding in three places
   (`api-guide-types.ts:325`, `parse-api-guide.ts:1564`, `:1620`).

These are exactly the "doc-only now, free" items the P1 tier exists for — the backlog reads as
if they're done ("folded into P1-3 above"); they are not.

---

## Research questions

Partitioned into `research-a-questions.md` (auth+pagination) and `research-b-questions.md`
(operations/response/store). 4 questions total — only where live evidence would change a tier
or close a recorded suspicion. All code-grounded findings above stand on their own evidence
and need no web verification.
