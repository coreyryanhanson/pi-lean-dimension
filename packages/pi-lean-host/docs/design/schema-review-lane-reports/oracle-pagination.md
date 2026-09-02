# Research: Adversarial schema review — PAGINATION axis (pi-lean-host PaginationConfig)

Reviewer: pagination-axis subagent. Grounding: `api-guide-types.ts` (PaginationConfig), `parse-api-guide.ts` (validatePagination), `helpers.ts` (paginate/advancePagination/resolveJsonPath), `resolve-op.ts`; guides skimmed: `internet-archive`, `twitch`.

## Summary

The six styles + per-style path fields cover envelopes well (Google `nextPageToken`, MediaWiki `continue`, OAI-PMH, `@odata.nextLink`, offset/page, Socrata). Four real-world patterns are inexpressible today — the worst being **RFC 8288 Link-header pagination (GitHub/GitLab/Shopify)** and **client-derived cursors from the last item (Stripe)** — but per the bump rule (new enum value / new optional field = non-event) all four are **additive**. The one genuine breaking-risk is the *absence of an unknown-key allowlist* on pagination blocks: silent-ignore of typo'd keys can only be fixed later by tightening a parse-enforced constraint (which bumps). Reshape decisions that are free NOW: (a) reject unknown pagination keys, (b) pre-empt the "magic-path overload" (`"header:Link"` inside `nextLinkPath`) by naming header-sourced extraction its own style/fields.

## Findings

### 1. BREAKING-RISK — pagination blocks silently ignore unknown keys (no field allowlist)

