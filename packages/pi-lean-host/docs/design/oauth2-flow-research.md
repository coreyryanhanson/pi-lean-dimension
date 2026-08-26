# OAuth2 Flow — Phase 0 Research (locked candidates)

> Phase 0 deliverable for [`oauth2-flow-plan.md`](./oauth2-flow-plan.md):
> the chosen APIs with links to their OAuth2 docs, recorded so the build
> doesn't need to re-research. All facts below were verified against the
> linked docs during Phase 0 (portal browser research).

## Locked candidate set

| Candidate | Phase | Grant | Why |
|-----------|-------|-------|-----|
| **Reddit** | 1 | `client_credentials` | Clean confidential-client grant, well-documented token URL, `read` scope. App-only tokens never get a refresh token → exercises the "expired & no refresh → re-mint" branch. |
| **Mastodon** | 2 | `authorization_code` + PKCE | Open source / community (the "not a soulless corp" pick), rich public read-only surface, PKCE officially supported (4.3+). |
| **OpenStreetMap** | 2 | `authorization_code` + PKCE | Cleanest, most unambiguous PKCE + headless docs of the bunch; the `urn:ietf:wg:oauth:2.0:oob` manual-code path maps exactly onto our headless fallback. |

Rejected candidates and why: see the "Evaluated, not selected" section below.
Bluesky has its own dedicated note: [`oauth2-bluesky-followup.md`](./oauth2-bluesky-followup.md).

---

## Reddit — Phase 1 (client credentials)

**Spec / reference links**

- OAuth2 wiki (reddit-archive, authoritative): <https://github.com/reddit-archive/reddit/wiki/oauth2>
- redditdev wiki — OAuth2 guide: <https://www.reddit.com/r/redditdev/wiki/oauth2/>
- redditdev wiki — OAuth2 explanation: <https://www.reddit.com/r/redditdev/wiki/oauth2/explanation/>
- Scopes reference: <https://www.reddit.com/api/v1/scopes>
- Endpoint→scope matrix: <https://www.reddit.com/dev/api/oauth>
- App registration (create a confidential "web app"): <https://www.reddit.com/prefs/apps>

**Endpoints**

- Token URL: `https://www.reddit.com/api/v1/access_token`
- Authorize URL: `https://www.reddit.com/api/v1/authorize`
- Authenticated API base: `https://oauth.reddit.com` (not `www.reddit.com`)

**Build-relevant facts**

- Client-credentials request: POST form `grant_type=client_credentials` to the
  token URL, **HTTP Basic auth** (`client_id` : `client_secret`) →
  `tokenEndpointAuthMethod: client_secret_basic`.
- Token response: `{ access_token, token_type: "bearer", expires_in, scope }`.
- **App-only tokens never receive a refresh_token** — on expiry, re-mint via
  client_credentials (no `refreshToken` in the store).
- Requires a **confidential** app type (web app with a secret) for
  `client_credentials` — fits the `client_secret`-in-secrets-store model.
  Reddit's `installed_client` grant is Reddit-specific; not used.
- **Requires a unique User-Agent header** (their API policy) — guide-level
  `headers` entry.
- Read-only scope: `read` (plus `identity`, `history`, etc. as needed).

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

---

## Evaluated, not selected (one-liners)

- **Spotify** — both grants, canonical shape, good data; dropped for being a
  corp (the "less soulless" bar). Docs: <https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow>
- **GitHub** — auth-code + PKCE, the plan's original named example, already
  has a static-key guide; viable fallback. Docs: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- **Twitch** — both grants (`client_secret_post`); docs: <https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/>
- **Zoom** — both grants; docs: <https://developers.zoom.us/docs/integrations/oauth/>
- **Discord** — client credentials (Basic); docs: <https://docs.discord.com/developers/topics/oauth2>
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
