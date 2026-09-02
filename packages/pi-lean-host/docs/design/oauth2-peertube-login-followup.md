# PeerTube — `/api login` (ROPC) OAuth2 Follow-up

> PeerTube was evaluated as a Phase 1 (client credentials) replacement for
> Reddit and **deliberately not selected** — its OAuth2 is exclusively the
> `password` (ROPC) grant, which the shipped flows never build. This note
> preserves the research and specifies a proposed `/api login` provisioning
> command as a backlog item, sequenced first (see Decision).

## Why it's attractive

- Indie / non-profit (Framasoft), AGPL, self-hostable — the "not a soulless
  corp" ethos.
- **API-friendly by design**: documented REST API + generated OpenAPI spec,
  published rate limits, and a "Third party applications" docs page listing a
  whole ecosystem of clients (official mobile app, NewPipe, Fedilab, Grayjay,
  Kodi addons). The `grant_type=password` flow is their *sanctioned* auth
  method — documented in the official quickstart, not a TOS violation.
- Rich public read-only surface (videos, channels, accounts, video metadata).

## Why it does NOT fit the shipped shape

PeerTube's OAuth2 is exclusively the **Resource Owner Password Credentials**
(ROPC / `password`) grant — the deprecated grant the plan explicitly never
builds ("Resource Owner Password Credentials — deprecated; never build").
Verified against the OpenAPI spec: `securitySchemes.OAuth2.flows` declares
`password` only, with **zero** references to `client_credentials`; the token
endpoint is `POST /api/v1/users/token` with
`grant_type=password&username=…&password=…&client_id=…&client_secret=…` —
PeerTube's ROPC still requires client credentials alongside the user
credentials — but these are **not per-app registered secrets**: every
instance ships a default local client whose `client_id`/`client_secret` are
public, fetchable at runtime from `GET /api/v1/oauth-clients/local` (step 1
of the official getting-started flow; how every third-party PeerTube client
authenticates). The guide's `OAuth2Auth` still carries
`clientId`/`clientSecret` as `secretRefs` (store names — parser-required,
and the lazy-refresh path resolves them from the store), but `/api login`
self-provisions those store entries rather than asking the human to; only
username + password are prompt-transient. Tokens are **user-scoped**
(username/password, role admin/moderator/user), valid 1 day with a refresh
token valid 2 weeks. Tokens are **user-scoped**
(username/password, role admin/moderator/user), valid 1 day with a refresh
token valid 2 weeks.

So PeerTube is neither a client-credentials candidate (no such grant) nor an
auth-code candidate (no such flow). The only way to use it is ROPC.

## The `/api login` proposal (prompt-based provisioning, no raw storage)

The plan rejects ROPC on two grounds: deprecation, and the security model
(raw user credentials flowing through the client). The proposed command
addresses the storage half of the security concern:

- **`/api login <domain>`** — prompts username + password via
  `ctx.ui.input()` (the same interaction `/api secrets` uses for secret
  values, which are treated as never touching the session file or agent
  context), **self-provisions the client credentials** (see next bullet),
  POSTs `grant_type=password` to the guide's `tokenUrl`, and stores
  **only the resulting token** (access + refresh) in the token store.
- **Client-credential self-provisioning**: the client creds are public
  instance constants (`GET /api/v1/oauth-clients/local` — see above), not
  secrets, so the command fetches them and writes them into the secrets
  store **under the guide's declared `secretRefs` names** before minting.
  The fetch target is a guide-declared knob (additive schema field,
  e.g. `clientCredsEndpoint` + JSON paths — non-event per the bump rule,
  designed now, not pre-generalized); manual `/api secrets` provisioning
  remains the fallback for instances that disabled/renamed the local
  client. This is PeerTube's first instance of the seam's own rule
  (provider variance lives in the guide, never in the command) — the same
  discipline the Bluesky tier-2 fields follow.
