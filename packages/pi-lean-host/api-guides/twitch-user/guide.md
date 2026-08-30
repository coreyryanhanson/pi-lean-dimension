---
kind: api
schemaVersion: 1
description: Twitch Helix reads that need a user access token (own-user reads).
domains:
  - twitch.tv
shortName: Twitch User
icon: 🎮
apiHost: https://api.twitch.tv
auth:
  # authorization_code: Helix reads with user context. The user token lives
  # in its own slot — (twitch.tv, authorization_code, tokenUrl) — so it
  # coexists with the app-token slot the sibling `twitch` guide uses
  # (multi-grant slots, one <domain>.json file).
  kind: oauth2
  grant: authorization_code
  tokenUrl: https://id.twitch.tv/oauth2/token
  authorizeUrl: https://id.twitch.tv/oauth2/authorize
  clientId:
    secret: client_id
  clientSecret:
    secret: client_secret
  tokenEndpointAuthMethod: client_secret_post
  scopes:
    - "user:read:email"
    - "user:read:follows"
  secretRefs:
    Client-Id:
      secret: client_id
responseShape:
  format: json
  charset: utf-8
operations:
  - name: me
    via: restGet
    path: /helix/users
    accept: json
    params: {}
  - name: followedStreams
    via: paginate
    path: /helix/streams/followed
    accept: json
    pagination:
      style: cursor
      itemsPath: data
      cursorPath: pagination.cursor
      cursorParam: after
      pageSizeParam: first
      pageSize: 20
    params:
      user_id:
        description: User whose followed live streams to list (must match the access token's user).
        required: true
      first:
        description: Maximum number of items per page (1–100, default 100).
      after:
        description: Cursor for forward pagination.
---
# Twitch Helix user-token reads (synthetic axis guide) — oauth2 authorization_code

Compressed twin of the live-verified caritas `twitch-user` recipe.
Synthetic coverage fixture for the `oauth2-auth` axis, `authorization_code`
facet: the auth-code arm refuses pre-request with
`reason: "oauth_token_missing"` when no user token is minted (no
client-credentials fallback — a user token cannot be minted without the
human paste flow), and per-guide op resolution. No live endpoint —
exercised only against mocked transport.

Sibling of the `twitch` guide (same `twitch.tv` domain claim): that one
covers app-token reads; this one the user-token reads. Op names are
disjoint across the two guides. Both store secrets (`client_id`,
`client_secret`) are shared with the app guide; the two tokens live in
**separate slots** of the same oauth store file, keyed
`(domain, grant, tokenUrl)` — minting one never clobbers the other
(co-located slot coexistence pair-test).

## Operations

- **`me`** (`restGet`) — `/helix/users` with no params (the token's own user).
- **`followedStreams`** (`paginate`, cursor style) —
  `/helix/streams/followed`, `itemsPath: data`, required `user_id`.
