# OAuth2 Flow — Phase 0 Research (locked candidates)

> Phase 0 deliverable for [`oauth2-flow-plan.md`](./oauth2-flow-plan.md):
> the chosen APIs with links to their OAuth2 docs, recorded so the build
> doesn't need to re-research. All facts below were verified against the
> linked docs during Phase 0 (portal browser research).

## Locked candidate set

| Candidate | Phase | Grant | Why |
|-----------|-------|-------|-----|
| **Twitch** | 1 | `client_credentials` | Clean confidential-client grant, free account (no premium gate), public non-sensitive data, well-documented token URL. App tokens can't be refreshed → exercises the "expired & no refresh → re-mint" branch. Replaces Spotify (premium-gated) and beats Discord (private chat data). |
| **Mastodon** | 2 | `authorization_code` + PKCE | Open source / community (the "not a soulless corp" pick), rich public read-only surface, PKCE officially supported (4.3+). |
| **OpenStreetMap** | 2 | `authorization_code` + PKCE | Cleanest, most unambiguous PKCE + headless docs of the bunch; the `urn:ietf:wg:oauth:2.0:oob` manual-code path maps exactly onto our headless fallback. |

Rejected candidates and why: see the "Evaluated, not selected" section below.
Bluesky has its own dedicated note: [`oauth2-bluesky-followup.md`](./oauth2-bluesky-followup.md).

---

## Twitch — Phase 1 (client credentials)

