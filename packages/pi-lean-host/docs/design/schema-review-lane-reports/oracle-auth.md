# Research: Adversarial schema review — AUTH axis (pi-lean-host AuthConfig v1)

## Summary

The v1 auth union (`NoneAuth | StaticKeyAuth | OAuth2Auth`, self-contained `SecretRef`) is more future-proof than the adversarial checklist assumed: **no real-world pattern I could verify forces a schema reshaping that breaks existing guides** — the v1 union refactor already paid that cost, and every gap I found has an additive fix under the bump rule. The two items that deserve action NOW are (1) `secretPathRefs` — token-in-path APIs (Telegram) are provably inexpressible without it, and the only today-workaround violates the "secret never enters agent context" invariant; and (2) a reserved-seam note for request-derived credentials (HMAC/SigV4 signed GETs), which are provably inexpressible and whose eventual fix collides with the resolve-op auth-before-URL sequencing. Basic-auth join/base64 schemes, per-op auth granularity, and the missing OAuth2 grants (device_code, ROPC, private_key_jwt) are all expressible-today-with-footguns or cheap additive fixes.

## Findings

Ranked by urgency; classifications per the four-way rubric. Honest headline: **zero confirmed (c) BREAKING-RISK findings** — each candidate below was stress-tested against the bump rule and survives as additive. The schema should still absorb two cheap-now additives (F1, F2) while breaking fixes are free.

### 1. Token-in-path APIs — provably inexpressible; the only workaround violates the secret-never-enters-context invariant — CLASSIFICATION: (a) footgun + cheap (b) additive NOW