1. **PATTERN**: N/A (schema-integrity finding, not an API pattern). The trigger is any real guide authoring session: an author writing `itemPath:` instead of `itemsPath:`, or `cursorPath:` on a `nextLink` op, gets a **parse-OK guide** that silently single-pages at runtime.
2. **GAP**: `validatePagination()` (parse-api-guide.ts) reads known keys and constructs `cfg` without ever comparing `Object.keys(p)` against a per-style allowlist. Auth got this treatment (`AUTH_ALLOWLISTS` + per-kind unknown-key rejection); pagination did not. Confirmed by reading the validator: only known keys are copied; everything else is dropped on the floor.
3. **CLASSIFICATION**: **c. BREAKING-RISK.** Adding the allowlist later is a *parse-behavior tightening*: any guide that happened to carry a stray key (e.g. the removed pre-release `completeListSizePath` — the type file itself documents a field "removed pre-release, not aliased") goes from parse-OK to malformed → per the bump rule ("changing a parse-enforced constraint's meaning") it forces a schemaVersion bump. Today, at schemaVersion 1, it's free.
4. **PROPOSED DELTA**: Mirror `AUTH_ALLOWLISTS`: per-style key sets (`offset-limit`/`page`: style/itemsPath/pageParam/pageSizeParam/pageSize/base; `nextLink`: +nextLinkPath; `cursor`: +cursorParam/cursorPath; `resumptionToken`: +tokenParam/tokenPath; `tokenBag`: +continuationParams; all styles: +totalCountPath) and reject unknown keys with a ParseError like auth does. ~20 lines, mirrors existing auth code (ladder rung 2: reuse the pattern).
5. **CONFIDENCE**: High (code-verified; the `completeListSizePath` removal in the repo's own history shows exactly this drift class). No URL — evidence is `parse-api-guide.ts` vs `AUTH_ALLOWLISTS` in the same file.

### 2. ADDITIVE-FIX (top priority) — next-page URL / cursor / total delivered in a response HEADER (RFC 5988/8288), never the body

1. **PATTERN**: **GitHub REST** — every list endpoint (`/repos/{o}/{r}/issues`, …) returns a bare JSON array with the next page as `Link: <…?page=2>; rel="next"` in the **response headers**; the body never contains a next URL ([GitHub docs](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api): "the response headers will include a link header"). **GitLab** — same `Link` header for offset pagination, `Link` header **is the only** next-page indicator for keyset pagination (`?pagination=keyset&order_by=id&sort=asc` → next link with `id_after=42` in the header, nothing in the body), plus `x-next-page` and `x-total` header-only metadata ([GitLab docs](https://docs.gitlab.com/api/rest/), "Pagination `Link` header" / "Other pagination headers" — verified in fetched doc). **Shopify** Admin REST does cursor pagination via `Link` header only. **Azure Cosmos** puts continuation in `x-ms-continuation` response *and* request headers.
2. **GAP**: Every extraction field — `nextLinkPath`, `cursorPath`, `tokenPath`, `continuationParams`, `totalCountPath` — is resolved through `resolveJsonPath(data, …)` against the **parsed body only**. `paginate()` discards `result.headers` entirely (only `status` and `body` are consumed after `fetchWithOpts`). No style, field, or grammar token can name a header. Inexpressible today, provably.
3. **CLASSIFICATION**: **b. ADDITIVE-FIX** — new enum value + new optional fields is a non-event per the bump rule. **But it is the highest-frequency gap in the entire axis** (GitHub alone justifies it), and the *lazy* future fix is exactly the kind that bumps: overloading `nextLinkPath` with magic values like `"header:Link"` re-means an existing field. Decide the shape now so the eventual fix stays additive.
4. **PROPOSED DELTA** (additive, no bump):
   - `PaginationStyle += "linkHeader"`.
   - `linkRel?: string` (default `"next"`) — parse the `Link` header, select by `rel`, follow the URL through the existing nextLink SSRF-guard path (`guardThisFetch` must key off the new style too — the URL is server-supplied from a header, equally attacker-controllable).
   - If totals-in-header is wanted later: `totalCountHeader?: string` (GitLab `x-total`), additive.
5. **CONFIDENCE**: High. GitHub: <https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>; GitLab: <https://docs.gitlab.com/api/rest/> (fetched, quoted above).

### 3. ADDITIVE-FIX — cursor derived from the last ITEM, not the envelope (Stripe `has_more` + `starting_after=<last object id>`)

1. **PATTERN**: **Stripe** list endpoints (`/v1/customers`, `/v1/payment_intents`, …) return `{ data: [...], has_more: bool }` and **no cursor field anywhere in the envelope**. The documented manual-pagination loop is: "If the value is `true`, get the ID of the last object returned, and make a new API call with `starting_after` set" ([Stripe: How pagination works](https://docs.stripe.com/pagination), fetched — quoted verbatim). Same family: Discord message pagination (`after=<last message snowflake>`, response contains no cursor), Twitter/X v1.1 `max_id`, SQL keyset/seek pagination with multi-column "last item sort values" continuations.
2. **GAP**: `cursorPath` is a JSON path into the page body — but no path expression in `resolveJsonPath` can select the **last element** of the items array. Grammar is dot-delimited + non-negative numeric index only (`helpers.ts` `resolveJsonPath`: `.replace(/\[(\d+)\]/g, ".$1")`, then `parseInt` lookup). A Stripe guide authoring `cursorPath: "data[-1].id"` parses fine, but at runtime `[-1]` → property `"−1"` lookup → `undefined` → `advancePagination` returns `null` → **pagination silently stops after one page**. There is also no way to stop on `has_more === false` (see finding 4) — Stripe's real exhaustion signal.
3. **CLASSIFICATION**: **b. ADDITIVE-FIX** — two orthogonal additive pieces: (i) extend `resolveJsonPath` to support negative indexes (a relaxation — non-breaking), and (ii) the optional `hasMorePath` field from finding 4, which Stripe genuinely needs (a full page can coexist with `has_more: false`… and more importantly the cursor expression stays resolvable while exhausted, so empty-page/page-short detection alone can't be relied on without it).
4. **PROPOSED DELTA**: `pagination.hasMorePath?: string` (style-agnostic: when present and falsy on a page, stop; when absent, keep the current empty-page/unresolvable-cursor semantics) + negative-index support in `resolveJsonPath` (`data[-1].id`). Stripe guide then: `style: cursor`, `cursorParam: starting_after`, `cursorPath: "data[-1].id"`, `hasMorePath: has_more`.
5. **CONFIDENCE**: High. <https://docs.stripe.com/pagination> (fetched; "get the ID of the last object returned… starting_after").

### 4. ADDITIVE-FIX — exhaustion flagged by a boolean while the cursor/next field is ALWAYS present (Solr cursorMark; `has_more` flags)

1. **PATTERN**: **Apache Solr `cursorMark`** (the engine behind many public search APIs): every response carries `nextCursorMark`, and the documented exhaustion signal is `nextCursorMark === cursorMark you sent` — the field is never absent, so "cursor missing → done" never fires; the naive loop refetches the same page forever ([Solr Ref Guide: Pagination of Results](https://solr.apache.org/guide/solr/latest/query-guide/pagination-of-results.html)). Same shape: any API returning `has_more: false` while still echoing a cursor (GitHub GraphQL's `pageInfo.endCursor` is present even when `hasNextPage` is false — POST-only, so out-of-bounds as a recipe, but proof the pattern exists in the wild).
2. **GAP**: `advancePagination()` defines exhaustion exclusively as "the cursor/next/token field is absent, empty, or unresolvable" (each branch: `if (!next || typeof next !== "string") return null`). There is no stop-condition field, so a repeating cursor loops — bounded only by `gatherAllMax`, having accumulated the same page repeatedly.
3. **CLASSIFICATION**: **b. ADDITIVE-FIX** (`hasMorePath?: string` — see delta in finding 3; the two share one field).
4. **PROPOSED DELTA**: as above; also treat `nextCursor === cursorSent` as exhaustion once the field exists (`stopWhen: "cursorUnchanged"` if you want Solr exactly — but `hasMorePath` covers the common case; ship the smaller one).
5. **CONFIDENCE**: Medium-high. <https://solr.apache.org/guide/solr/latest/query-guide/pagination-of-results.html>.

### 5. ADDITIVE-FIX — deep-paging guardrails make offset gathers abort mid-run

1. **PATTERN**: **GitLab** caps offset pagination ("There is a max offset allowed limit … for offset pagination", [GitLab REST docs](https://docs.gitlab.com/api/rest/); 50k on gitlab.com) and errors once exceeded; **Elasticsearch/OpenSearch**-backed public APIs reject `from + size > 10,000`.
2. **GAP**: `offset-limit` has no `maxOffset`/`maxPages` guard; a `gatherAll` walk past the API's cap turns into an HTTP 4xx that `checkResponseStatus` converts into a thrown `HelperError` — the whole gather aborts (no partial `items` returned) rather than stopping cleanly.
3. **CLASSIFICATION**: **b. ADDITIVE-FIX** — `pagination.maxOffset?: number` (stop when the next offset would exceed it, set `ceilingHit`-style flag). Nothing re-meaned.
4. **PROPOSED DELTA**: as stated. Cheap anytime; not urgent.
5. **CONFIDENCE**: High on the API behavior, low-medium on recipe frequency (only huge collections hit it). <https://docs.gitlab.com/api/rest/> + <https://docs.gitlab.com/administration/instance_limits/#max-offset-allowed-by-the-rest-api-for-offset-based-pagination>.

### 6. EXPRESSIBLE-TODAY (footgun noted) — non-string cursor/next/token values silently read as "last page"

1. **PATTERN**: Any API returning a numeric continuation value in the body (integer `next_cursor`, numeric page token), or an XML element whose parsed form is an object (e.g. OAI-PMH final `<resumptionToken/>` with attributes only).
2. **GAP**: All three value branches in `advancePagination` require `typeof === "string"` and otherwise return `null` — indistinguishable from genuine exhaustion. A numeric cursor yields a silently truncated result reported as a complete list. (`tokenBag` is the odd one out — it coerces `String(v)` — so the codebase already disagrees with itself.)
3. **CLASSIFICATION**: **a. EXPRESSIBLE-TODAY, but a footgun.** Fix is behavior, not schema (coerce numbers to strings like `tokenBag` does; keep `""`/missing as exhaustion). Non-breaking, no schema change — flagging because the failure mode is a *silent, confident wrong answer* ("here are all 10 items"), the worst thing an agent-facing executor can do.
4. **PROPOSED DELTA**: none (helper fix + one `axis-units` test asserting numeric cursors advance).
5. **CONFIDENCE**: High that the code behaves this way; medium that numeric JSON cursors are common enough to hit in practice (most big APIs use string tokens).

### Explicitly verified EXPRESSIBLE-TODAY (no action — the axis asked)

- **Envelope metadata outside `itemsPath`** (`{data, meta: {next_cursor}}`): `cursorPath` is resolved independently of `itemsPath` — expressible (`cursorPath: "meta.next_cursor"`). Stripe-style envelopes covered by finding 3.
- **Conditional/hybrid pagination (GitHub: `Link` header absent on last page; empty array otherwise)**: absent/unresolvable next → `null` → stop. Expressible (modulo finding 2's header gap).
- **OAI-PMH `resumptionToken` as bare XML element / attributes**: expressible — `tokenPath: "resumptionToken.#text"` (fast-xml-parser `#text` resolves through `resolveJsonPath`'s dot-split); final `<resumptionToken/>` → `""` → `typeof "" === "string" && === ""` → stop; `totalCountPath: "resumptionToken.@_completeListSize"` for `completeListSize` (attribute via `@_`, `removeNSPrefix` on).
- **Bare top-level array bodies** (GitHub `/issues` returns a raw array; parser rejects `itemsPath: ""`): expressible via `itemsPath: "$"` (`resolveJsonPath` strips `$` and returns the root). Worth a line in guide-authoring docs since it's non-obvious.
- **Google `nextPageToken`/`pageToken`, MediaWiki `continue` bag, Twitch `pagination.cursor`, `@odata.nextLink` (Microsoft Graph), Spotify `next`, Zenodo `links.next`, Socrata `$offset/$limit`**: all directly expressible with `cursor`/`tokenBag`/`nextLink`/`offset-limit` + `totalCountPath`.

### OUT-OF-BOUNDS (noted, dropped)

- **Mutating/paged-write flows, POST-based pagination (GitHub GraphQL `pageInfo` as a recipe)** — GET-only transport; GitHub GraphQL can't be a recipe regardless.
- **Cookie/jar-based session pagination** — deferred by design per host AGENTS.md.
- **Cursor echo in a request *header*** (Azure Cosmos `x-ms-continuation`) — GET-compatible and would only need an additive `cursorLocation: "query"|"header"` if a real recipe ever demands it; not worth reserving schema for now.

## Sources

- Kept: GitHub Docs — Using pagination in the REST API (https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) — canonical Link-header proof, highest-frequency API on the axis.
- Kept: GitLab Docs — REST API (https://docs.gitlab.com/api/rest/) — fetched; proves Link header + `x-next-page`/`x-total` header-only metadata + keyset next-in-header + max-offset guard.
- Kept: Stripe — How pagination works (https://docs.stripe.com/pagination) — fetched; proves `has_more` + last-object-id cursor (no envelope cursor).
- Kept: Apache Solr Ref Guide — Pagination of Results (https://solr.apache.org/guide/solr/latest/query-guide/pagination-of-results.html) — proves always-present-cursor exhaustion semantics (cursorMark equality).
- Dropped: Microsoft Learn Q&A / n8n community threads on Link-header pagination — commentary duplicating the primary docs.
- Dropped: Twitter/X v1.1 `search_metadata.next_results` pattern — API retired; folded into finding 3's family rather than standing alone.

## Gaps

- Did not find a strong, currently-live GET API returning a numeric JSON cursor (finding 6's frequency claim rests on code reading, not a named endpoint). Suggested next step: none — the fix is cheap regardless.
- Did not verify Shopify's Link-header-only cursor pagination by fetching its docs (cited from common knowledge; GitHub+GitLab already carry the classification, so I didn't spend the fetch). If the additive delta for finding 2 is contested, fetch https://shopify.dev/docs/api/usage/pagination to triple-source it.
- tokenBag continuation where the response key ≠ the request param name (would force `continuationParams: string[]` → map, a breaking reshape): searched for a live example (Asana uses same names; MediaWiki same) and found none — dropped as speculative, flagged here so a future bug report of that shape is recognized as the trigger, same discipline as the reserved `tokenKey` seam.

## Supervisor coordination

No blocking decisions — adversarial review complete; full report above and persisted to `/tmp/oracle-pagination.md`.