- **Refresh requires store-resolved client creds (invariant)**:
  `refreshAccessToken` → `resolveClientCredentials` reads `clientId`/
  `clientSecret` from the store, and PeerTube's `refresh_token` grant
  requires them on the request — if they were prompt-transient like
  username/password, the first expiry would break refresh and force a
  re-login despite a valid 2-week refresh token. Generalized seam
  invariant: **anything the refresh path needs must be persisted at mint
  time; only identity secrets (username/password, app password) are
  transient.** Bluesky's `createSession` satisfies this trivially (its
  refresh is just the rotating `refreshJwt` POSTed back).
- Raw credentials are never persisted; the slot-keyed token store
  (`(domain, grant, tokenUrl)`, stamped records), the lazy-refresh machinery
  (`refreshAccessToken` under `withSlotLock`), and the scrub paths are
  reused (one addition: the mint passes the transient username + password
  in `secretValues` — see the residual caveat). The PeerTube guide declares
  **no `revokeUrl`**: PeerTube's revocation (`POST /api/v1/oauth-tokens/revoke`)
  is authenticated by the bearer token being revoked, not RFC 7009-style
  `{ token }` — the shipped `revokeAccessToken` arm would silently fail
  provider-side, so the guide uses local-only clear (same posture as the
  orphan path). One wrinkle: the shipped refresh-failure path falls
  through to re-mint — ROPC has no store-resolved credentials to re-mint
  with, so its failure path is a re-login nudge instead.