1. **PATTERN** — Telegram Bot API: *every* method is keyed through the URL path: `https://api.telegram.org/bot<token>/METHOD_NAME` (e.g. `getUpdates`, `getMe` are read-only GETs). Same class: many keyed-URL services where the credential is a path segment, not a header or query param. [Telegram Bot API — Making requests](https://core.telegram.org/bots/api)
2. **GAP** — `StaticKeyAuth` (`api-guide-types.ts`) offers exactly two injection surfaces: `secretRefs` (headers) and `secretQueryRefs` (query params). There is no `secretPathRefs`. `Operation.path` tokens are *inferred agent params*: `extractPathTokens(path)` → `pathParams`, filled by `fillPathStrict(operation.path, params)` from **caller-supplied** params, and `secretQueryParamNames`-style redaction only covers query params (`redactSecretParams`), never path segments. So the only way to write a Telegram guide today is `path: /bot{token}/getUpdates` with the caller passing the token as a plain param — the secret enters agent context and the transcript, and the output-channel audit (`secretValues` scrub) never sees it because it only tracks store-injected values. The schema actively invites the exact leak the design forbids.
3. **CLASSIFICATION** — (a) EXPRESSIBLE-TODAY but a genuine footgun (invariant violation, unredacted URLs), which per the brief counts as a finding; the fix is cheaply (b) additive.
4. **PROPOSED DELTA** — mirror `secretQueryRefs` one-for-one:
   - TS: `StaticKeyAuth.secretPathRefs?: Record<string, SecretRef>`
   - Parser: validate like `secretQueryRefs`, plus a symmetric collision rule — a path token named in `secretPathRefs` must NOT be caller-suppliable (reject if the same token would otherwise resolve from agent params; `fillPathStrict` fills it from the store instead). Parser-enforced, fail-closed, same shape as the existing query-collision guard in `validateOperation`.
   - Executor: fill secret-owned path tokens from the store before `fillPathStrict`; add the resolved values to `secretValues` so error bodies scrub them.
   Cost: ~one afternoon, zero existing-guide breakage (new optional field). Doing it later is *technically* additive, but every guide written before then either can't exist or leaks tokens — that asymmetry is why this is the top action item.
5. **CONFIDENCE** — High. Telegram is one of the highest-traffic bot APIs on earth and the pattern is in its first paragraph of "Making requests". URL: https://core.telegram.org/bots/api

### 2. Request-derived credentials (HMAC signatures, SigV4) — provably inexpressible; the fix collides with the resolve-op ordering — CLASSIFICATION: (b) ADDITIVE-FIX, highest-priority additive after F1, with a reserved-seam note to write NOW

1. **PATTERN** — Binance Spot REST: SIGNED endpoints (marked USER_DATA, all read-only ones included, e.g. `GET /api/v3/account`, `GET /api/v3/allOrders`) require `timestamp` and `signature` as **query params**, where `signature = HMAC-SHA256(secretKey, totalParams)` over the full query string (HMAC, RSA, and Ed25519 key types are all documented). AWS S3 under SigV4 signs even plain read-only GETs: the `Authorization` header is a *derived composite* (`Credential=…,SignedHeaders=…,Signature=…`) plus `X-Amz-Date` / `X-Amz-Content-Sha256`. [Binance REST API — SIGNED endpoints / HMAC keys](https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/rest-api.md), [AWS S3 — SigV4 header-based auth](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)
2. **GAP** — `SecretRef` resolution is verbatim-plus-prefix only: `resolveSecretHeaders` computes `(ref.prefix ?? "") + value` (`auth.ts`) from the store; nothing in `StaticKeyAuth`/`OAuth2Auth` can produce a value *computed from* a secret plus request context (URL, method, timestamp). Pre-encoding fails by construction — a signature depends on the request. The sanctioned escape valve can't save this either: `op.helper: true` (local helpers, `callHelper` in resolve-op step 1) receives **params only**, never secrets — by design — so the helper cannot sign. Digest auth (RFC 7616) is the same class one level harder: challenge-response over a 401 nonce, impossible in a stateless single-GET pipeline.
3. **CLASSIFICATION** — (b) additive, but with a load-bearing *architectural* (not schema) break: `resolveOpForExecution` resolves auth (step 3) **before** the executor constructs the URL, and `SecretResolution` carries no request context — every signature scheme needs the opposite order (URL first, then auth, or a signing hook inside the executor). Schema-wise a new auth kind (`KNOWN_AUTH_KINDS` is an open set; new enum values are non-events) plus possibly optional `SecretRef` derivation fields — none of it breaks existing-guide parse. Not (c) by the letter of the bump rule; flagged here because it is the *only* auth class that is provably impossible today, and because the ordering seam should be documented now (the `tokenKey` reserved-seam precedent).
4. **PROPOSED DELTA (documentation only — no schema change yet)** — add a reserved-seam paragraph next to the `tokenKey` one: "Request-derived credentials (HMAC/SigV4/digest) will land as a new auth `kind` (or a `derive`-family field on `SecretRef`) and will require auth resolution to see method+final-URL; `resolve-op.ts` step 3 must not assume auth is URL-independent. Declared now so the sequencing is never further entrenched." Do **not** add the kind in v1 — zero bundled recipes need it, and SigV4's canonical-request machinery is far too heavy to spec blind.
5. **CONFIDENCE** — High on impossibility (schema + code proof above) and on the pattern being real (Binance/AWS docs). Medium on "real recipes will hit it soon": these are crypto/trading/AWS APIs — plausible caritas territory, not the current doc-data corpus. That's why the delta is a note, not a kind.

### 3. Basic auth / two-credential joined headers — EXPRESSIBLE-TODAY (footgun); SecretRef survives — CLASSIFICATION: (a) footgun, low priority

1. **PATTERN** — Jira Cloud REST: `Authorization: Basic base64("useremail:api_token")` (two credentials, joined, then base64) [Jira Basic auth](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/). Azure DevOps REST: `Basic` with base64 of `":" + PAT` — empty username, documented as `curl -u :<token>` [Azure DevOps PATs](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops&tabs=Windows). Historically also Brandfetch's `Bearer <client-id>:<client-secret>` — note their current docs now ship a single Bearer API key [Brand API](https://docs.brandfetch.com/brand-api/overview), so the colon-join form is not load-bearing evidence.
2. **GAP** — `secretRefs` maps one header name → one `SecretRef` whose value is `prefix + <one store value verbatim>`. Nothing expresses "join two secrets" or "base64-encode".
3. **CLASSIFICATION** — (a) EXPRESSIBLE-TODAY, not a schema gap: the secrets store is an opaque per-name string, so the user provisions the **pre-encoded composite** (`base64(email:token)` or `base64(":"+PAT)`) as a single store entry and the guide declares `Authorization: { secret: basic_credential, prefix: "Basic " }`. The output-channel audit still works (the stored base64 string is what gets scrubbed). Footgun is provisioning friction only — the guide can (and should) document the encoding in prose, and `/api secrets` assisted-entry prompts on the declared name. Special-attention verdict: **`SecretRef { secret, prefix }` survives every verbatim header scheme**; it only fails for per-request derivation, which is F2. If the friction ever measurably hurts, the fix is an additive `derive?: "base64"` field on `SecretRef` — non-breaking under the bump rule. Don't add it now.
4. **CONFIDENCE** — High that it's expressible; Medium that the footgun matters (one-time encode per provisioning).

### 4. Per-op auth differences within one domain — guide-level grain is the WRONG question to relitigate; escape valves already exist — CLASSIFICATION: (a) expressible-today, no action in v1

1. **PATTERN** — APIs whose endpoints split between public (key-optional) and keyed/user-data within one domain: Google Calendar (`?key=API_KEY` works for public data; user calendars need OAuth) [Google OAuth 2.0 / API keys](https://developers.google.com/identity/protocols/oauth2), GitHub REST (anonymous reads exist; token raises rate limits and unlocks some endpoints) [GitHub REST auth](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api?apiVersion=2022-11-28).
2. **GAP** — `auth` lives only on `ApiGuide` (`api-guide-types.ts: auth: AuthConfig`); `Operation` has no auth field. All required refs fail closed for *every* op; `optional: true` degrades *every* op to unauthenticated when unprovisioned.
3. **CLASSIFICATION** — (a) EXPRESSIBLE-TODAY via two sanctioned mechanisms: (i) **multi-recipe domains** — sibling guides on one `domains:` entry, each with its own `auth` (the v1-sanctioned answer, with `api-guide` disambiguation built in); (ii) `optional: true` refs + the `authStatusLine` "optional-not-provisioned" footer, which is exactly the "public tier + keyed tier" shape. The keyed-op 401 then reads as a plan/limitation hint via `status-hint.ts`, not a recipe bug. Answering the special-attention question directly: **guide-level auth is not the wrong grain for v1** — per-op auth (`Operation.auth?: AuthConfig`) is the natural fix and is purely additive when a real guide demands it; adding it speculatively now would be YAGNI.
4. **CONFIDENCE** — High (pattern common; both escape valves verified in code: `buildDomainMap` multi-valued, `optional` semantics in `resolveSecretHeaders`).

### 5. OAuth2 grant coverage: device_code, ROPC, JWT client assertions — all additive enum/field work — CLASSIFICATION: (b) ADDITIVE-FIX, low priority

1. **PATTERN** — (i) Device authorization grant: Google TV/limited-input devices mint tokens with `grant_type=urn:ietf:params:oauth:grant-type:device_code` [Google limited-input-device](https://developers.google.com/identity/protocols/oauth2/limited-input-device); (ii) ROPC (password grant, RFC 6749 §4.3) — already anticipated by the reserved `tokenKey` seam (ROPC `/api login` named as the likeliest consumer); (iii) `client_secret_jwt` / `private_key_jwt` client assertions (RFC 7523) — used by Salesforce/Okta-class providers at the token endpoint.
2. **GAP** — `OAUTH2_GRANTS` is closed at `client_credentials | authorization_code`; `OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS` closed at the three RFC 6749 methods; JWT assertions additionally need derived-credential machinery (F2's class).
3. **CLASSIFICATION** — (b) additive, each. New enum values are explicitly non-events under the bump rule; `oauth2GrantIssue`/`validateOAuth2Auth` extension points are single-statement seams. One sub-gap worth recording: `paramStyle: query` hardcodes the param name `access_token` (`toAccessTokenResult` in auth.ts) — RFC 6750 §2.3-compliant, but a provider demanding a different query name would need an additive `paramName?: string`. No v1 action.
4. **CONFIDENCE** — High on the patterns; the judgment call (defer) follows from zero current recipes needing them.

### 6. Refresh-token rotation / per-token refresh URL — VERIFIED NOT A GAP (runtime, not schema)

Checked as instructed: X/OAuth2-style rotation is handled — `refreshAccessToken` carries the old refresh token forward when the response omits it (RFC 6749 §6, GitHub/OSM behavior) and writes back whatever the provider returns, including a rotated token; the per-slot `withSlotLock` prevents a concurrent double-spend of a rotated refresh token ([X OAuth2 auth-code + refresh docs](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)). A per-token `refresh_url` (refresh at a different endpoint than mint) is an additive optional field on the token-store record, not on `AuthConfig` — schema untouched. No action.

### 7. Cookie-session auth — CLASSIFICATION: (d) OUT-OF-BOUNDS — noted and dropped

`AGENTS.md` defers cookie-login (jar + `api-login`) **in full**, and it's not a `AuthConfig` shape question. No finding.

## Direct answers to the two special-attention questions

1. **Per-op auth overrides — is guide-level the wrong grain?** No, for v1. Every verified mixed-auth domain (Google, GitHub) is served by multi-recipe sibling guides or `optional` refs; `Operation.auth?` added later is a pure additive (new optional field on `Operation`), so deferring costs nothing schema-wise. The only grain error to avoid: don't re-purpose `auth` into a map-of-profiles (`auths: {name: ...}`) if per-op auth ever lands — that *would* be the breaking rewrite. Reserve nothing in the type, but keep the field name `auth` singular-and-overridable in mind.
2. **Does `SecretRef { secret, prefix }` survive real header schemes?** Yes for every verbatim scheme verified (Bearer, Basic-with-pre-encoded-value, `Client-Id` merges, query params, even AWS-style multi-component headers via pre-composed store values). It fails only for per-request derivation (HMAC/JWT/digest) — a different failure class (request-context-dependent), best served by a new auth kind, not by re-shaping `SecretRef`. Do **not** re-open SecretRef now.

## Sources

- Kept: Telegram Bot API (https://core.telegram.org/bots/api) — canonical token-in-path pattern, read-only GET methods.
- Kept: Binance Spot REST API spec (https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/rest-api.md) — SIGNED GET endpoints, HMAC/RSA/Ed25519 signature as query param.
- Kept: AWS S3 SigV4 header auth (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html) — derived Authorization header on read-only GETs.
- Kept: Jira Cloud Basic auth (https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/) — base64(email:token) join scheme.
- Kept: Azure DevOps PAT auth (https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops&tabs=Windows) — Basic base64(":"+PAT), `curl -u :<token>`.
- Kept: Google limited-input-device OAuth2 (https://developers.google.com/identity/protocols/oauth2/limited-input-device) — device_code grant.
- Kept: X OAuth2 auth-code + refresh (https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) — refresh token semantics.
- Kept: Brandfetch Brand API (https://docs.brandfetch.com/brand-api/overview) — read to check the two-credential header; current docs use a single Bearer key.
- Kept: repo ground truth — `api-guide-types.ts`, `parse-api-guide.ts`, `helpers.ts`, `resolve-op.ts`, `auth.ts`, `api-guides/twitch/guide.md`.
- Dropped: Brandfetch "Bearer client_id:client_secret" colon-join claim — superseded on the current docs page (single API key); not load-bearing.
- Dropped: RFC-only citations for ROPC/private_key_jwt beyond standard (RFC 6749 §4.3, RFC 7523) — pattern is standard-track, no unique endpoint doc needed.
- Dropped: digest-auth real-API hunting — challenge-response is the same impossibility class as F2; no public read API doc rose to primary-source quality.

## Gaps

- No live-API calls were made against signed endpoints (docs-only evidence for F2's patterns); a live HMAC recipe probe would confirm the fix shape but can't change the classification.
- Digest auth (RFC 7616): provably inexpressible (challenge-response), but I found no prominent public read-only API whose primary doc mandates it — kept as one line inside F2 rather than a standalone finding. If a real provider surfaces, it rides the same future `kind`.
- Brandfetch-style "two credentials in one header with distinct prefixes" was only provable via the now-stale colon-join; if a current provider with that scheme matters, verify its current docs before citing.

## Supervisor coordination

No decision needed — findings are complete and self-contained; no schema edits were made (review-only task).
