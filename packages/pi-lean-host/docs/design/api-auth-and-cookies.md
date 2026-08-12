# pi-lean-host — Authenticated APIs & Cookie Sessions

> Design doc for the **first authenticated-API slice**: static-key retrieval,
> an additive cookie jar, and a login-POST-as-auth flow. Companion to and
> partial supersession of
> [`api-secrets-roadmap.md`](./api-secrets-roadmap.md) (the auth/token track)
> and [`api-stateful-sessions.md`](./api-stateful-sessions.md) (the cookie gap).
>
> Status: **design complete; implementation not started.** Deferred items are
> named, not hand-waved.

## Supersedes note

This doc supersedes:

- **`api-secrets-roadmap.md`** — the secrets-store decision is now concrete
  (env-var/prompt input → `0600` file store; §Secrets store). The roadmap's
  "Secret Service primary, plaintext fallback" is retired in favor of an
  honest headless default; the output-channel exfiltration threat is
  promoted to the **dominant** threat and the at-rest threat demoted to
  largely moot on Pi's deployment surface. The roadmap's `scopes` schema is
  dropped (§Read-only & scopes). The roadmap's checklist (output-channel
  audit, SSRF verification) is carried forward verbatim as build items.
- **`api-stateful-sessions.md`** — the cookie gap is now closed by an
  additive ephemeral jar (§Cookie jar) + a login-POST-as-auth flow
  (§Login op & lifecycle). The stateful-sessions ladder's rungs 3–4
  (additive jar; full session state machine) are resolved: rung 3 ships,
  rung 4 stays out of scope.

## Goals & scope

### In scope (this slice)

- **Static-key retrieval** — keyed read APIs that authenticate via a header
  or query-param secret (e.g. `X-Api-Key`, `Authorization: Bearer`, `?key=`).
  Real credentials live in a store, never in the guide.
- **Additive cookie jar** — persist `Set-Cookie` per session and attach
  `Cookie` on subsequent calls, closing the cookie-session-continuity gap.
- **Login-POST-as-auth** — a single `POST` to establish a session (login,
  get a cookie/token) is treated as an **auth mechanism**, not authoring.
  Enables cookie-login APIs without opening a general mutation surface.

### Deferred (named, not hand-waved)

- **OAuth2 (all flows)** — client-credentials, auth-code+redirect,
  refresh-token machinery. The `auth.kind: "oauth2"` seam stays in the
  schema, unrealized, as today.
- **General mutations / write gate** — `POST`/`PUT`/`PATCH`/`DELETE` for
  authoring or automation. The mission is information-retrieval; the
  login-POST is the one allowed non-GET, and only as auth.
- **Persistent cookie jar** — cookies on disk across sessions. Would
  reintroduce an at-rest concern (session tokens on disk, same posture as
  the secrets store); additive upgrade later.
- **OS-keychain at-rest** — `@napi-rs/keyring` (the maintained `keytar`
  successor) as a store backend. The store interface is a swappable seam;
  the keychain backend is additive without a retrofit.
- **Full session state machine** — multi-op session orchestration. The
  ephemeral jar + login-POST covers the dominant case.

## Existing seams (what the code already has)

The design is additive to seams that already exist on purpose:

- **Auth dispatch point.** `AuthKind = "none" | "static-key" | "oauth2"`
  (`core/api-guide-types.ts`). `checkAuth()` realizes only `none`; the other
  two throw "not supported." This slice realizes `static-key` and adds a
  fourth kind, `cookie-login`. The seam makes the build additive, not a
  retrofit.
- **`auth.headers` already merged into every fetch** (`helpers.ts`) — the
  **plaintext-in-guide** path for demo keys (`X-Api-Key: DEMO_KEY`). This
  stays as-is for literal values safe to commit. It is **not** the path for
  real credentials.
- **Stateless per-request transport.** `fetchUrl` (`core/transport.ts`)
  holds no cookie jar and no session; `sessionKey` is used only for spill
  filenames. Auth-header-bearing responses are already excluded from cache
  (the `hasAuthHeaders` gate) because they are private to the caller. The
  cookie jar follows the same privacy rule.
- **SSRF guard already load-bearing.** `guardRedirects` SSRF-checks each
  redirect target for server-supplied URLs (`nextLink`), because a
  malicious `nextUrl` could carry an auth header to an internal host.
  Store-injected `Authorization` amplifies this; the guard must cover the
  **merged** header set, not just `auth.headers`.