- New `grant: "password"` value on `OAuth2Auth` plus the command — no new
  store, no new transport surface. Adding the enum value is a non-event under
  the `GUIDE_SCHEMA_VERSION` bump rule, but it is not a one-line union edit:
  the grant plumbing touched is `OAUTH2_GRANTS` + `isOAuth2SGrant`, the shared
  invariant function `oauth2GrantIssue` (used by both the parser and the
  synthetic-auth builder — gains a password-grant arm: rejects an
  `authorizeUrl`, **requires `clientSecret` unless `tokenEndpointAuthMethod`
  is `none`**, mirroring the `client_credentials` requirement, and
  **requires an `https:` tokenUrl** — the password-grant body carries the
  user's password, and `requireHttpUrl` otherwise accepts cleartext `http:`),
  a mint path in
  `auth.ts` (reusing the client-auth attach
  machinery), and a third arm in `resolveTokenUnlocked` /
  `hasUsableTokenPath` (fail closed with a `/api login <domain>` nudge).
  User-facing nudge sites to update to point to `/api login` for password
  slots: `authStatusLine`, `api-store`, `/api oauth --status`, plus
  `GRANT_QUALIFIERS` in `core/oauth-command.ts` (a hardcoded
  `client_credentials`/`authorization_code` array used for orphan
  `--status`/`--revoke` disambiguation — a password slot would be
  un-disambiguable and the error text wrong), the wizard's `--grant`
  grammar/help text, and the two `OAuth2GrantIssue` message maps
  (`syntheticGrantIssueMessage` in `core/auth.ts` and the parser's switch
  in `core/parse-api-guide.ts`, whose default branch fails loudly on a
  new issue code).
- **Slot identity**: the token slot is keyed by the token URL, so the command
  must write to the **same tokenUrl the guide's `resolveAccessToken` reads**.
  A guide-declared `tokenUrl` is canonical; prompting for a token URL is only
  allowed when no guide exists, and then the write and any later read must
  agree on that URL.
- **Positioning**: `/api login` follows the command-side pattern (`/api
oauth`, `/api secrets`) — human-typed, not learn-gated, prompts via
`ctx.ui.input()`. Therefore refused headless: a headless escape valve
exists only for flows that produce a pastable artifact (`--code`), and
ROPC has none. **Not focus-guarded** — a peer of `oauth` / `secrets` /
`verify` / `delete`: it writes the token store, not toolset state, so the
focus-indistinguishable-`{enabled}`-entry rationale doesn't apply
(making it guarded would leave it stricter than `/api oauth init`).
- **Naming**: the deferred cookie-jar **tool** is reserved as `api-login`
  (browser jar login — see AGENTS.md "Deferred by design"). `/api login` is
  a **command** subcommand, a different namespace — no collision, but the
  proximity is deliberate enough to warrant this note.

### Residual caveat (be honest about it)

No persistence ≠ no transit. The password still passes through pi's prompt
and process memory — a tier below auth-code's "user consents in their own
browser, password never touches pi." Acceptable for a provider that sanctions
ROPC (PeerTube) and stores nothing raw, but not the cleanest tier.

Two verified properties of the transit (checked against pi's internals —
`prompt()` dispatches `/`-commands to the extension handler with no message
construction, and `ctx.ui.notify` / thrown handler errors render TUI-only,
never model context):

- **Never in agent context, even on error.** The mint's error bodies render
  to the human's terminal only. Still, the mint call site must pass
  `username` + `password` in `oauthPost`'s `secretValues` — same pattern as
  its four sibling call sites — so a server echoing submitted credentials in
  an error body (e.g. PeerTube's `invalid_grant`) doesn't put them on screen.
  Defense-in-depth for the terminal, not an agent-context leak.
- **Prompt echoes plaintext while typing.** `ctx.ui.input()` is unmasked
  (pi's `ExtensionInputComponent` offers no mask option); the password is
  visible on screen during entry. Same exposure tier as every existing
  `ctx.ui.input` paste prompt (`/api secrets`, the oauth-flow paste). The
  dialog is not the main editor, so the value does not enter input history.
  Upstream masking is not pursued; this is accepted precedent.

### Other caveats

- ROPC is deprecated in OAuth2 — providers are moving away from it; this is a
  narrow, provider-specific grant.
- The token is **account-scoped** — a PeerTube guide would be per-instance
  *and* per-user (one user's account on one instance).
- ROPC has no authorize step — the **token** URL comes from the guide's
  `tokenUrl` (see the slot-identity bullet above: a prompted URL that
  diverges from the guide's would land the token in a slot the guide never
  reads).

## The cleaner forward path

PeerTube has an **open feature request** — [PeerTube #5986](https://github.com/Chocobozzz/PeerTube/issues/5986),
"Implement PeerTube as authorization Server through OAuth 2.0" (Feature
Request + Component: Auth) — asking for proper OAuth2 access. If/when that
lands, PeerTube becomes a standard auth-code recipe and `/api login` is
unnecessary.

## Decision

**First** in the session-mint queue (before Bluesky's `createSession` — see
the Bluesky doc's Decision). PeerTube's ROPC is the *standard-shaped* mint
case (real OAuth token endpoint, form-encoded `grant_type=password`, standard
token response), so it should define the generic `/api login` skeleton;
Bluesky's `createSession` then becomes the adversarial second consumer that
proves the skeleton generalizes (non-OAuth endpoint, JSON body,
`accessJwt`/`refreshJwt` naming).

Implementation notes:

- Ship `/api login` as a **generic session-mint seam** (prompt → POST →
  token-store write → lazy refresh, no raw credential persistence), with
  PeerTube as its first recipe — not as an "ROPC feature". ROPC is the
  deprecated grant; the seam outlives it.
- **Slot collision is accepted, not solved**: one user per slot. The slot
  key is `(domain, grant, tokenUrl)`; a second `/api login` on the same
  instance **overwrites** the first user's token (loud
  `slotOverwriteWarning`, re-login as user B retires user A). The real
  hazard here is a silent **identity swap** (post-re-login agent calls run
  as user B, not token loss) — so the `/api login` call site renders a
  ROPC-specific overwrite message ("retiring user A's token"; the prompt
  knows both usernames in the moment of re-login). The shipped warning
  text alone ("previous scope: X") is uninformative here — PeerTube ROPC
  tokens typically carry no scope. No schema change. This
  deliberately does **not** claim the `tokenKey` reserved seam: that seam
  is a guide-declared static key that disambiguates *guides* (scopes /
  clientIds), not *users of one guide* — consuming it for ROPC would
  require spec'ing a user-derived key (and every read site's derivation:
  `resolveTokenUnlocked`, `authStatusLine`, `--status` / `--revoke`), a
cost with no current two-user-on-one-instance need behind it. Per the
AGENTS.md reserved-seam trigger, `tokenKey` stays deferred; PeerTube
stress-tests the slot-collision decision rather than consuming the seam.
If a real second-user need arrives, the seam lands additively (tokens
re-mint on first use) — that remains the trigger to act on it.
- Revisit trigger: a recipe needs PeerTube data with user context and #5986
hasn't shipped. If #5986 lands, PeerTube becomes a standard auth-code
recipe and the ROPC arm retires naturally.
- **`/api verify` interplay**: none — `verify-command.ts` uses
  `hasUsableTokenPath` as a fail-fast precheck (the password arm returns
  true only for cached-fresh/refreshable tokens — no auto-mint path
  exists), and `verify.json` supplies op params only, never credentials.
  Stated so an implementer doesn't hunt for one.

### Generalization boundary (what variance the seam absorbs)

Providers split into three tiers, and the seam is designed for the first two:

- **Standard ROPC** (PeerTube-shaped): near-zero variance — client
  credentials required/optional/absent (guide's `SecretRef.optional`,
  self-provisioned via the guide-declared `clientCredsEndpoint` knob),
  extra token-request params like `scope` (guide-declared), standard
  token response. One code path, guide-supplied knobs.
- **Non-OAuth session APIs** (Bluesky `createSession`): real variance, but
  confined to the **guide** *in principle*: JSON vs form encoding,
  field-name mapping (`accessJwt`/`refreshJwt`), a distinct refresh
  endpoint. **Honest cost note:** the current core does not yet absorb
  this via schema — `tokenFromResponse` reads only RFC 6749 field names,
  `oauthPost` is form-encoded only, and refresh hardcodes
  `grant_type=refresh_token` to `auth.tokenUrl`. Absorbing tier 2 needs
  **additive schema fields** (response-field map, refresh URL) — non-event
  additions, but designed when Bluesky lands, not pre-added (YAGNI).
Provider variance belongs in the recipe, never in the command — the
schema work to make that true is priced, not free.
- **Doesn't fit, correctly out of scope**: interactive multi-step auth
  (CAPTCHA, push-2FA, webview consent — a prompt seam can't do these) and
  DPoP-bound profiles (Bluesky full OAuth — schema absorbs additively
  later, see the Bluesky doc's addendum). The failure mode for anything
  marginal is a failed mint that fails closed with a nudge, never silent
  breakage.

The proof obligation is sequencing, not analysis: Tier 1 defines the
skeleton, Bluesky (Tier 2) is the adversarial consumer that proves it —
if Bluesky's shape forces control-flow (not field-mapping) into core, the
"generic seam" claim is what fails, and that's the signal to scope the
seam back to its concrete consumers.

Also note the Tier 1 population is shrinking (ROPC is deprecated): the
seam's long-term value is the session-mint framing above, with
app-password-style session APIs as the likely bulk of future consumers.

## Reference links

- PeerTube REST API quick start (the sanctioned ROPC flow): <https://docs.joinpeertube.org/api/rest-getting-started>
- PeerTube OpenAPI spec: <https://github.com/Chocobozzz/PeerTube/blob/develop/support/doc/api/openapi.yaml>
- Third party applications (API-friendly evidence): <https://docs.joinpeertube.org/use/third-party-application>
- PeerTube #5986 — OAuth2 authorization server feature request: <https://github.com/Chocobozzz/PeerTube/issues/5986>
