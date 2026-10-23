# Bluesky (AT Protocol) — OAuth2 Follow-up

> Earmarked during the pre-implementation OAuth2 research. Bluesky was
> evaluated as an authorization_code + PKCE candidate and **deliberately not
> selected** — it fits the "open source / community / not a soulless corp"
> vibe but not the standard-OAuth2 mechanics the flow builds. This note
> preserves the research so the decision doesn't have to be re-derived.

## Why it's attractive

- Genuinely open source (AT Protocol), community-driven, federated — anyone
  can run a PDS (personal data server).
- Rich public read-only surface (feeds, profiles, posts) that suits an
  agent-driven read-only client.
- The "right" long-term direction for the suite's ethos.

## Why it does NOT fit the shipped flow's shape

Bluesky's OAuth2 is a specialized **OAuth 2.1-style profile**, not plain
RFC 6749. The shipped flow builds a standard authorize URL
(`response_type=code&client_id=…&code_challenge=…&state=…&redirect_uri=…`)
plus a paste-based flow. Bluesky requires three deviations that are
explicitly out of scope for the "standard OAuth2" shape:

1. **DPoP (Demonstrating Proof-of-Possession)** — tokens are bound to a
   client keypair; every request must carry a `DPoP` header signed by that
   key. No plain `Authorization: Bearer <token>`.
2. **PAR (Pushed Authorization Requests)** — the authorization request is
   POSTed to the server *before* the user is redirected, returning a
   `request_uri` to use in the authorize URL.
3. **Hosted client-metadata document** — `client_id` is a URL pointing at a
   JSON client-metadata document (redirect URIs, scopes incl. the required
   `atproto`, `dpop_bound_access_tokens: true`). The metadata does not carry
   a DPoP key — the keypair is client-generated and proven per-request, never
   published for public clients.

Additionally the token endpoint uses DPoP-bound tokens with rotating refresh
tokens — the token store's `OAuthToken` shape (`accessToken`, `refreshToken?`,
`expiresAt?`, `scope?` — every record stamped with its `grant` + `tokenUrl`)
would need a DPoP keypair persisted alongside. That's an additive optional
field on the stamped record, exactly how `scope` was added — not a shape
break — but the keypair must survive the store swap a future keychain backend
would bring.

## The pragmatic alternative (not OAuth2)

Bluesky's common read-only path is **app passwords** — a per-account
credential POSTed to `com.atproto.server.createSession`, which returns a
plain session JWT (`Authorization: Bearer`; short-lived `accessJwt` +
rotating `refreshJwt`) with no DPoP, PAR, or client metadata. XRPC never
accepts the app password itself as a request credential, so this does NOT
land under the existing `auth.kind: static-key` machinery as-is (static-key
only injects stored values as headers/query — no mint step). The cheap path
is a `createSession` mint arm through the existing `oauthPost` + token-store
plumbing (analogous to `client_credentials`) — core code, no schema change.
Bluesky's own docs explicitly sanction this route: "Single-purpose
applications such as bots or command-line tools may use app password
authentication instead", and no deprecation timeline is announced. Not part
of this follow-up.

## What a future implementation would need (the additive seam)

- A DPoP keypair per domain (persist as extra fields on the stamped
  `OAuthToken` record — validated through by the store's entry check, and
  per-client-per-domain rather than per-slot, so the `tokenKey` reserved seam
  is unaffected).
- A PAR pre-POST before building the authorize URL (DPoP is initiated via
  the `DPoP` header on the PAR POST itself, per the live spec — the older
  `dpop_jkt` parameter appears only in the design proposal).
- A client-metadata document (hosted or `did:web`-resolved; pi would be a
  public client — no server-side signing key required — and the
  `http://127.0.0.1/callback` paste convention aligns with atproto's
  loopback-redirect rules).
