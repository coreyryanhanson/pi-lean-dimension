# Research: Adversarial schema review — pi-lean-host OPERATIONS & PARAMS axis

Scope: `Operation` (via restGet|paginate, `{token}` path templating, accept,
`params: Record<string, QueryParamSpec>`, pathParams/pathParamDocs,
requiresAnyOf, dateParams, gatherAllMax, passthrough) and `ApiGuide` top-level
(apiHost, domains[], organization, description) — stress-tested against real
public API docs (StackExchange, EIA v2, PubMed E-utilities, Bugzilla, GitHub,
MediaWiki, arXiv, Twitch Helix).

## Summary

On this axis I found **no clean BREAKING-RISK (c)** — the param/path grammar as
designed (`{token}` + closed params map + at-least-one-of) survives every real
API pattern I could document. The one place a future fix *could* force a
breaking reshape is `requiresAnyOf` multi-group, and the code already reserves
the additive escape (`requiresAnyOfGroups` as a sibling field); the actionable
item is freezing that decision against a union-type-on-same-key rewrite. The
strongest genuine gaps are additive: multi-value/repeated query keys (provably
impossible with `Record<string,string>` serialization, but nearly every real
API offers a comma/indexed fallback), missing epoch/`yyyy/mm/dd` date formats,
and header-driven pagination metadata.

## Findings

### 1. Multi-value query params — repeated-key style is provably impossible today; array values silently mis-serialize (top finding; ADDITIVE-FIX, highest priority on this axis)

**PATTERN.** Three real styles:
- Comma-joined: Bugzilla `GET /rest/bug?id=12434,43421` (Bugzilla API docs), GitHub search `labels`, arXiv `id_list`.
- Semicolon-joined: StackExchange `GET /questions?tagged=c;java` — docs: "the `tagged` parameter with a semi-colon delimited list of tags" (api.stackexchange.com/docs/questions).
- Bracket/repeat: EIA v2 `?data[]=price&data[]=revenue` and `facets[stateid][]=CO&facets[stateid][]=RES`, with `data[0]=price&data[1]=revenue` shown as the equivalent indexed form (eia.gov/opendata/documentation.php). Twitch Helix `/helix/users` `id`/`login` are "repeatable, up to 100" (the in-repo twitch guide itself documents "up to 100, repeatable" while the schema cannot send two).