> Replaces Spotify (Phase 1): Spotify's Web API now requires an active
> **premium subscription on the app owner** (verified live — 403 "Active
> premium subscription required for the owner of the app"), which gates even
> client-credentials / public data. Twitch has no such gate and serves public
> (non-sensitive) data, so it took the slot. Discord was rejected as the
> alternative — its API is private chat content (messages, channels, guilds),
> a poor fit for a public read-only recipe.

**Spec / reference links**

- Getting OAuth tokens — client-credentials flow: <https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow>
- Refreshing access tokens ("You cannot refresh app access tokens"): <https://dev.twitch.tv/docs/authentication/refresh-tokens/>
- App registration (Developer dashboard): <https://dev.twitch.tv/dashboard>
- API reference: <https://dev.twitch.tv/docs/api/reference>

**Endpoints**

- Token URL: `https://id.twitch.tv/oauth2/token`
- Authorize URL: `https://id.twitch.tv/oauth2/authorize`
- API base: `https://api.twitch.tv/helix`

**Build-relevant facts**

- Client-credentials request: POST x-www-form-urlencoded `client_id`,
  `client_secret`, `grant_type=client_credentials` — all in the form body →
  `tokenEndpointAuthMethod: client_secret_post`.
- Token response: `{ access_token, expires_in, token_type: "bearer" }`.
- **App access tokens cannot be refreshed** (Twitch docs: "You cannot refresh
  app access tokens"). On expiry (the `expires_in` value), re-mint via
  client_credentials — no `refreshToken` in the store. Exercises the
  "expired & no refresh → re-mint" branch.
- App tokens access **non-sensitive data only** (streams, games, users,
  search, top games, clips, videos metadata) — no user permission needed.
- **Helix requires a `Client-Id` header on every request** (plus
  `Authorization: Bearer`). The oauth2 auth block has no literal-`headers`
  field today — wrinkle to resolve at build time (add `headers` to
  `OAuth2Auth`, or verify at test time).
- Free account, no premium gate, no custom User-Agent requirement.
- Corp — acceptable for Phase 1 (functional; the "less soulless" bar was
  applied to the Phase 2 picks).

---

## Mastodon — Phase 2 (authorization code + PKCE)

**Spec / reference links**

- OAuth spec: <https://docs.joinmastodon.org/spec/oauth/>
- OAuth API methods (token / authorize / apps): <https://docs.joinmastodon.org/methods/oauth/>
- App registration (`POST /api/v1/apps`): <https://docs.joinmastodon.org/methods/apps/>
- OAuth scopes: <https://docs.joinmastodon.org/api/oauth-scopes>
- OAuth tokens: <https://docs.joinmastodon.org/api/oauth-tokens>
- Client guide — obtaining client app access: <https://docs.joinmastodon.org/client/token/>
- Client guide — logging in with an account: <https://docs.joinmastodon.org/client/authorized/>

**Endpoints (per-instance — the guide needs a configurable domain)**

- Authorize URL: `<instance>/oauth/authorize`
- Token URL: `<instance>/oauth/token`
- App registration: `<instance>/api/v1/apps`
- Default instance for the guide: `https://mastodon.social`

**Build-relevant facts**

- Two-step client setup: `POST /api/v1/apps` (with `client_name`,
  `redirect_uris`, `scopes`) returns `client_id` + `client_secret` — the
  client secret is provisioned via the app-registration step, not a static
  credential. (Wrinkle to decide at build time: whether `/api oauth` needs
  an app-registration helper or the guide hardcodes a registered app.)
- **PKCE supported since Mastodon 4.3.0** (S256); recommended for both
  confidential and public clients.
- Scopes: `read` / `write` / `follow` / `push` plus granular
  (`read:statuses`, `read:accounts`, …). Read-only guide uses `read` or
  granular `read:*`.
- Auth-code exchange + refresh tokens at the token URL.
- The `scope` param on OAuth endpoints must be a **subset** of the `scopes`
  registered with the app.

**Live probe findings (post-mint-on-demand, verified against mastodon.social)**

- **App tokens ≠ user tokens — the decisive finding.** Mastodon's public
  timeline `/api/v1/timelines/public` now returns `422 {"error":"This method
  requires an authenticated user"}` even *with* a valid client-credentials
  (app) token. Mastodon distinguishes app tokens from user tokens, and the
  bulk of the API (timelines, bookmarks, …) only accepts user tokens. The
  mint itself works: the probe POSTed `client_key`+`client_secret` to
  `/oauth/token`, received a token (`scope: read`), stamped the token
  store, and injected it — the 422 is a provider-side grant restriction,
  not a probe defect.
- **Practical read access is therefore:** (a) unauthenticated public
  endpoints (`/api/v1/instance` → 200 verified, plus trends / accounts /
  public statuses), and (b) user-scoped endpoints via a **user token**.
- **The dev-app page's "Your access token" field** is a ready-made
  user-scoped token issued at app registration (scoped to the creator's own
  account). Not needed for client-credentials — but it is the cheapest path
  to user-gated read endpoints. Recommended guide shape: a **static-key**
  guide (`Authorization: Bearer {access_token}`, `optional: true`) — public
  endpoints work unauthenticated when the secret is absent, user endpoints
  light up once provisioned. Client-credentials on Mastodon buys almost
  nothing beyond proving the app registration works.
- **Store naming wrinkle resolved:** the dev page labels the OAuth
  `client_id` as "Your client key" — so the secrets store holds
  `client_key`/`client_secret` and the guide refs `clientId: { secret:
  client_key }`. No separate `client_id` entry is needed.
- Public-timeline unauthenticated access was shut down (2024 policy change):
  same 422 without any token.
- **Rate limits do NOT improve with a token.** Docs (rate-limits page) and
  live headers agree: 300 req/5 min per **account** and 300 req/5 min per
  **IP** — same number either way (`/api/v1/instance` returned
  `X-RateLimit-Limit: 300` unauthenticated and with the app token, even the
  same reset window). A token's only rate-limit benefit is bucket
  isolation: on a shared IP, other users' traffic no longer eats your
  quota. Special-case carve-outs: media upload 30/30 min, status delete /
  unreblog 30/30 min, account creation 5/30 min.

---

## OpenStreetMap — Phase 2 (authorization code + PKCE)

**Spec / reference links**

- OAuth wiki (authoritative): <https://wiki.openstreetmap.org/wiki/OAuth>
- OAuth examples: <https://wiki.openstreetmap.org/wiki/OAuth/examples>
- API v0.6 reference: <https://wiki.openstreetmap.org/wiki/API_v0.6>
- API usage policy (OSMF): <https://operations.osmfoundation.org/policies/api/>
- Rate limiting wiki: <https://wiki.openstreetmap.org/wiki/Rate_limiting>
- App registration: <https://www.openstreetmap.org/oauth2/applications> (new: <https://www.openstreetmap.org/oauth2/applications/new>)

**Endpoints**

- Authorize URL: `https://www.openstreetmap.org/oauth2/authorize`
- Token URL: `https://www.openstreetmap.org/oauth2/token`
- API base: `https://api.openstreetmap.org/api/0.6/`
- Dev sandbox (same shape, test creds): `https://master.apis.dev.openstreetmap.org/…`

**Build-relevant facts**

- Supported grants: **Authorization Code** and **Authorization Code with
  PKCE** (only OAuth2; OAuth 1.0a / HTTP Basic shut down June 2024).
- Scopes: `read_prefs`, `write_api`, `write_notes`, `read_gpx`,
  `consume_messages`. Read-only guide uses `read_prefs` (user details) +
  `read_gpx` (private GPS traces).
- **Access tokens currently do not expire automatically** — refresh is
  mostly moot for OSM (still fine through the shared resolver).
- **Headless-friendly:** the wiki documents `urn:ietf:wg:oauth:2.0:oob` — a
  manual-code redirect target where the user copies the code and pastes it
  into the app. Maps exactly onto our headless fallback (no loopback needed
  for OSM, though loopback redirect URIs also work).
- Token exchange payload: `grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&client_secret=…` (client secret required if the app is "Confidential application").
- **Rate-limit finding (decided):** OAuth2 does **not** improve read rate
  limits. The OSMF usage policy publishes no numeric anonymous-vs-auth
  limits; the documented 429 rate limiting is about changeset *uploads*
  (writes); read requests need no auth at all. OSM is selected for the
  clean interactive-flow exercise, not rate-limit or data richness.
- **Live PKCE verification (probe, post-2.6):** full flow ran end-to-end —
  `/api oauth openstreetmap.org` printed the authorize URL (PKCE challenge,
  `redirect_uri=http://127.0.0.1/callback`), user consented + pasted the
  redirect back, token store stamped (`scope: read_prefs`), and the probe
  returned 200 with user details via `useTokenStore` on
  `GET /api/0.6/user/details.json` (⚠ the endpoint is `/user/details`, not
  `/user` — both 404). Public control (`/permissions.json`) works
  unauthenticated as expected.
- **Redirect-URI rule (live-verified — drove the convention amendment):**
  all redirect URIs must use https except URLs starting with
  `http://127.0.0.1` (plus the special `urn:ietf:wg:oauth:2.0:oob`).
  `http://localhost/callback` cannot be registered — OSM only accepts the
  `127.0.0.1` spelling, which is why the runtime convention was amended
  from `localhost` to the RFC 8252 §7.3-recommended IP literal (see the
  plan doc's Phase 2.6 addendum). Register `http://127.0.0.1/callback` on
  the OSM app before running the flow.

---

## Evaluated, not selected (one-liners)

- **Reddit** — dropped: stopped issuing new app keys (the reason the Phase 1
  client-credentials candidate moved on). Docs: <https://github.com/reddit-archive/reddit/wiki/oauth2>
- **Spotify** — dropped: Web API requires an active **premium subscription on
  the app owner** (verified live, 403), gating even client-credentials /
  public data. Docs: <https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow>
- **Discord** — client credentials (Basic) but the API is **private chat
  content** (messages, channels, guilds); rejected as privacy-invasive for a
  public read-only recipe. Docs: <https://docs.discord.com/developers/topics/oauth2>
- **PeerTube** — **does not fit**: its OAuth2 is exclusively the `password`
  grant (ROPC — the deprecated grant we never build); the OpenAPI spec
  declares `flows: password` only, no `client_credentials`. Tokens are
  user-scoped (username/password, role admin/moderator/user). Docs: <https://docs.joinpeertube.org/api/rest-getting-started>
  See [`oauth2-peertube-login-followup.md`](./oauth2-peertube-login-followup.md) for the deferred `/api login` backlog item.
- **GitHub** — auth-code + PKCE, the plan's original named example, already
  has a static-key guide; viable fallback. Docs: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- **Zoom** — both grants; docs: <https://developers.zoom.us/docs/integrations/oauth/>
- **Microsoft Graph** — client credentials (app-only) but complex (tenant,
  `.default` scope); docs: <https://learn.microsoft.com/en-us/graph/auth-v2-service>
- **GitLab** — auth-code + PKCE but open-core corp; no client-credentials
  grant. Docs: <https://docs.gitlab.com/api/oauth2/>
- **Dropbox** — auth-code + PKCE only; docs: <https://developers.dropbox.com/oauth-guide>
- **Gitea / Codeberg** — auth-code, open source / non-profit, but thinner
  docs; docs: <https://docs.gitea.com/development/oauth2-provider/>
- **Wikimedia** — auth-code + refresh, huge read-only data, mediawiki fixture
  already in host tests; docs: <https://www.mediawiki.org/wiki/Wikimedia_APIs/Authentication>
- **Strava** — standard auth-code + refresh, read-only scopes, but a corp;
  docs: <https://developers.strava.com/docs/authentication/>
- **Lemmy** — **does not fit**: native JWT auth, no OAuth2 provider role
  (open feature request <https://github.com/LemmyNet/lemmy/issues/1368>).
- **Bluesky** — see [`oauth2-bluesky-followup.md`](./oauth2-bluesky-followup.md)
  (non-standard OAuth2.1 profile: DPoP + PAR + hosted client metadata).
