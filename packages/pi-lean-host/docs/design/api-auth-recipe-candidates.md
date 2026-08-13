# pi-lean-host — Auth Recipe Candidates

Candidate data for the authenticated-API slice: which real APIs the recipes
are, where their specs live, and which auth axes they cover. Self-contained —
no planning narrative.

## Axis key

| Axis | Meaning |
|------|---------|
| A1 | Static key via request header (`secretRefs`) — store-injected header, cache-skip |
| A2 | Static key via query param (`secretQueryRefs`) — URL redaction + params-below-map (security-critical) |
| A3 | Authless stateful — server-held result-set state carried as an opaque token across calls |

## Axis coverage

| Axis | Recipe |
|------|--------|
| A1 | CoinGecko, GitHub (keyed variant), GitLab (keyed variant) |
| A2 | Etherscan (V2) |
| A3 | NCBI E-utilities |

## Candidates

### CoinGecko — A1, static-key header

- **Domain:** `api.coingecko.com`
- **Auth:** header `x-cg-demo-api-key` (demo) / `x-cg-pro-api-key` (Pro); a query-param form exists (`x_cg_demo_api_key`) but the guide uses the header so A1 stays distinct from Etherscan's A2
- **Free tier:** demo plan, 100 calls/min, zero cost, email signup
- **Pagination:** offset — `per_page` (default 100, range 1–250) + `page`
- **Format:** JSON
- **Docs:** <https://docs.coingecko.com> (authentication, coins-markets, errors-and-rate-limits)
- **Spec:** <https://docs.coingecko.com/openapi-specs/demo-api.json> (Pro: <https://docs.coingecko.com/openapi-specs/pro-api.json>)
- **Reachability:** keyless probe returned real market data (BTC/ETH) — no WAF

### Etherscan — A2, static-key query param

- **Domain:** `api.etherscan.io` (V2 base path `/v2/api`; V1 deprecated Aug 2025 — guide targets V2)
- **Auth:** query param `apikey=` (OpenAPI securityScheme `apiKey in: query, name: apikey`); V2 also requires `chainid` (e.g. `1`)
- **Free tier:** 3 calls/s, 100k calls/day, email signup, no card
- **Pagination:** offset — `page` + `offset` (default 100) on `txlist`-style endpoints
- **Format:** JSON
- **Docs:** <https://docs.etherscan.io> (getting-started, v2-migration, resources/rate-limits)
- **Spec:** per-endpoint — `https://docs.etherscan.io/openapi/api-reference/endpoint/<slug>.json` (e.g. `balance.json`, `txlist.json`)
- **Reachability:** keyless probe returned HTTP 200 `NOTOK "Missing/Invalid API Key"` — endpoint answers, no WAF
- **Note:** the security-critical axis — forces both output-channel defenses (URL redaction + params-below-map)

### GitHub (keyed variant) — A1, static-key header + optional auth

- **Domain:** `api.github.com`
- **Auth:** `Authorization: Bearer` PAT (classic or fine-grained); `auth.optional` — 60 req/hr unauth, 5000 authed
- **Free tier:** PAT, email signup, no card
- **Pagination:** Link-header (page-based); `X-RateLimit-*` headers
- **Format:** JSON
- **Docs:** <https://docs.github.com/en/rest>
- **Note:** keyed variant of the shipped no-auth guide — adds `secretRefs` + `auth.optional` and re-adds a bounded subset of auth-gated read-only ops (issues, PRs, file contents, CI status)

### GitLab (keyed variant) — A1, static-key header + optional auth

- **Domain:** `gitlab.com`
- **Auth:** `Authorization: Bearer` PAT with `read_api` scope; `auth.optional` — 10 req/min unauth, 60 authed
- **Free tier:** PAT, email signup, no card
- **Pagination:** page — `page` / `per_page`
- **Format:** JSON
- **Docs:** <https://docs.gitlab.com/api/rest/>
- **Note:** keyed variant of the shipped no-auth guide — adds `secretRefs` + `auth.optional` and re-adds a bounded subset of `read_api`-gated read-only ops

### NCBI E-utilities — A3, authless stateful (opaque-token)

- **Domain:** `eutils.ncbi.nlm.nih.gov`
- **Auth:** none required; optional `api_key` raises rate limits
- **Auth model:** opaque-token server-side session — `esearch` with `usehistory=y` returns `WebEnv`/`query_key`, passed back on `esummary`/`efetch`
- **Pagination:** offset-limit — `retstart` / `retmax`
- **Format:** XML
- **Docs:** <https://www.ncbi.nlm.nih.gov/books/NBK25499/>