**GAP.** `buildQueryParams()` in `core/helpers.ts` returns
`Record<string, string>` and serializes via `new URLSearchParams(query)` — one
value per key, ever. Two consequences:
1. A repeated-key-only API (`?tag=a&tag=b`) is **unreachable** — no agent
   workaround exists (`passthrough` forwards the same single-valued record; the
   local helper's return type is the same record).
2. **Footgun**: if the agent passes an *array* value for a list param,
   `buildQueryParams` JSON.stringify's it (`typeof val === "object" →
   JSON.stringify(val)`), producing `tag=["a","b"]` on the wire — silently
   wrong against every one of these APIs (no error, just a miss). This
   behavior change (serialize scalar-arrays as comma-joined by default, or
   reject arrays on non-`listStyle` params) touches runtime semantics, not
   YAML shape — it is NOT a bump, so it is safe to do anytime, but it is
   cheapest to decide the semantics now while no published guides encode
   `["a","b"]` as a value.

**CLASSIFICATION: ADDITIVE-FIX** (new optional `listStyle?: "comma" | "repeat" |
"bracket" | "semicolon"` on `QueryParamSpec`; new enum value = non-event per
the bump rule; no existing field re-meaned). But note honestly: most documented
GET APIs offer a comma or indexed-bracket fallback, so recipes can ship today —
this is a daily-convenience gap, not a daily blocker.

**CONFIDENCE: high** — [StackExchange /questions](https://api.stackexchange.com/docs/questions),
[EIA API docs](https://www.eia.gov/opendata/documentation.php) (fetched, shows
repeated-key and indexed forms verbatim),
[Bugzilla Get Bug](https://bugzilla.readthedocs.io/en/latest/api/core/v1/bug.html) (`GET /rest/bug?id=12434,43421`).

---

### 2. `requiresAnyOf` single-group ceiling — already reserved, but freeze the upgrade shape NOW (the one place a careless fix would be breaking)

**PATTERN.** Conditional "at least one of" params are real and common: Twitch
Helix `/helix/users` requires `id` or `login` (already encoded in the in-repo
twitch guide); MediaWiki `titles`/`pageids`/`revids` are at-least-one peers
([query help](https://www.mediawiki.org/w/api.php?action=help&modules=query)).
Multi-*group* needs (two independent at-least-one-of groups in one op) — I
could not document a compelling real case among target read APIs after probing.

**GAP/CLASSIFICATION.** The code already answers the special-attention question:
`api-guide-types.ts` on `requiresAnyOf` — *"One group per op (v1); a multi-group
`requiresAnyOfGroups` upgrade is purely additive."* Verified: adding a sibling
field touches no existing parse constraint → non-breaking. **The breaking trap
is the implementation choice, not the ceiling**: the "natural" fix of changing
`requiresAnyOf?: string[]` → `requiresAnyOf?: string[] | string[][]` would
re-mean an existing field and trigger the bump rule. Recommend a one-line
commitment in the types doc now: multi-group lands **only** as a new sibling
key (`requiresAnyOfGroups: string[][]`), never as a union on the existing key.

**PROPOSED DELTA (when/if needed):** `requiresAnyOfGroups?: string[][]` on
`Operation`, evaluated with AND semantics over groups, each group
at-least-one-of; existing single `requiresAnyOf` untouched.

Also fix the misleading doc comment while it's free: the types file calls
requiresAnyOf members *"mutually exclusive peers"*, but the runtime semantics
(at-least-one-of, all supplied members sent) and real APIs (Twitch: `id` AND
`login` together is valid — up to 100 of each) make them *combinable*. The
`default`-ban on members is still correct (a default would fire alongside a
supplied sibling), but "mutually exclusive" is the wrong model and could
mislead the future multi-group design (e.g., wrongly auto-deriving
exactly-one semantics, which WOULD be a re-meaning).

**CONFIDENCE: high** on the mechanics (read directly from
`api-guide-types.ts`/`parse-api-guide.ts`/`helpers.ts`); **medium-low** that a
real two-group op will ever be demanded (no target API found needing it).

---

### 3. `dateParams` missing epoch and `yyyy/mm/dd` formats (ADDITIVE-FIX)

**PATTERN.** StackExchange dates are **unix epoch seconds**: `sort=votes&min=10&fromdate=1293840000`
([/docs/dates](https://api.stackexchange.com/docs/dates): "All dates in the API
are in unix epoch time"). PubMed E-utilities `mindate`/`maxdate` accept
`YYYY/MM/DD` (and bare `YYYY`) — a format outside the three enum values,
verified live: `esearch.fcgi?...&mindate=2024/01/01` accepted with
`yyyy/mm/dd` semantics (fetched above; format documented in the
[E-utilities reference](https://eutilities.github.io/site/Reference_Guide/a_reference/)).

**GAP.** `DateParamFormat = "iso8601" | "yyyymmdd" | "yyyy-mm-dd"` and
`normalizeDateParam`'s regex only matches `\d{4}-?\d{1,2}-?\d{1,2}` — an epoch
integer passes through unchanged only by accident of the regex failing.

**CLASSIFICATION: ADDITIVE-FIX, low** — the agent can always pre-format the
string (undeclared params pass through raw), so this is a convenience enum
extension: add `"epoch"`, `"epoch-millis"`, `"yyyy/mm/dd"`. New enum value =
non-event per the bump rule. Cheap enough to do with finding 1's serializer
work; not urgent alone.

---

### 4. `{token}` path templating vs real URL grammar — scales (EXPRESSIBLE-TODAY)

**PATTERN / probing results.**
- **Composite IDs with slashes** (GitLab project `namespace%2Fproject`, npm scoped packages): `fillPathTemplate` uses `encodeURIComponent`, which encodes `/` → `%2F` — exactly what GitLab requires. Correct today.
- **Comma lists in paths** (Elasticsearch `/_nodes/{node_id}` accepting `a,b`): comma → `%2C`, which every mainstream server decodes before routing. Harmless.
- **Token name charset**: `extractPathTokens` uses `\{(\w+)\}` — token names are author-chosen, so `\w+` suffices; RFC 6570 modifiers (`{+var}`, `{var:3}`) and literal braces in paths are unsupported but I found no target read-API needing them.
- **Optional path segments / variable depth** (e.g. `/a/{b}` vs `/a/{b}/{c}`): declare two ops — multi-op is supported. **Variable path depth without op duplication would be a future reshape of `pathParams: string[]` → object list, but I found no real must-have case**; the additive escape (`optionalPathParams?: string[]`) exists if it ever does.

**CLASSIFICATION: EXPRESSIBLE-TODAY.** No action. One caveat worth a guide-doc
note: `%2F` is rejected by some reverse proxies (nginx default), so authors of
guides for such APIs must use explicit two-token paths rather than one
slash-bearing arg — a doc note, not a schema change.

**CONFIDENCE: high** — verified against GitLab convention, encodeURIComponent
semantics in `core/path-template.ts`.

---

### 5. Per-op version prefixes / regional hosts (EXPRESSIBLE-TODAY for versions; ADDITIVE-FIX for hosts)

**PATTERN.** EIA serves v1 and v2 routes off the same host
(`api.eia.gov/v2/...`, legacy `/series/` —
[eia.gov/opendata/documentation.php](https://www.eia.gov/opendata/documentation.php),
"Supporting multiple versions of our API"); Microsoft Graph v1.0 vs beta.

**GAP.** `apiHost` is guide-level ("Execution root … version prefix lives
here"). But an op `path` is any string starting with `/`, so mixed-version
guides put the prefix in each op's `path` (`/v2/electricity/...`) —
expressible today. A per-op **hostname** override (regional S3-style hosts) is
not expressible.

**CLASSIFICATION: EXPRESSIBLE-TODAY (versions via op path); ADDITIVE-FIX,
low** for `host?: string` on `Operation` if a regional-host recipe ever lands.
Note: multi-recipe domains (two guides claiming one domain) already cover the
clean split.

---

### 6. Header-driven pagination metadata invisible through `paginate` (ADDITIVE-FIX; cross-axis note)

**PATTERN.** EIA reports the responsive-row total **in the response header**
("the API will identify the total number of rows … in the response header",
eia.gov docs, fetched); GitHub Link-header pagination; Zotero `Total-Results`.

**GAP.** `PaginationConfig.totalCountPath` is body-only JSON path;
`PaginateResult` exposes no headers at all (only `restGet`'s `RestGetResult`
does). A guide paginating a header-total API cannot surface `serverTotal`, and
a Link-header pagination style has no enum value (`nextLink` reads a body path
only).

**CLASSIFICATION: ADDITIVE-FIX** (`totalCountHeader?: string`, `nextLinkHeader`
enum value, plus code to expose headers on PaginateResult — no existing field
re-meaned). Owner is the pagination axis; noted here because it surfaced while
probing Link/RateLimit header access, which `restGet` already returns.

---

### 7. All-or-none / conditional param dependencies (ADDITIVE-FIX, watch item)

**PATTERN.** PubMed E-utilities: "These two parameters (mindate, maxdate) must
be used together to specify a date range" ([E-utilities
reference](https://eutilities.github.io/site/Reference_Guide/a_reference/), via
eutilities docs). StackExchange: `min`/`max` semantics depend on `sort`
([/docs/questions](https://api.stackexchange.com/docs/questions)).

**GAP.** No schema surface: `requiresAnyOf` is at-least-one-of; there is no
`requiresAllOf` (all-or-none) and no per-param "requires sibling" edge. The
agent handles it behaviorally (both params are optional, agent sends both).

**CLASSIFICATION: ADDITIVE-FIX, low** — `requiresAllOf?: string[]` later is
purely additive (mirror of the requiresAnyOf parser checks). No re-meaning
forced. Do not add speculatively.

---

### Expressible-today (not findings) — checked and cleared

- **Param aliases** (API accepts old+new names): declare both in `params`. Trivial.
- **Comma/semicolon list styles** (GitHub labels, SE `tagged`, Bugzilla `id`, arXiv `id_list`): agent pre-joins a string; works today (see finding 1 for the array footgun).
- **Bracket param NAMES** (`facets[stateid][]` as a literal YAML key with a single value): legal today — keys are free-form strings, `URLSearchParams` percent-encodes brackets, and servers decode them. Only *multi-value* bracket keys are blocked (finding 1). EIA's own indexed form `data[0]=price&data[1]=revenue` is fully expressible per key.
- **Accept negotiation**: `accept` is a free-form media-type string; combined `Accept` values pass through `expandAccept` unchanged.
- **Composite `{org}/{repo}` as one caller arg**: works for APIs wanting `%2F` (GitLab); two tokens otherwise (finding 4).
- **Boolean/number defaults**: `QueryParamSpec.default: unknown` → `String(val)`; fine.
- **`passthrough` + `dateParams`**: passthrough keys honor declared dateParams (verified in `buildQueryParams`).

### OUT-OF-BOUNDS (noted, dropped)

- **Params in HTTP headers on GET** (EIA v2 explicitly supports it): not expressible, but the documented URL form works for every example EIA shows — no recipe need. No schema action.
- **Numeric min/max in-schema validation**: forever behavioral; server validates. Adding `min`/`max` to QueryParamSpec later would be additive but useless — description hints cover it.
- **`+` vs `%20` space encoding**: `buildUrl` uses `URLSearchParams` (space → `+`); every target API probed (PHP/Rack/Python stacks) decodes `+` as space in query strings. No documented read-API breakage found; if one appears, `encoding?: "percent"` on `Query/ParamSpec` is additive. Dropped as hypothetical.

## Direct answers to the flagged questions

1. **Does `{token}` inference scale to real URL grammar?** Yes for everything
   probed: composite slash-IDs (encodeURIComponent is the *correct* behavior
   there), comma path lists, nested resources. The `\w+` token regex only
   constrains author-chosen names. The only latent reshape is optional path
   segments (`pathParams: string[]` → object list); no real case found, and an
   additive `optionalPathParams` escape exists if one appears.
2. **Will the single `requiresAnyOf` group force a rename later?** No —
   *provided* the multi-group upgrade lands as a sibling field
   (`requiresAnyOfGroups`), which the code comment already reserves. The trap
   is a union type on the same key; that decision should be frozen now (one
   doc line), and the "mutually exclusive peers" comment corrected to
   "at-least-one-of, combinable" before it misleads that future change.

## Sources

- Kept: [StackExchange API /questions](https://api.stackexchange.com/docs/questions) — semicolon-delimited `tagged`; epoch date params
- Kept: [StackExchange API /docs/dates](https://api.stackexchange.com/docs/dates) — unix epoch seconds as the canonical date format
- Kept: [EIA API Technical Documentation](https://www.eia.gov/opendata/documentation.php) — repeated-key `data[]=`/`facets[x][]=` params, indexed equivalent `data[0]=`, header-reported totals, v1/v2 on one host, GET-with-headers option
- Kept: [Bugzilla Get Bug](https://bugzilla.readthedocs.io/en/latest/api/core/v1/bug.html) — comma-joined `id=12434,43421`
- Kept: [NCBI E-utilities Reference](https://eutilities.github.io/site/Reference_Guide/a_reference/) — `mindate`/`maxdate` "must be used together"; `yyyy/mm/dd` format (plus live probe of `esearch.fcgi` accepting it)
- Kept: [MediaWiki action=query help](https://www.mediawiki.org/w/api.php?action=help&modules=query) — at-least-one-of title selectors; open param surface
- Kept: [arXiv API User's Manual](https://info.arxiv.org/help/api/user-manual.html) — comma-delimited `id_list`
- Kept (grounding): `core/api-guide-types.ts`, `core/parse-api-guide.ts`, `core/helpers.ts`, `core/resolve-op.ts`, `core/path-template.ts`, `api-guides/twitch/guide.md` in-repo
- Dropped: [OpenAlex filter docs](https://docs.openalex.org/...) — JS-shell page, fetch returned nav only; pattern (comma vs pipe in `filter=`) adds nothing beyond Bugzilla/EIA evidence
- Dropped: GitHub OpenAPI 7MB spec dump — too large to grep via fetch; comma-`labels` pattern already covered by Bugzilla/SE evidence

## Gaps

- **Exactly-one-of semantics**: I found no documented read-API that *errors*
  when both members of an "or" group are supplied; if one exists, a future
  `requiresExactlyOneOf` sibling field is additive. Unresolved, low stakes.
- **A proven repeated-key-ONLY API** (no comma/indexed fallback): every
  documented case I fetched (EIA, Bugzilla, SE) offers an alternative
  serialization. If a repeat-only API is later targeted, finding 1's
  `listStyle` becomes a must-add rather than a convenience.
- **Web-search was mostly unavailable this session** (SearXNG returned empty
  for most queries); evidence was gathered via direct `web-fetch` of primary
  docs, which is arguably better, but coverage of GitHub/Zenodo/Dryad
  specifics is thinner than intended.

## Supervisor coordination

None needed — task completed without blockers; no decisions required.
