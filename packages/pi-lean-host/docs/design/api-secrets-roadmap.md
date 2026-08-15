# pi-lean-host — API Secrets Roadmap

> Roadmap for the **first keyed-auth build**, extracted from the pre-release
> design doc before it was squashed. v1 ships no secrets store — this file
> exists so the security-critical path is built *on purpose* when a real
> keyed guide lands, not rediscovered under deadline pressure.
>
> Status: **deferred past v1.** The `auth.kind` seam is in the code; the
> store is not.

## Where v1 leaves things

v1 ships **`auth.kind: none` only**. The reference API (BOE) is no-auth — a
bare GET returns data, no key, no header. No v1 recipe exercises a
store-backed auth path, so v1 ships **no secrets store at all**: no
OS-native secret-store integration, no file fallback, no `requires`/`scopes`
resolution, no secret-entry UX.

What v1 *does* ship:

- **The `auth.kind` seam** — `AuthKind = "none" | "static-key" | "oauth2"`
  on the guide schema (`core/api-guide-types.ts`). `checkAuth()` in
  `core/helpers.ts` realizes only `none`; `static-key` and `oauth2` throw a
  structured "not supported in this version" error. The dispatch point
  exists; nothing behind it does.
- **`auth.headers?: Record<string, string>`** — already shipped and merged
  into every fetch (`helpers.ts:428` for `restGet`, `:618` for `paginate`).
  Three bundled recipes use it (`resources.data.gov` with `X-Api-Key:
  DEMO_KEY`, plus `musicbrainz.org`, `en.wikipedia.org`). This is the
  **plaintext-in-guide** path: the value sits in the recipe file, not a
  secret store. It covers demo keys and rate-limit tokens safe to commit;
  it is **not** the path for real credentials.

### Why the seam matters — don't "simplify" it away

The seam makes the future refactor **additive**, not a retrofit. Auth is a
strategy selected by a guide field. Adding `static-key` (the next strategy,
when a real keyed guide lands) and later `oauth2` means **new branches behind
an existing dispatch** — not surgery on `restGet`'s call sites or the guide
format. If `restGet` had baked "inject this header from the secret" in
unconditionally, the OAuth2 refactor would reach into `restGet` *and* the
schema simultaneously. If v1 had no seam at all — just "BOE has no auth so I
never think about auth" inline — the future refactor would reach into
`restGet` to *introduce* the dispatch.

The auth-injection code path is literally untested until a keyed guide
arrives (BOE never exercises it). The seam is the only thing keeping that
refactor additive — **dropping it to "simplify" burns the one thing v1 built
on purpose for the keyed track.**

## Why the store was deferred, not pre-built

v1 has no keyed guide, so a store shipped now would enter the world with
**zero production validation on the single most security-critical code path
in the package** — secret storage, retrieval, injection, and output-channel
exfiltration prevention. Building it before any guide exercises it is the
same risk in a different dress as "building OAuth2 because BOE needs it" —
BOE needs no auth. Defer the store until a real keyed guide lands; ship only
the seam.

`scopes` will be added to the schema at the same time as `static-key`, not
now. That is still a schema *grow*, not a retrofit — no v1 guide has a
`scopes` field to migrate.

## The two threats

The store is deferred, but the threats it must address are named here so the
build lands on **both** fronts rather than being lazy about the silent one.

### 1. At-rest storage

Where the key lives on disk. Plaintext JSON at `0600` is the lazy default
and is explicitly **not** the choice when the store ships — the primary
store is the OS-native secret store; a plaintext file is the fallback only
when no secret-store daemon is available.

### 2. The transcript / output channel — the silent leak

The injection path must be airtight across **every helper and every error
branch** — a 401 response body echoed into a tool result leaks as surely as
a `console.log` of the key. The existing codebase has no precedent for this
surface (`storage-state.ts` handles filesystem races, not output-channel
exfiltration). Every helper and every error path that returns content to the
agent must be audited against this channel.

This is the **silent leak, more dangerous than the at-rest threat** — it
bypasses file perms entirely. Do not build the store without auditing this
channel end-to-end.

## Checklist for the first keyed-guide build

All out of scope for v1. Collected here as the build checklist, not as v1
work:

- **The at-rest store.** Linux-first: the **freedesktop Secret Service**
  (libsecret, backed by GNOME Keyring / KDE Wallet) over D-Bus as primary;
  a plaintext JSON file at `0600` as fallback for headless servers, CI, and
  any environment where no Secret Service daemon is running (a common Linux
  case, not an edge case). macOS Keychain and Windows Credential Manager are
  supported **only if a single cross-platform Node.js library covers all
  three platforms at zero cost to the Linux path** — no Linux-only
  dependency, no Linux-only friction. If no such library exists or it adds
  any Linux inconvenience, macOS/Windows fall back to the plaintext-file
  store and the Linux-native Secret Service path stands alone. File-fallback
  location: `~/.pi/agent/pi-lean-host/secrets/<domain>.json`.
- **The `requires` / `scopes` schema.** A guide with a keyed `auth.kind`
  declares `requires: [api_key]`, and each required secret carries a `scopes`
  field (`["read"]` by default, `["write"]` reserved for the future mutation
  gate). `api-fetch` injects the secret; the agent never reads the raw
  value. The mutation gate (when it arrives) is then "does this guide
  require a write-scoped key?" — not a re-invention of the secrets schema.
- **Secret entry UX.** A `/api secrets [domain]` subcommand is the leading
  candidate (mirrors `/web cookies` / `/web profile` as a visibility +
  management command owned by `pi-lean-host`). Whether entry is a CLI
  subcommand, a tool call, or a hand-edited file is TBD — but it is a UX
  choice on top of the storage decision, not a substitute for it.
- **Output-channel audit.** Every helper (`restGet`, `paginate`,
  `parseResponse`) and every error branch that returns content to the agent
  must be audited against threat #2. A 401/403 body, an echo of the request
  headers, a debug log — any of these leaks the token if not scrubbed. This
  is the work most likely to be skipped under deadline; name it in the PR.
- **SSRF guard — verify the credential-bearing path.** The `nextLink` SSRF
  guard (`core/ssrf-guard.ts`) is **already load-bearing**, not latent:
  `auth.headers` is merged into every paginate fetch today (`helpers.ts:618`),
  so any guide using `auth.headers` with a real value on a `nextLink`
  paginator already relies on it to stop a malicious server-supplied
  `nextUrl` from carrying the header to an internal host. The store-injected
  `Authorization` header (the `static-key`/`oauth2` path) **amplifies** this
  — real secrets, not demo keys, and `checkAuth`-gated so injection is
  central. Before that path ships, verify the guard covers the
  credential-bearing fetch (it already runs on `nextLink` + redirect
  targets via `guardRedirects`; confirm the injected header is the one
  guarded, not just `auth.headers`).

## Scope reminder

This track is for **retrieval** keyed auth (a read API that needs a key),
not general write/bot automation. A mutation needs not just "is this
write-safe" but "do we have a write-scoped key" — and that gate's foundation
is the scoped secrets schema above. The package's mission is
information-retrieval; secrets exist to unlock read access to APIs that
require it, not to turn the package into a bot platform.
