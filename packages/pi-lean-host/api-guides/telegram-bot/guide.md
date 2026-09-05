---
kind: api
schemaVersion: 1
domains:
  - telegram.org
shortName: Telegram Bot
icon: 🤖
apiHost: https://api.telegram.org
auth:
  kind: static-key
  secretPathRefs:
    token:
      secret: bot_token
responseShape:
  format: json
  charset: utf-8
docs: https://core.telegram.org/bots/api
operations:
  - name: getMe
    via: restGet
    path: /bot{token}/getMe
    accept: json

  - name: getUpdates
    via: paginate
    path: /bot{token}/getUpdates
    accept: json
    pagination:
      style: cursor
      itemsPath: result
      cursorParam: offset
      cursorPath: "result[-1].update_id"
    params:
      offset:
        description: >
          Identifier of the first update to return (the last received
          update_id plus one). The cursor walk seeds it from the previous
          page's last update_id; a negative value retrieves from the end of
          the queue and confirms those updates.
      limit:
        description: Number of updates to retrieve, 1-100. Defaults to 100.
---
# Telegram Bot (axis guide) — path-secret auth (`secretPathRefs`)

Axis-guide fixture for the **path-secret-auth** axis: the Telegram Bot API
keys every method through the URL path (`/bot<token>/getUpdates`), so the
bot token must be store-filled via `auth.secretPathRefs` — never
caller-supplied, never unredacted in agent context. Compressed twin of the
live-verified caritas Telegram recipe, grounded in real provider facts;
**no live endpoint** — exercised only against mocked transport.

- **`getMe`** (`restGet`) — `/bot{token}/getMe`. The store value fills the
  path segment; an agent-supplied `token` param is dropped (secret-owned
  tokens fill below the agent map); the surfaced `result.url` carries
  `***` where the token was.
- **`getUpdates`** (`paginate`, cursor) — proves the token survives every
  page build (the cursor walk re-fills the path per page from
  `result[-1].update_id` → `offset`, Telegram's documented manual loop) and
  never leaks into a query string or the surfaced URL list.

The store key is the guide's first declared domain (`telegram.org`), same
as the caritas recipe — the fixture runs with a `bot_token` secret
provisioned under `telegram.org` in a temp store. The full
resolve/execute/redact/scrub machinery for `secretPathRefs` is owned
structurally by `__tests__/path-secrets.test.ts`,
`__tests__/path-secrets-transport.test.ts`, and the auth/query-secrets
suites; this guide proves the on-disk parsed guide → resolveOpForExecution
seam for a path-secret-only guide.

## Operations

- **`getMe`** (`restGet`) — bot identity; the minimal path-keyed call.
- **`getUpdates`** (`paginate`, cursor) — long-poll feed walked by
  `update_id`; termination is structural (Telegram returns an empty
  `result` array past the end, which stops the walk via the pre-existing
  empty-page rule).
