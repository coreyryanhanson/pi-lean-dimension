# Research: Multi-value list delimiters (Q3) & dates-in-URL-path (Q4) — pi-lean-host schema re-review

## Summary
**Q3 — CONFIRMED (StackExchange only, for semicolon).** StackExchange's `tagged` is documented semicolon-delimited, and a live test shows comma does **not** work as a fallback (`tagged=java,python` → 0 results). However, the wider survey found the bigger non-comma delimiter is **pipe (`|`)** — MediaWiki's Action API is pipe-exclusive with no comma fallback and is far more prominent than any second semicolon API. No second prominent semicolon API was found. **Q4 — CONFIRMED.** At least two prominent read-only GET APIs put raw dates in URL path segments (Polygon.io aggregates `{from}`/`{to}`, Frankfurter v1 `/{date}`), with no query-param escape hatch on those endpoints — the "declared-but-dead `dateParams` on a path token" footgun is real.

## Q3 — Semicolon-joined multi-value lists beyond StackExchange?

**VERDICT: CONFIRMED for StackExchange as the sole semicolon case; INCONCLUSIVE→"none found" for a second semicolon API.** Note: the survey surfaced **pipe** as a second, more prominent delimiter family the enum also lacks.

1. **StackExchange `tagged` is semicolon-delimited, comma does not fall back.** Official docs: "use the `tagged` parameter with a semi-colon delimited list of tags. This is an **and** constraint, passing `tagged=c;java` will return only those questions with both tags." ([api.stackexchange.com/docs/questions](https://api.stackexchange.com/docs/questions)) Live check: `GET /2.3/questions?tagged=java,python` returned `{"total":0}` (comma not accepted as separator; semicolon equivalents work), i.e. **no comma fallback**. The same semicolon convention applies across other array params (`nottaged`, etc. — "a semicolon delimited list of tags" on /search/advanced). ([api.stackexchange.com/docs/advanced-search](https://api.stackexchange.com/docs/advanced-search))
2. **No second prominent semicolon-joined read-only API found.** General searches for semicolon-delimited list params returned only StackOverflow discussion threads and generic OpenAPI serialization docs (Swagger's `style: matrix/semicolon` is a *spec* convention, not a live provider requirement); nothing matched a prominent real API. OpenAPI's pipe-style `explode:false` serialization exists as a spec concept but prominent public APIs were the evidence sought.
3. **Pipe-delimited lists are a bigger real-world case: MediaWiki Action API.** The auto-generated parameter help states "Values (separate with | or alternative): …" for list params (e.g. `siprop=general|namespaces|…`), with the example request `api.php?action=query&meta=siteinfo&siprop=general|namespaces|namespacealiases|statistics` — pipe is the separator; comma is not offered. ([en.wikipedia.org/w/api.php?action=help&modules=query+siteinfo](https://en.wikipedia.org/w/api.php?action=help&modules=query%2Bsiteinfo)) This is one of the most widely consumed read-only GET APIs in existence (Wikipedia/Wikidata — the repo already carries a `wikidata-search` fixture).

**Schema implication:** A `listStyle: "semicolon"` one-liner stays justified by exactly one prominent API (StackExchange) — keep P2/tracked-note priority — but the evidence adds a stronger adjacent case for a `listStyle: "pipe"` value (MediaWiki), which should be weighed together if the closed-schema pass touches the list-style enum.

## Q4 — Dates in URL path segments on prominent read-only GET APIs?

**VERDICT: CONFIRMED (2 primary-source examples; the ≥2 bar is met).**

1. **Polygon.io (now Massive) Aggregates — ISO dates as path tokens, no query alternative.** Official endpoint: `GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}` with path params "`from` — The start of the aggregate time window. Either a date with the format YYYY-MM-DD or a millisecond timestamp" (same for `to`). Dates exist **only** as path segments on this endpoint — no query-param date alternative. ([polygon.io/docs/stocks/.../custom-bars](https://polygon.io/docs/stocks/get_v2_aggs_ticker__stocksticker__range__multiplier___timespan___from___to)) A recipe author writing `{from}`/`{to}` path tokens would naturally declare `dateParams` — and it would be silently dead today.
2. **Frankfurter v1 — date and date-range as path segments.** Official v1 docs: `curl https://api.frankfurter.dev/v1/1999-01-04` (historical rates), `curl https://api.frankfurter.dev/v1/2000-01-01..2000-12-31` (time series), `curl https://api.frankfurter.dev/v1/2024-01-01..` (open-ended). No query-param date escape hatch in v1. ([frankfurter.dev/v1](https://frankfurter.dev/v1/)) Nuance: the successor v2 API moved dates to query params (`?date=1999-01-04`, `?from=`) ([frankfurter.dev](https://frankfurter.dev/)) — evidence both that date-in-path is a real authoring pattern *and* that it's a design APIs migrate away from.
3. **Not confirmed (skipped/inconclusive):** NYT Archive API (`/svc/archive/v1/{year}/{month}.json`) — docs portal requires sign-in / reCAPTCHA; couldn't verify from a primary source (route shape is widely cited but unverified here). NWS, OpenSky, NOAA NDBC, SEC EDGAR hints from the brief were not checked (budget); Frankfurter v2 and Polygon's other endpoints already satisfy the evidence bar.

**Schema implication:** With two primary-confirmed date-in-path read-only APIs (both ISO `YYYY-MM-DD`, the exact format `dateParams: iso8601` targets), a recipe author plausibly reaching for `dateParams` on a path token is a real scenario — rejecting declared-but-dead path-token date entries now (while the schema window is free) beats documenting the footgun after publish.

## Sources
- Kept: StackExchange /questions docs (https://api.stackexchange.com/docs/questions) — primary, exact wording on semicolon delimiter + AND semantics; also /search/advanced (https://api.stackexchange.com/docs/advanced-search)
- Kept: Live SE API call (`tagged=java,python` → `{"total":0}`) — direct evidence comma is not a fallback
- Kept: MediaWiki action API help, query+siteinfo (https://en.wikipedia.org/w/api.php?action=help&modules=query%2Bsiteinfo) — primary, pipe-separated multi-value with worked example
- Kept: Polygon/Massive Custom Bars docs (https://polygon.io/docs/stocks/get_v2_aggs_ticker__stocksticker__range__multiplier___timespan___from___to) — primary, YYYY-MM-DD path params verbatim
- Kept: Frankfurter v1 docs (https://frankfurter.dev/v1/) and v2 docs (https://frankfurter.dev/) — primary, path-date v1 vs query-date v2 contrast
- Dropped: Meta StackExchange/StackOverflow threads on `tagged` — commentary; superseded by live API test + official docs
- Dropped: Swagger serialization docs, dev.to OpenAPI tips — spec conventions, not live-provider evidence
- Dropped: educative.io / osu.edu Polygon blog posts — secondary; the official docs page was fetched directly

## Gaps
- No second semicolon-delimited API found; cannot rule out that one exists in a niche domain (verdict: "StackExchange only" stands).
- NYT Archive `{year}/{month}` path dates left INCONCLUSIVE (auth-walled docs portal); if desired, verify via a signed session or the API's well-known URL directly.
- Hinted APIs (NWS products, OpenSky historical, NOAA NDBC, Alpha Vantage) were not checked — budget stopped after the two confirmations; Sportradar's `{year}-{month}-{day}` schedule paths are a plausible third candidate to verify later.

## Supervisor coordination
No decision needed; no blockers encountered. Returning the completed brief.