- **Helper contract is header-blind.** The pre-call helper transforms
  params→params; the gated post-response `transform` sees the parsed body
  only. Neither can inspect response headers, so `Set-Cookie` parsing
  **must be built-in** to the transport, not a local-helper quirk.

## Deployment surface & why at-rest is largely moot

Pi's plausible deployment surface is **headless-dominant**: Firecracker
microVMs, containers, headless servers, CI runners — environments with no
desktop session, no D-Bus secret-service daemon, often no `dbus` package.
Desktop (GNOME/KDE/Mac/Win) is the minority.

**Secret Service reality (verified):** every cross-platform keychain npm
lib (`keytar` [deprecated 2022], `@napi-rs/keyring` [maintained],
`cross-keychain`) routes Linux to the freedesktop Secret Service, which
requires a running `gnome-keyring-daemon` / KDE Wallet. No npm package
stores at-rest-encrypted secrets on headless Linux without a daemon —
there is nothing to encrypt *with* without the daemon's key. `keyring-rs`
does not auto-fallback on headless (it errors, issue #133); `cross-keychain`'s
"CLI fallback" goes to `secret-tool`, which *still needs the daemon*.

Consequence: on Pi's surface, the **at-rest** threat is largely moot —
the filesystem is either trusted or the whole VM is compromised, in which
case a daemon-gated keyring adds little. The security budget goes to the
**output-channel** threat instead (§Threat model). The store is a `0600`
file not because `0600` is strong, but because it is the honest headless
default and at-rest strength is not where the real risk lives.

## Threat model

### The dominant threat: key value → agent context → inference server

The threat that matters for "key sent to inference server" is: **does the
key value ever enter the agent's context as a string?** If yes, it is one
hop from the inference provider's logs — plaintext to a third party. If no,
the server never sees it.

This is an **injection-path / information-flow** concern, **orthogonal to
where the key is stored.** No storage medium (`0600` file, OS keychain,
env var) prevents it on its own.

- **`0600`** = owner-only filesystem perms. Protects against *other users
  on the same machine* reading the key at rest. Does **nothing** for the
  prompt/transcript/inference-server channel.
- **Read-only key scoping** = defense-in-depth, not a substitute. A leaked
  read-only key can still read private data, consume rate limit / quota,
  and "read" can cover sensitive scopes. It limits blast radius; it does
  not eliminate the leak. Seatbelt, not firewall.

### Storage choice interacts with prompt-leak only via "agent's natural reach"

- **Plaintext-in-guide (`auth.headers` today)** — WORST. `api-guide`
  actively surfaces guide content to the agent, so a real key in
  `auth.headers` is one tool call from context. This is why `auth.headers`
  stays literal-only and the keyed path is separate (§Auth contract).
- **Env var** — bad. The agent has bash; `env` / `printenv` reaches it.
- **`0600` file outside the project tree** — better. The agent has bash
  (a *determined* agent can `cat` it), but has no *natural reason* to look
  there. Prevents the **accidental** leak, which is the realistic threat.
- **OS keychain** — best for at-rest, but daemon-gated on headless.

### The realistic threat is accidental leak, not malicious exfiltration

The agent has bash, so absolute prevention of a *determined* agent
exfiltrating is impossible. The realistic threat is an **accidental leak**:
a 401 body echoing the header, an error message that includes the request,
a debug log. The layered posture targets the accidental leak:

1. **Code injects; the agent never supplies the value.** `api-fetch` reads
   the secret and sets the header in code. The agent knows *that* a key is
   required and *whether* it is present, never *what* it is. **[PRIMARY]**
2. **Output-channel audit.** No result or error path echoes the value —
   not a 401 body, not a request-header echo, not a debug log. This is what
   stops the key reaching the inference server. **[PRIMARY]**
3. **Read-only scoping.** Limits damage if a leak nonetheless occurs.
   Guides and docs steer users to provision read-only keys. **[DEFENSE-IN-DEPTH]**
4. **Storage placement.** Keep the value out of places the agent has a
   natural reason to look — not the guide file, not env. **[SECONDARY]**

**Reframe:** pick storage for deployment-surface practicality; spend the
security budget on the injection path + output-channel audit + scoping,
not the at-rest medium.

## What "mutations" means, and why only the login POST is in scope

HTTP-verb line: `GET`/`HEAD`/`OPTIONS` = read; `POST`/`PUT`/`PATCH`/`DELETE`/
action-endpoint = mutate. `pi-lean-host` ships only `restGet`/`paginate`
(both GET), so every non-read verb is structurally unreachable today.

The line is blurry at the edges: `POST` with read intent (Elasticsearch
`_search`, some GraphQL) is semantically read; idempotent triage
side-effects ("mark notification as read") are state change but not
authoring; stateless-but-mutating research actions (trigger workflow +
poll logs) are mutation in service of research.

Agent-research mutation use cases, honestly surveyed: (1) provenance —
agent files findings as it goes; (2) setup-then-query — create a temp
resource then read; (3) automation-as-goal — merge PRs, send messages
(a different product); (4) **login/session-establishment POST** — `POST
/login` to get a session cookie, then reads.

Only (4) genuinely intersects retrieval, and it sits at the seam between
the auth and cookie tracks. **Decision: a single POST to establish a
session is an auth mechanism, not authoring.** It is in scope as a
specific auth-flow op (`auth.kind: cookie-login`), not a general write
`via`. This lets cookie-login APIs work while keeping the no-authoring
premise intact. Cases (1)–(3) stay out of scope; if a future slice admits
general mutations, that is a separate, scoped decision, not a crack opened
by the login POST.

## Read-only & scopes (no scopes field)

Because the login POST is auth (not authoring) and general mutations are
out, **no write-gate consumer exists.** The login POST does not need a
"write" scope; there is no other write op to gate. So there is **no
`scopes` array** in the schema. Read-only becomes a **plugin invariant**
enforced by "the only non-GET `via` is the login/auth op." The defense-in-depth
lever (provision read-only keys) stays **behavioral** — code-injects +
output-channel audit + documentation guidance — not schema-enforced.

This retires the roadmap's plan to ship `scopes: ["read"]` with
`static-key`. Under the information-retrieval premise, `scopes` is
speculative schema for a mission that may never arrive.

## Auth contract (guide-author)

**Schema-driven literal-vs-reference distinction. The value never lives in
the guide.**

- **`auth.kind`**: `"none" | "static-key" | "cookie-login"` (`oauth2`
  stays in the type, unrealized, as today). `cookie-login` is the new kind
  for login-POST-as-auth.
- **`auth.headers`**: **literal values only** — demo keys, rate-limit
  tokens safe to commit. Not the path for real credentials.
- **`auth.secretRefs: Record<headerName, secretName>`**: store-backed
  header injection. "Inject the secret named `apiKey` into header
  `X-Api-Key`." Value resolved from the `0600` store at fetch time, never
  in the guide.
- **`auth.secretQueryRefs: Record<paramName, secretName>`**: parallel for
  query-param injection (`?key=<secret>`).
- **`requires: string[]`**: declares the secret names the guide expects
  (e.g. `requires: [apiKey]` for static-key; `requires: [username,
  password]` for cookie-login). The footer and `api-login` read this to
  know what to look for in the store. **No `scopes` field.**
- **`auth.cookie-login`**: the login flow block for `kind: cookie-login`.
  Reuses op request-shape vocabulary (`path`, `accept`, `body`) plus which
  secrets fill which body fields. Cookies are auto-captured into the
  ephemeral jar; no extraction config needed.
- **Parser/validator** enforces: literal-vs-reference is a **schema
  distinction** (a header in `auth.headers` and a key in `auth.secretRefs`
  are different fields), not a string-parsing convention. Easy to
  document, validate, and surface in the footer.

## Secrets store

**Env-var/prompt input → `0600` file store, keyed by domain.**

- **Entry.** The secret enters via an env var
  (`PI_LEAN_HOST_KEY_<DOMAIN>`) or a `/api secrets <domain>` prompt.
- **Persistence.** Persisted to
  `~/.pi/agent/pi-lean-host/secrets/<domain>.json` at mode `0600`.
- **Read.** `api-fetch` reads the file at fetch time, **never the env at
  fetch time.** The env is an input channel only, not the store.
- **Zero native deps.** No D-Bus, no Rust addon. The agent has no reason
  to touch env at fetch time.
- **Swappable seam.** The store backend is an interface; an `@napi-rs/keyring`
  backend (the maintained `keytar` successor) is an additive upgrade later
  without a retrofit, following the same discipline as `AuthKind`. On
  headless (Pi's dominant surface) the keychain backend would error "no
  daemon" and fall back to the file anyway, so the file is the honest
  default and at-rest strength is not the budget priority.

At-rest is largely moot on this surface; the budget goes to the
output-channel audit.

## Cookie jar

**Ephemeral, per-session, in-memory, keyed by domain.**

- The login POST runs once per session (triggered by the footer →
  `api-login`; §Login op & lifecycle). Cookies land in the jar and are
  attached as `Cookie` to subsequent `restGet`/`paginate` calls against
  the same domain.
- **Nothing persists.** Cookies vanish on shutdown. No at-rest concern
  this slice.
- Matches the existing stateless-per-request philosophy with the smallest
  change (~an additive jar in `transport.ts` plus `Set-Cookie` capture).
- **Cost:** re-login each session. Acceptable; the login is one explicit
  tool call.
- **Persistent jar is an additive upgrade later.** It would reintroduce an
  at-rest concern (session tokens on disk, same posture as the secrets
  store) and is therefore deferred.

## Login op & lifecycle

**Deterministic state-aware footer + explicit `api-login` tool (5th host
tool). No framework-auto-login.**

### The footer (shared auth-status helper)

Every `api-guide` and `api-fetch` result against an auth-bearing guide
carries a deterministic, state-aware footer, computed by **one shared
auth-status helper** used by both tools (the logic lives in one place, not
duplicated):

| State | Footer |
|-------|--------|
| No auth needed | (nothing) |
| Auth needed + credential present + session valid | `auth: ok` |
| Auth needed + credential present + no session (cookie-login) | prompt the agent to call `api-login` |
| Auth needed + credential **absent** | nudge the user to provision via `/api secrets <domain>` or `PI_LEAN_HOST_KEY_<DOMAIN>` |

The footer is **metadata, never the value.** It is safe under the
output-channel audit. The absent-credential branch is worded to steer the
user to **out-of-band** provisioning channels — the agent is a messenger,
not a credential handler. A "helpful" agent may still ask the user to
paste a key into chat; the footer wording steers away from that but cannot
fully prevent it. The footer must never include the credential value or
the full login response body.

### `api-login` tool (5th host tool)

- **Params:** one required (`domain`) + optional guide selector for
  multi-recipe domains. Minimal schema — the heavy parts (login path,
  body, secret names) live in the guide's `auth.cookie-login` block, not
  the tool call.
- **Behavior:** resolve the guide's `auth.cookie-login` block → read the
  required secrets from the `0600` store (code-injects; never agent-supplied
  params) → POST the login → capture `Set-Cookie` into the ephemeral jar.
- **Output:** a **status line, not the response body.** Login responses
  can echo credentials or session tokens; surfacing the body would violate
  the output-channel audit. The output is e.g. `logged in to <domain>` or
  the error.
- **Reuses op request-shape vocabulary** (`path`/`accept`/`body`) so there
  is no new request-shape schema to learn.

### Why no framework-auto-login

Login is **always an explicit `api-login` call triggered by the footer** —
never a silent framework side-effect. This gives a cleaner audit trail
(agent-initiated, logged, recoverable) and avoids the brittle 401-signature
heuristic for expiry detection. 401/403 recovery uses the **same
deterministic mechanism**: `api-fetch`'s footer on an expired session
prompts the agent to call `api-login` again. The framework never guesses
when to re-login from the error signature.

### Session resume

The explicit tool solves the resume/expiry case the framework-auto path
would have left awkward: a resumed session that lost the in-memory jar can
re-establish by calling `api-login`, without re-invoking the guide. The
agent learns the recovery action from the footer, not from re-reading the
guide.

## Cache / SSRF / redirect rules

- **Cookies → responses private → not cached.** Mirrors the existing
  `hasAuthHeaders` gate. Additive rule: `hasAuthHeaders || hasCookies →
  skip cache`. Any request carrying a `Cookie` (from the jar) or an
  injected `Authorization` (from `secretRefs`) skips the cache.
- **Store-injected auth headers → covered by `guardRedirects`** on
  `nextLink` + redirect targets. **Verification item:** confirm the guard
  runs on the final **merged** header set (injected + literal), not just
  `auth.headers`. Not a new mechanism.
- **Cookies on redirects → scoped by domain — stripped on cross-domain**,
  mirroring the auth-header cross-domain rule. Prevents a session cookie
  leaking to a cross-domain redirect target. (Implementation detail: eTLD+1
  scoping vs strict host-match is settled at build time; the rule is
  cross-domain stripping either way.)

## Risks

- **Accidental key leak via 401 body / error echo / debug log → flows to
  inference server.** PRIMARY. The output-channel audit must catch every
  path. This is the most-skippable-under-deadline threat; name it in the PR.
- **Plaintext-in-guide (`auth.headers`) is an active prompt-leak risk if
  used for real keys.** Must NOT be the keyed path. The `0600`-file store
  - `secretRefs`/`secretQueryRefs` are separate from guide content, and
  the parser/validator keeps literal-vs-reference a schema distinction.
- **Helper contract can't see headers → `Set-Cookie` parsing must be
  built-in** to the transport, not a local-helper quirk.
- **Read-only scoping helps but doesn't stop private-data read or quota
  burn** if leaked. Defense-in-depth, not a substitute.
- **A "helpful" agent may ask the user to paste a key into chat.** Footer
  wording steers to out-of-band channels; cannot fully prevent.
- **Footer must be metadata-only** (no credential value, no full login
  response body). Enforced by the shared auth-status helper.
- **Store-injected `Authorization` on a `nextLink`/redirect path.**
  Verify the SSRF guard covers the injected header, not just `auth.headers`.

## Validation / testing notes

Carried by the implementation, not separately designed here:

- **Parser/validator tests** for the new auth fields: `auth.kind:
  cookie-login`, `auth.secretRefs`, `auth.secretQueryRefs`, `requires`,
  `auth.cookie-login`. Literal-vs-reference is a schema distinction.
- **Output-channel audit tests** — the security-critical path. Assert no
  result or error path echoes a secret value: a 401 body, a request-header
  echo, a debug log, and the login response body are all scrubbed. This is
  the work most likely to be skipped under deadline; ship it with the
  first keyed guide, not "later."
- **Cookie jar tests** — `Set-Cookie` capture, `Cookie` attach on
  subsequent calls, cross-domain stripping on redirects, non-cacheability
  of cookie-bearing responses.
- **`api-login` tests** — store-injected credentials (never agent params),
  status-line output (never the response body), cookies land in the jar.
- **Footer tests** — all four states (none / auth-ok / call-api-login /
  nudge-provision), via the shared auth-status helper, covering both
  `api-guide` and `api-fetch`.
- **SSRF verification** — a malicious `nextUrl` carrying a store-injected
  `Authorization` is blocked by `guardRedirects` on the merged header set.
- **A real keyed guide + a real cookie-login guide** as production
  validation. The auth-injection code path is untested until a keyed guide
  exercises it; do not ship the store without a guide that uses it.

## Deferred items (explicit)

- OAuth2 (all flows) — `auth.kind: "oauth2"` seam stays, unrealized.
- General mutations / write gate — separate scoped decision; login-POST is
  not a crack open to it.
- Persistent cookie jar — additive; reintroduces at-rest concern.
- OS-keychain at-rest (`@napi-rs/keyring`) — additive store backend;
  daemon-gated on headless, file is the honest default.
- Full session state machine — ephemeral jar + login-POST covers the
  dominant case.

## Cross-references

- [`api-secrets-roadmap.md`](./api-secrets-roadmap.md) — superseded on
  storage choice and `scopes`; carried forward on output-channel audit and
  SSRF verification.
- [`api-stateful-sessions.md`](./api-stateful-sessions.md) — superseded on
  the cookie gap (additive jar + login-POST-as-auth now ship).
- [`api-helper-escape-valve.md`](./api-helper-escape-valve.md) §5 —
  authentication / header injection (`auth.headers` seam; real keyed auth
  was out of scope; this doc brings it in scope).
- [`api-hardening-and-proof-recipes.md`](./api-hardening-and-proof-recipes.md)
  — same "add when a recipe forces it" posture; the first keyed guide is
  the forcing function for this slice.
