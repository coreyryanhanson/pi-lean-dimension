---
kind: api
schemaVersion: 1
domains:
  - twitch.tv
shortName: Twitch
icon: 🎮
apiHost: https://api.twitch.tv
auth:
  # client_credentials: Helix app-token reads (public data, no user context).
  # App tokens cannot be refreshed — on expiry resolveAccessToken re-mints.
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://id.twitch.tv/oauth2/token
  clientId:
    secret: client_id
  clientSecret:
    secret: client_secret
  tokenEndpointAuthMethod: client_secret_post
  secretRefs:
    Client-Id:
      secret: client_id
responseShape:
  format: json
  charset: utf-8
operations:
  - name: users
    via: restGet
    path: /helix/users
    accept: json
    requiresAnyOf: [id, login]
    params:
      id:
        description: User ID (up to 100, repeatable).
      login:
        description: Login name (up to 100, repeatable).
---
# Twitch Helix (synthetic axis guide) — oauth2 client_credentials

Compressed twin of the live-verified caritas `twitch` recipe. Synthetic
coverage fixture for the `oauth2-auth` axis, `client_credentials` facet:
cc auto-mint, Bearer injection **plus the `secretRefs` merge** (`Client-Id`
resolves from the same `client_id` store secret as the token request —
the merged-header behavior no other fixture exercises), no-refresh
re-mint, and on-disk parsed-guide → `resolveOpForExecution` seam. No live
endpoint — exercised only against mocked transport + a stubbed token
endpoint.

Grounded in real provider facts (from the caritas recipe, verified live
there): token URL `https://id.twitch.tv/oauth2/token`, the mandatory
`Client-Id` header on every Helix request, and non-refreshable app tokens
(Twitch docs: "You cannot refresh app access tokens" — the resolver
re-mints on expiry instead of refreshing).

## Operations

- **`users`** (`restGet`) — `/helix/users` with `requiresAnyOf: [id, login]`.
  When `client_id`/`client_secret` are provisioned, the captured transport
  headers must include both `Authorization: Bearer <token>` and `Client-Id`.

The user-token half of the axis (authorization_code, fail-closed, slot
coexistence) lives in the sibling `twitch-user` guide — same `twitch.tv`
domain claim, separate authorization_code token slot. Op names are disjoint
across the pair (multi-recipe-domains: the sibling split exists *because of
auth slots*). Cursor pagination is owned by usgs; `requiresAnyOf` by
wikimedia-action and the op above.
