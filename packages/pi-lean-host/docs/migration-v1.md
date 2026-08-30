# Migrating guides to schema v1

> Fix for guides rejected with `schemaVersion: 0` (or no `schemaVersion`
> line). One breaking change: static-key auth went flat → nested.

## Before (v0) → After (v1)

```yaml
# v0
auth:
  kind: static-key
  requires: [api_key]            # deleted
  optional: [user_key]           # deleted
  headerPrefixes:
    Authorization: "Bearer "     # deleted
  secretRefs:
    Authorization: api_key
    X-Api-Key: user_key
```

```yaml
# v1
schemaVersion: 1
auth:
  kind: static-key
  secretRefs:
    Authorization:
      secret: api_key            # store name (was a bare string)
      prefix: "Bearer "          # from headerPrefixes
    X-Api-Key:
      secret: user_key
      optional: true             # from the optional roster
```

| v0 | v1 |
|----|-----|
| `secretRefs: {<header>: <name>}` | `secretRefs: {<header>: {secret: <name>}}` |
| `requires: [<name>]` | delete — required is the default |
| `optional: [<name>]` | `optional: true` on the ref that uses it |
| `headerPrefixes: {<header>: "<p>"}` | `prefix: "<p>"` on that header's ref |
| no `schemaVersion` line | add `schemaVersion: 1` |

Fix = stamp `schemaVersion: 1`, wrap each flat `secretRefs` value as
`{secret: <name>}`, merge in `requires`/`optional`/`headerPrefixes`.

## Non-events

Additive changes (optional fields, new enum values, relaxed constraints)
never bump the version. Guides saved via current `api-learn` are stamped
already.

## Shelf life

Stays as long as v0 guides can exist: user-authored local guides
(`~/.pi/agent/pi-lean-host/api-guides/`) can hit the gate long after it
ships. Superseded only by a v2 migration doc.