- **Transport-level** DPoP signing on every authenticated call — NOT a
  change to the injection paths. Three reasons the hook must live at/below
  `fetchUrl`'s per-hop layer:
  1. **`htu` is the final per-hop URL.** Auth-bearing requests force guarded
     redirects (`hasAuth` → `getWithGuardedRedirects`); a proof signed at
     `toAccessTokenResult` time (static header/query maps in
     `AccessTokenResult`) can't produce a valid `htu` across a redirect hop.
  2. **Mandatory `DPoP-Nonce` cache + retry.** Server-issued nonces rotate
     (≤5-min lifetime); clients must cache per-server nonces, retry on
     `use_dpop_nonce` 400s, and reject responses missing `DPoP-Nonce` —
     needs response-header read + a retry, which `transport.ts`'s
     429-only retry loop doesn't have.
  3. **Token-endpoint calls too.** Mint/refresh/revoke (`oauthPost` in
     `core/auth.ts`) must each carry DPoP proofs, not just resource calls.
  Freshness is not the blocker — `resolveAccessToken` already runs per fetch
  (`core/resolve-op.ts`); the gap is that `AccessTokenResult` carries only
  static header/query values and never sees the request's `htm`/`htu`, which
  DPoP's JWS claims require. (Note: the probe path (`api-probe` inline auth)
  injects bearer-header only — `paramStyle: query` is guide-backed
  `api-fetch`/`/api verify` for now.)
- A `validateOAuth2Auth` parse error for `dpop` + `paramStyle: "query"`
  (RFC 9449 forbids URI-query transport of DPoP-bound tokens) — one line,
  zero schema bump, written when DPoP lands.
- Known residual risk (spec-sanctioned rotation vs. file-backed store): a
  crash between the server accepting a refresh and the local `writeToken`
  trips atproto's refresh-token reuse detection, which revokes the whole
  grant and forces a human re-consent. Acceptable; `withSlotLock` already
  covers the concurrent-refresh warning the spec makes explicitly.

## Decision

Deferred. Revisit only if a recipe genuinely needs Bluesky's full API with
user context. For read-only public data, app passwords (static-key) are the
cheaper path and should be evaluated first (via the `createSession` mint arm
described above, not static-key injection).

### Decision (revised 2026-09-01) — axis framing

The revisit trigger above was recipe-driven; reframed for the axis-driven
goal (stress the guide schema so user-authored guides stay flexible):

- **Full OAuth profile (DPoP/PAR/client-metadata): stays deferred**, and that
  is now an evidence-backed call, not a staleness artifact. The review addendum
  below verified the schema absorbs this profile *additively* — no breaking
  change needed, user-authored guides unaffected — so deferral costs nothing
  later and nothing is gained by implementing early. **Concrete revisit
  signal:** Bluesky's "Permission Sets" rollout (granular OAuth scopes,
  `0011-auth-scopes` proposal; maintainer thread #4437) minting endpoints that
  reject legacy session tokens — i.e. the first real recipe hitting a
  `Bad token scope`-style rejection no app-password scope can satisfy. That is
  the same class of drift the DM endpoints preview. App-password coverage is
  otherwise complete (all `app.bsky.*` read surface; DMs via the privileged
  app-password scope; gaps are self-mutation/account-admin and ozone admin,
  which a read-only agent should be barred from anyway).
- **App-password mint arm (`createSession`): sequenced second**, after
  PeerTube's `/api login` (see the PeerTube doc's revised Decision). ROPC is
  the standard-shaped mint case and should define the generic skeleton;
  `createSession` — non-OAuth endpoint, JSON body, `accessJwt`/`refreshJwt`
  naming, two-scope semantics (`appPass`/`appPassPrivileged`), and the
  `atproto-proxy: did:web:api.bsky.chat#bsky_chat` service-proxy header for
  DMs (covered today by literal `auth.headers`) — is the adversarial second
  consumer that proves the skeleton generalizes.

The original recipe-driven framing ("revisit only if a recipe needs
Bluesky's full API") was stale: Bluesky was adopted as an **axis shape** to
generalize the tooling, and as an axis it has already paid out — the review
proved schema generality without implementation. This doc keeps the research
for the day full OAuth is triggered.

## Reference links

- AT Protocol OAuth client docs: <https://bsky.network/docs/oauth-client/>
- Authoritative spec (DPoP/PAR/client-metadata requirements): <https://atproto.com/specs/oauth>
- OAuth + auth overview (bsky-docs): <https://deepwiki.com/bluesky-social/bsky-docs/4.4-oauth-and-authentication>
- Implementation guide (PKCE, DPoP, PAR, client metadata): <https://getskyscraper.com/blog/bluesky-oauth-implementation-guide>

## Review addendum (2026-09-01)

Post-implementation review verified all code claims against source and all
Bluesky claims against the live spec. **Verdict: deferral is correct; no
schema change now** — a future `dpop?: boolean` on `OAuth2Auth` or a new
`paramStyle` value is an additive non-event per the bump rule, so deferring
costs zero schema debt for user-authored guides (DPoP touches only
`AccessTokenResult` + transport internals: code debt, users unaffected).
