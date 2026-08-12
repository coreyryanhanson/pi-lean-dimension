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
  (dialog / file-write input → `0600` file store; §Secrets store). The roadmap's
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
  (`core/api-guide-types.ts`). `checkAuth(auth)` (`core/helpers.ts:315`)
  realizes only `none`; the other two throw "not supported." This slice
  realizes `static-key` and adds a fourth kind, `cookie-login`. The seam
  makes the build additive, not a retrofit.
  **Contract change for `cookie-login` (named, not hand-waved):** today
  `checkAuth` is `(auth) => void` and branches only on `kind`. For
  `cookie-login`, a fetch with no live session in the jar must not reach
  the network — so `checkAuth` gains the request's jar + domain and
  verifies a session exists for `cookie-login` (throw a recoverable
  "call api-login" error, which the footer also surfaces). New signature:
  `checkAuth(auth, ctx)` where `ctx = { jar, domain }` (`domain` = request
  URL hostname, §Cookie jar). `none`/`static-key` ignore `ctx`; only
  `cookie-login` reads the jar. The throw is the single place that enforces
  "no authenticated fetch without a session," so every `restGet`/`paginate`
  caller is covered by construction — no per-call-site guard.
- **`auth.headers` already merged into every fetch** (`helpers.ts`) — the
  **plaintext-in-guide** path for demo keys (`X-Api-Key: DEMO_KEY`). This
  stays as-is for literal values safe to commit. It is **not** the path for
  real credentials.
- **Stateless per-request transport.** `fetchUrl` (`core/transport.ts`)
  holds no cookie jar and no session; `sessionKey` is used only for spill
  filenames. Auth-header-bearing responses are already excluded from cache
  (the `hasAuthHeaders` gate) because they are private to the caller. The
  cookie jar follows the same privacy rule.
- **SSRF guard already load-bearing, but only opted into for `nextLink`.**
  `guardRedirects` SSRF-checks each redirect target for server-supplied
  URLs (`nextLink`), because a malicious `nextUrl` could carry an auth
  header to an internal host. The guard is a hostname check (`ssrfGuard`
  inspects the redirect-target URL, not the request headers), so the
  question that matters is "does this request guard its redirects?" — and
  today only `paginate`'s `nextLink` branch opts in (`restGet` passes
  `undefined`). Store-injected `Authorization` on a `restGet` that 302s
  to an internal host would leak the header with no check. The fix is a
  one-line change in `fetchUrl` (§Cache / SSRF / redirect rules), not a
  header-set concern.
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
  surfaces only `auth.kind` to the agent (`tools/api-guide.ts:199`), not
  `auth.headers`, so the leak is **not** one `api-guide` tool call away —
  the real vector is bash: the agent has `cat`, and a real key committed
  in `auth.headers` is one shell command from context. Same conclusion,
  honester mechanism. This is why `auth.headers` stays literal-only and
  the keyed path is separate (§Auth contract).
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
- **`auth.requires: string[]`**: declares the secret names the guide
  expects (e.g. `auth.requires: [apiKey]` for static-key;
  `auth.requires: [username, password]` for cookie-login). Lives under
  the `auth` block alongside `auth.secretRefs` / `auth.secretQueryRefs` /
  `auth.cookie-login` (not a top-level guide field), because it names
  auth secrets. The footer and `api-login` read this to know what to look
  for in the store. **No `scopes` field.**
- **`auth.cookie-login`**: the login flow block for `kind: cookie-login`.
  Reuses op request-shape vocabulary (`path`, `accept`, `body`) plus which
  secrets fill which body fields. Cookies are auto-captured into the
  ephemeral jar; no extraction config needed.
- **Parser/validator** enforces: literal-vs-reference is a **schema
  distinction** (a header in `auth.headers` and a key in `auth.secretRefs`
  are different fields), not a string-parsing convention. Easy to
  document, validate, and surface in the footer. Concretely, `validateAuth`
  (`core/parse-api-guide.ts:389`) gains these rules (all fail-closed with a
  `fix:` hint):
  - `auth.kind` must be one of `none | static-key | cookie-login` (extend
    `KNOWN_AUTH_KINDS`; `oauth2` stays in the TS type but is **rejected at
    parse time** as "not yet implemented," matching today's `checkAuth`
    throw — the type seam and the parse set diverge on purpose).
  - **Kind↔field consistency:** `secretRefs` / `secretQueryRefs` are
    rejected when `kind: none` (a none guide has no secrets); the
    `cookie-login` block is rejected when `kind` ≠ `cookie-login`; for
    `kind: static-key` the `cookie-login` block is rejected; for
    `kind: cookie-login` the `cookie-login` block is **required**.
  - **`auth.requires` ↔ referenced names:** every secret name appearing
    in `secretRefs`, `secretQueryRefs`, or the `cookie-login` body-field
    map must be declared in `auth.requires` (catches a typo'd
    `apiKey`/`api_key` mismatch at parse time, not at fetch time).
    `auth.requires` names with no referrer are allowed (documentation-only
    listing is harmless).
  - **`secretQueryRefs` ↔ operation `params` collision:** a secret
    param name (a key of `auth.secretQueryRefs`) that also appears in
    any operation's `params` map is a parse error. The agent must not be
    able to supply a value for a param that is secretly injected —
    either the agent's value collides with the secret or silently
    overrides it, both unsafe. The guide author marks the param
    `secretQueryRefs`-only; the agent never sees it as a settable param.
    (Path-injected secrets, when shipped, get the same rule against
    path-template fields.)
  - `secretRefs` / `secretQueryRefs` are `Record<string, string>`
    (headerName/paramName → secretName), validated the same way as
    `auth.headers` today. Empty maps are allowed (= no injection).

### Output-channel audit for `secretQueryRefs`

Header secrets never touch the URL or the params map, so they avoid
the two query-param channels below. They are **not** however
output-channel-clean by construction: a server may echo the auth
header in a **response** header (e.g. `X-Api-Key: <value>` echoed
back), and `api-fetch` emits the full response headers as
`details.headers` (`tools/api-fetch.ts:243`, restGet branch). That is
a third output surface — the **response-header echo** — and it is
covered by the output-channel audit for `secretRefs` (§Risks, §Output-channel
audit tests), not by the `secretQueryRefs` design. **Query-param secrets**
add two further parallel channels that must both be defended:

1. **The URL** — surfaced in every result/error emit site
   (`formatRequestLine`, `details.request.url`, `renderResult`,
   `formatHelperError`, `PaginateResult.urls`). An unscrubbed
   `?key=<real-value>` here is a direct prompt-leak.
2. **The params map** — `restGet` returns `params: query` and `paginate`
   returns `params: effectiveParams` (`core/helpers.ts`), and `api-fetch`
   emits that map as `details.request.params` (`tools/api-fetch.ts`).
   `AgentToolResult.details` is **not** injected into the model's context
   (only `content` is), so this is not a *prompt*-leak — but `details` is
   the documented channel for *session-file / log* persistence, which is
   exactly the transcript surface the PRIMARY defense (§Threat model)
   spends its capture design keeping the secret out of. A raw secret in
   `details.request.params` on every authenticated fetch defeats that
   protection on the first call.

Redaction is therefore **mandatory** for `secretQueryRefs`, and the two
channels need **two different defenses**, not one.

**Design — two channels, two defenses.**

*Channel 1 (URL): redact once at the capture point, never carry the
real URL past the fetch layer.* The secret-bearing fetch uses the real
URL; the URL stored in the result/error object is the redacted copy.
Every URL emit site is covered by construction, with no per-site
scrubbing:

```ts
function redactSecretParams(url: string, secretParamNames: Set<string>): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) {
    if (secretParamNames.has(k)) u.searchParams.set(k, "***");
  }
  return u.toString();
}
```

The set of secret param names is the keys of the guide's
`auth.secretQueryRefs`. Lives next to `buildUrl` in `core/helpers.ts`;
the redacted URL is what `result.url` / `result.urls` / `err.url`
carry.

*Channel 2 (params): inject the secret **below** the returned params
map, never into it.* This is the load-bearing rule and the place a
naive implementation of "merge the secret into the params map before
`buildUrl`" would leak. `buildQueryParams` produces the agent-derived
query — that is what `result.params` carries and what `api-fetch` emits
as `details.request.params`. The secret query param is injected
**after** that, in one of two equivalent ways, and the map that gets
returned is the pre-injection one:

- **(a) inside `buildUrl`** — pass the secret map as a separate
    argument and merge it there, so the returned `query`/`effectiveParams`
    variable never holds the secret; or
- **(b) into a secret-only map merged between `buildQueryParams` and
    `fetchWithOpts`** but not assigned back to the returned variable.

Either keeps `result.params` agent-derived by construction — no
redaction function needed for this channel, because the secret is
never in the map to begin with. **Do not** merge the secret into the
`query`/`effectiveParams` variable and then try to scrub it on the way
out; that is the fragile path and it leaves the secret in `details`.

This is a **return-contract change** to `restGet`/`paginate`: the
`params` field becomes "agent-supplied params" (not "effective request
params including secrets"). Today only `api-fetch.ts` reads `result.params`
(into `details.request.params`, lines 242 and 292), so the blast radius
is those two call sites, and the new semantics is the one the threat
model already requires.

**No conflict with the cache:** secret-bearing requests already skip
caching (`hasAuthHeaders` → skip, extended to injected auth in §Cache /
SSRF / redirect rules), so the redacted URL is never used as a cache
key.

**Two edge cases named, not hand-waved:**

- **Scope is query params only.** Path-injected secrets
  (`secretPathRefs`, a future field) have no clean param boundary and a
  harder redaction story; this slice does not ship them. If a future
  slice does, it brings its own redaction design — do not assume this
  `redactSecretParams` covers it.
- **Server-supplied `nextUrl` may itself echo the secret param.** The
  redactor must run on `result.urls` entries (paginate) too, not just
  the initial `buildUrl` output. Cleanest: redact at the `urls.push(url)`
  site (`helpers.ts`) so the real URL never enters the array, matching
  the "never carry the real URL past the fetch layer" principle rather
  than scrubbing the array after the fact.

### `/api secrets <domain>` reuse — the registry + footer, not the redactor

A `/api secrets <domain>` listing shows secret **names** (`apiKey`,
`username`) and presence, never the value, so it does **not** call
`redactSecretParams` — a shared "redaction module" would have one real
consumer each, which is the wrong abstraction. What *is* shared:

1. **The secret-name source of truth** — URL scrubbing needs the
   `secretQueryRefs` keys for the guide; the listing needs the guide's
   `auth.requires` + the store's filenames. One registry, two consumers.
2. **The auth-status helper** (§Login op & lifecycle) — the footer's
   "credential present / absent" branches are the presence check a
   `/api secrets` listing wants. `/api secrets <domain>` is the footer's
   presence logic lifted into a standalone command. That is the genuine
   reuse, and it is already in this design.

### `/api` command surface — the `secrets` subcommand

`/api secrets <domain>` is a **new subcommand** on the existing `/api`
command (`core/api-toggle.ts` switch, today `on | off | learn | status |
helpers | bare`). It is interactive capture (§Transcript-safe capture),
not a toolset actuation, so:

- **Focus-mode guard: not applied.** The guard refuses only the
  actuating subcommands (`on`/`off`/`learn`) while `pi-tool-masking`
  holds the line (`isFocusHolding()`, `api-toggle.ts:39`). `secrets` is a
  peer of the already-unguarded `status`/`helpers`/bare branches — it
does not write a `{enabled}` entry, so it cannot blur a sibling toggle's
  focus.
- **Help text + AGENTS.md.** Add `secrets` to the `/api` help block (the
  `default:` branch's line list) and to the command list in
  `packages/pi-lean-host/AGENTS.md` ("Registers the `/api` command with
  `on|off|learn|status/helpers` subcommands" → add `secrets`).
- **Headless no-op.** `ctx.hasUI` false → the subcommand prints the
  direct-file-write instructions (§Secrets store) instead of prompting;
  it must not crash or hang waiting on a dialog that will never come.

## Secrets store

**Dialog / file-write input → `0600` file store, keyed by domain.** No
env-var middleman — `PI_LEAN_HOST_KEY_<DOMAIN>` is dropped entirely.

- **Entry (interactive — TUI/RPC).** `/api secrets <domain>` captures the
  value via `ctx.ui.input(title, placeholder)` (unmasked, single-line;
  §Transcript-safe capture), writes it directly to the store, and returns
  a metadata-only status line (`secret stored for <domain>`). Works in
  TUI and RPC via the `extension_ui` request/response sub-protocol.
- **Entry (headless — print/JSON/CI).** `ctx.hasUI` is false in
  print/JSON mode, so the dialog is unavailable there. The deployment
  writes the `0600` file directly before pi starts (a one-line
  `install -m 600` + `cat >` step or a tiny CLI helper). No env involved.
- **Persistence.** `~/.pi/agent/pi-lean-host/secrets/<domain>.json` at
  mode `0600`. The file is the single store; both input channels write to
  it.
- **Read.** `api-fetch` reads the file at fetch time. The value never
  enters the agent's context as a string (code-injects; §Threat model).
- **Zero native deps.** No D-Bus, no Rust addon, no process-env surface
  for the agent to `env | grep`.
- **Swappable seam.** The store backend is an interface; an `@napi-rs/keyring`
  backend (the maintained `keytar` successor) is an additive upgrade later
  without a retrofit, following the same discipline as `AuthKind`. On
  headless (Pi's dominant surface) the keychain backend would error "no
  daemon" and fall back to the file anyway, so the file is the honest
  default and at-rest strength is not the budget priority.

### Transcript-safe capture via `ctx.ui` dialogs

**Verified against pi source:** `ctx.ui` dialogs (`input`, `editor`,
`custom`) are a **request/response sub-protocol**, not user messages. They
never flow through the `input` event, `before_agent_start`, or become
`UserMessage` entries. The session file stores `UserMessage` /
`AssistantMessage` / `ToolResultMessage` / `BashExecutionMessage` / custom
`appendEntry` records — dialog responses are not among them. The
extension receives the value as a JS string and **decides whether it
enters agent context.** `examples/extensions/question.ts` demonstrates
the pattern: it captures `result.answer` via `ctx.ui.custom()`, then
*chooses* to put it in the tool result `content`. For `/api secrets`, the
command captures → writes to the `0600` file → returns only `secret
stored for <domain>`; the value never touches a tool result, `pi.sendMessage()`,
or `pi.sendUserMessage()`.

**Three caveats:**

1. **No masked/secret input mode.** `ctx.ui.input()` has no `secret: true`;
   typed text is visible on screen in TUI. This is a shoulder-surf /
   screen-recording risk, **not** a transcript risk — the value is
   transcript-safe either way. Masking is additive later via a `custom()`
   component if the shoulder-surf concern materializes. Read-only key
   scoping (§Read-only & scopes) limits the blast radius of a shoulder-surfed
   key, making unmasked input acceptable for this slice.
2. **Headless modes can't prompt.** `ctx.hasUI` is false in print/JSON
   mode → `ctx.ui.input()` is a no-op. This is why the headless path uses
   direct file write, not a dialog.
3. **RPC clients receive the raw value** in `extension_ui_response.value`.
   The client could log it — that is the client's concern, outside pi's
   transcript control.

At-rest is largely moot on this surface; the budget goes to the
output-channel audit.

## Cookie jar

**Ephemeral, per-session, in-memory, keyed by request URL hostname.**

- The login POST runs once per session (triggered by the footer →
  `api-login`; §Login op & lifecycle). Cookies land in the jar and are
  attached as `Cookie` to subsequent `restGet`/`paginate` calls against
  the same domain.
- **Jar key = the request URL's hostname** (e.g. `api.example.com`), not
  the guide's routing `domains` field and not `apiHost`. Three values can
  differ — `domains: [example.com]` routes, `apiHost: api.example.com`
  is the execution root, and a redirect target may be a third host — so
  the jar must key on the host the cookie was actually set for. `Set-Cookie`
  with a `Domain=` attribute widens within the PSL; bare host cookies are
  host-only. **Scope rule (this slice):** attach a cookie to a request
  only when the jar key (set-by host) equals the request URL hostname
  (strict host-match). eTLD+1 widening is deferred — strict host-match is
  the smaller, safer default and covers the dominant "login on
  `api.example.com`, reads on `api.example.com`" case. Cross-domain
  stripping on redirects (§Cache / SSRF / redirect rules) falls out of
  the same rule for free.
- **Nothing persists.** Cookies vanish on shutdown. No at-rest concern
  this slice.
- **`Path`/`Secure`/`HttpOnly` attributes are intentionally ignored this
  slice.** Strict host-match (above) ignores `Path`, which is more
  permissive — a cookie set on `/login` is sent to `/api/...` on the same
  host, which is the login-then-read case this slice exists to serve.
  `HttpOnly` is irrelevant (no browser / no JS engine reading the jar).
  `Secure` is less relevant than the transport's scheme control — and
  `fetchUrl` already governs scheme. These omissions are deliberate for v1;
  if a recipe forces `Path` scoping or `Secure`-only attachment, that recipe
  brings the narrowing design.
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
| Auth needed + credential **absent** | nudge the user to provision via `/api secrets <domain>` (interactive) or by writing the `0600` file directly (headless) |

The footer is **metadata, never the value.** It is safe under the
output-channel audit. The absent-credential branch is worded to steer the
user to **out-of-band** provisioning channels — the agent is a messenger,
not a credential handler. A "helpful" agent may still ask the user to
paste a key into chat; the footer wording steers away from that but cannot
fully prevent it. The footer must never include the credential value or
the full login response body.

### `api-login` tool (5th host tool)

- **Toolset membership:** `api-login` joins `HOST_API_SPEC`
  (`core/api-toggle.ts:46`, `names: Set([api-guide, api-fetch])` → add
  `api-login`), **not** the learn spec. It is needed in the plain "on"
  state (an authenticated fetch may require a login first); putting it in
  `HOST_API_LEARN_SPEC` would leave it disabled exactly when an auth guide
  needs it. `/api off` cascades it off via the spec's `requires:` chain,
  same as today. The package tool count goes 4 → 5; update
  `packages/pi-lean-host/AGENTS.md` ("Registers **4 tools**" → 5, tool
  list) and the `api-login` registration in `tools/index.ts`.
- **Params:** one required (`domain`) + optional guide selector for
  multi-recipe domains. Minimal schema — the heavy parts (login path,
  body, secret names) live in the guide's `auth.cookie-login` block, not
  the tool call.
- **Behavior:** resolve the guide's `auth.cookie-login` block → read the
  required secrets from the `0600` store (code-injects; never agent-supplied
  params) → POST the login → capture `Set-Cookie` into the ephemeral jar.
  **Non-`cookie-login` guides error out:** calling `api-login` for a guide
  whose `auth.kind` is `none` or `static-key` returns a clear "this guide does
  not use cookie-login auth" error (the `auth.cookie-login` block is absent or
  kind-disallowed by the parser, §Auth contract). No silent no-op — the
  caller learns login does not apply rather than assuming a session was
  established.
- **Output:** a **status line, not the response body.** Login responses
  can echo credentials or session tokens; surfacing the body would violate
  the output-channel audit. The output is e.g. `logged in to <domain>` or
  the error.
- **Reuses op request-shape vocabulary** (`path`/`accept`/`body`) so there
  is no new request-shape schema to learn.
- **Executor location:** the login POST runs through a new
  `postRequest(url, body, headers, opts)` in `core/transport.ts`, sibling
  to `fetchUrl` — same transport layer (UA, charset, 429-retry, timeout);
  the GET-only `restGet`/`paginate` are not retrofitted to emit a POST.
  `Set-Cookie` capture into the jar happens here, in the transport, where
  response headers are visible (the helper contract is header-blind,
  §Existing seams). `api-login`'s tool handler resolves the
  `auth.cookie-login` block, reads secrets from the store, builds the
  body, and calls `postRequest`; it returns the status line, never the
  response body.

### Why no framework-auto-login

Login is **always an explicit `api-login` call triggered by the footer** —
never a silent framework side-effect. This gives a cleaner audit trail
(agent-initiated, logged, recoverable) and avoids the brittle 401-signature
heuristic for expiry detection. 401/403 recovery uses the **same
deterministic mechanism**: `api-fetch`'s footer on an expired session
prompts the agent to call `api-login` again. The framework never guesses
when to re-login from the error signature.

### Session resume

The explicit tool solves the expiry case the framework-auto path would
have left awkward: a session whose cookies have expired (or whose jar was
never populated) can re-establish by calling `api-login`, without
re-invoking the guide. The agent learns the recovery action from the
footer, not from re-reading the guide.

Note that the jar is a module-level map in `transport.ts`, and pi reuses
the cached extension factory across `/resume` (re-invoking the entry
function with the same module-level state, as the existing
`resetToggleModuleState()` / `resetDisabledHelpers()` resets in `index.ts`
attest). So an in-memory jar that is not explicitly cleared **survives
`/resume`** — a resumed session keeps its cookies for the lifetime of the
process, and `api-login` is only needed when they have actually expired
(or were never obtained). This is behavior, not a guarantee: we do not
reset the jar on resume (no `resetCookieJar()` alongside the existing
resets), and we do not persist it, so a fresh process or an explicit
`/api off`→`on` cycle starts empty. Cookies tend to expire, so the
recovery path is the one that matters in practice; the persistence is
just the honest description of where the jar lives.

## Cache / SSRF / redirect rules

- **Cookies → responses private → not cached.** Mirrors the existing
  `hasAuthHeaders` gate. Additive rule: `hasAuthHeaders || hasCookies →
  skip cache`. Any request carrying a `Cookie` (from the jar) or an
  injected `Authorization` (from `secretRefs`) skips the cache.
- **Auth-bearing requests → forced guarded redirects.** Today
  `guardRedirects` is opt-in and only `paginate`'s `nextLink` branch sets
  it; a `restGet` carrying a store-injected `Authorization` that 302s to
  an internal host would follow the redirect with the header attached and
  no SSRF check. The fix is one line in `fetchUrl`: force
  `getWithGuardedRedirects` whenever `hasAuthHeaders` (already computed
  for the cache gate) is true, in addition to the existing
  `opts?.guardRedirects` opt-in:

  ```ts
  } = opts?.guardRedirects || hasAuthHeaders
      ? await getWithGuardedRedirects(url, reqHeaders, startTime, timeout)
      : await singleGet(url, reqHeaders, remaining, redirectAgent);
  ```

  `hasAuthHeaders` fires on any non-`accept` header, which covers literal
  `auth.headers` *and* store-injected `secretRefs` in one test — the
  "merged header set" concern is handled by construction (the flag is
  source-agnostic). The guard itself inspects redirect-target hostnames,
  not headers, so the old "confirm the guard runs on the merged header
  set" framing is dropped: the real question was always whether guarding
  is *enabled* for the request, and for `restGet` it wasn't. No behavior
  change for public/keyless requests (`hasAuthHeaders` is false →
  auto-follow path unchanged); only auth-bearing requests switch to the
  manual guarded loop, and only an actual redirect incurs its cost.
  Update the `guardRedirects` doc comment in `transport.ts` to note
  auth-bearing requests are also forced into the guarded path (for
  header-leak prevention, not initial-URL SSRF).
- **Auth headers on redirects → stripped on cross-domain.** The forced
  `getWithGuardedRedirects` one-liner above closes the SSRF-to-internal
  case (the guard blocks loopback/RFC1918/metadata redirect targets),
  but `getWithGuardedRedirects` today forwards `reqHeaders` — including a
  store-injected `Authorization` — to **every** redirect hop
  (`transport.ts:104-127`, `singleGet` called per hop with the original
  header set). A 302 from `api.example.com` to a **public** partner host
  (`api.partner.com`) would carry the auth header to the partner domain
  with no check: the SSRF guard passes it (public host), but the header
  has leaked cross-domain. The fix is a **host-match gate inside the
  guarded redirect loop**: before forwarding `reqHeaders` to the next
  hop, drop any store-injected `secretRefs` headers (and the
  `Authorization` / `Cookie` pair) when the redirect target's hostname
  differs from the request URL's hostname. Literal `auth.headers` stay
  (they are guide-level, intended for the routing domain);
  store-injected secrets are caller-scoped and must not follow a
  cross-domain redirect. Same strict-host-match rule as the cookie jar
  (§Cookie jar), so one hostname comparison governs both. Update the
  `guardRedirects` doc comment to note auth-bearing requests are also
  forced into the guarded path (for header-leak prevention, not
  initial-URL SSRF) and that the guarded path strips injected secrets
  on cross-domain hops.
- **Cookies on redirects → scoped by domain — stripped on cross-domain**,
  mirroring the auth-header cross-domain rule above. Prevents a session
  cookie leaking to a cross-domain redirect target. (Implementation
  detail: eTLD+1 scoping vs strict host-match is settled at build time;
  the rule is cross-domain stripping either way.)

## Risks

- **Accidental key leak via 401 body / error echo / debug log → flows to
  inference server.** PRIMARY. The output-channel audit must catch every
  path. This is the most-skippable-under-deadline threat; name it in the PR.
- **Response-header echo via `details.headers`.** `api-fetch` emits the
  full response headers as `details.headers` (`tools/api-fetch.ts:243`,
  restGet branch). A server that echoes the auth header in a **response**
  header (e.g. `X-Api-Key: <value>` echoed back, or a `WWW-Authenticate`
  echo that includes the value) leaks the secret to the session file on
  the first authenticated fetch. This is a `secretRefs` (header-secrets)
  output-channel concern, distinct from the `secretQueryRefs` URL/params
  channels — header secrets avoid the URL and params map but still
  traverse this surface. The output-channel audit must scrub or filter
  any response header whose value matches a known secret, or (simpler,
  fail-closed) drop `details.headers` entirely for auth-bearing requests.
  Add a test asserting no secret value appears in `details.headers`.
- **Plaintext-in-guide (`auth.headers`) is an active prompt-leak risk if
  used for real keys.** Must NOT be the keyed path. The `0600`-file store
  - `secretRefs`/`secretQueryRefs` are separate from guide content, and
  the parser/validator keeps literal-vs-reference a schema distinction.
- **Query-param secrets leak via two output paths, not one.** The URL
  (request line, `details.request.url`, TUI render, error echo, paginate
  `urls`) AND the params map (`result.params` → `details.request.params` →
  session file). `secretQueryRefs` ships **only with** both defenses from
  §Output-channel audit — URL redaction at the capture point **and**
  secret injection below the returned params map. The params channel is
  the one a naive "merge the secret into the params map before `buildUrl`"
  implementation leaks to the session file on every authenticated fetch;
  without both, the field is a PRIMARY-defense violation. Path-injected
  secrets are out of scope this slice precisely because their redaction
  story is harder.
- **Helper contract can't see headers → `Set-Cookie` parsing must be
  built-in** to the transport, not a local-helper quirk.
- **Read-only scoping helps but doesn't stop private-data read or quota
  burn** if leaked. Defense-in-depth, not a substitute.
- **A "helpful" agent may ask the user to paste a key into chat.** Footer
  wording steers to out-of-band channels; cannot fully prevent.
- **Footer must be metadata-only** (no credential value, no full login
  response body). Enforced by the shared auth-status helper.
- **Store-injected `Authorization` following a `restGet` redirect.**
  Today `guardRedirects` is `nextLink`-only, so an auth-bearing `restGet`
  that 302s to an internal host would leak the header unguarded. Fixed by
  forcing `getWithGuardedRedirects` when `hasAuthHeaders` in `fetchUrl`
  (§Cache / SSRF / redirect rules) — a one-liner, not a header-set change.
  That closes the **SSRF-to-internal** case. The **cross-domain-to-public**
  case (a 302 to `api.partner.com` carrying the injected `Authorization`)
  is a separate leak: the SSRF guard passes public hosts, so the guarded
  loop alone does not stop it. Fixed by the host-match gate inside the
  guarded loop that strips store-injected `secretRefs` headers on
  cross-domain hops (§Cache / SSRF / redirect rules) — the same
  strict-host-match rule the cookie jar uses.

## Validation / testing notes

Carried by the implementation, not separately designed here:

- **Parser/validator tests** for the new auth fields: `auth.kind:
  cookie-login`, `auth.secretRefs`, `auth.secretQueryRefs`,
  `auth.requires`, `auth.cookie-login`. Literal-vs-reference is a schema
  distinction. Concretely assert the §Auth contract rules: kind↔field
  consistency (`secretRefs` rejected on `kind: none`; `cookie-login`
  block required on `kind: cookie-login`, rejected otherwise; `oauth2`
  rejected at parse with the "not yet implemented" fix),
  `auth.requires` ↔ referenced-name validation (a
  `secretRefs`/`secretQueryRefs`/`cookie-login` body-field name not in
  `auth.requires` is a parse error), and the `secretQueryRefs` ↔
  operation `params` collision rule (a secret param name also in an
  op's `params` map is a parse error).
- **Output-channel audit tests** — the security-critical path. Assert no
  result or error path echoes a secret value: a 401 body, a request-header
  echo, a debug log, the login response body, and a **response-header
  echo in `details.headers`** (`tools/api-fetch.ts:243`) are all scrubbed.
  The response-header case is the one a server that echoes the auth
  header (e.g. `X-Api-Key: <value>` in the response) would leak to the
  session file; assert no secret value appears in `details.headers` for
  an auth-bearing request (scrub matching headers, or drop
  `details.headers` entirely for auth-bearing requests). This is the
  work most likely to be skipped under deadline; ship it with the
  first keyed guide, not "later."
- **Query-param secret output-channel tests** (for `secretQueryRefs`) —
  the two channels in §Output-channel audit, both security-critical:
  - *URL channel:* assert the redacted URL (`?key=***`) is what every
    emit site carries: `formatRequestLine`, `details.request.url`,
    `renderResult`, `formatHelperError`, and `PaginateResult.urls` —
    including a server-supplied `nextUrl` that itself contains the secret
    param (the `nextUrl` capture point must redact, not just `buildUrl`).
    Negative: a non-secret query param stays intact.
  - *Params channel (the one a naive impl misses):* assert
    `result.params` from `restGet` and `paginate`, and therefore
    `details.request.params` in `api-fetch`'s result, **never contains the
    secret value** for a guide with `secretQueryRefs`. The secret key must
    be absent from the returned map entirely (not present-but-redacted) —
    the defense is injection-below-the-returned-map, not post-hoc
    scrubbing. This test is the proof that the return-contract change to
    `restGet`/`paginate` actually holds; without it the leak is silent
    (no type error, no runtime error) and ships to the session file.
- **Cookie jar tests** — `Set-Cookie` capture, `Cookie` attach on
  subsequent calls, cross-domain stripping on redirects, non-cacheability
  of cookie-bearing responses.
- **`api-login` tests** — store-injected credentials (never agent params),
  status-line output (never the response body), cookies land in the jar.
- **`checkAuth` session-guard tests** — for `kind: cookie-login`, a fetch
  with no live session in the jar throws the recoverable "call api-login"
  error and never reaches the network; `none`/`static-key` ignore the jar
  and pass through. Covers both `restGet` and `paginate` callers (one guard,
  two callers).
- **Cookie-jar scope tests** — `Set-Cookie` capture under the request URL
  hostname key; `Cookie` attached only on strict host-match; a bare
  host-only cookie is not sent to a sibling host (`api.example.com` ≠
  `www.example.com`); cross-domain redirect strips the cookie (same rule).
- **Footer tests** — all four states (none / auth-ok / call-api-login /
  nudge-provision), via the shared auth-status helper, covering both
  `api-guide` and `api-fetch`. Include the `cookie-login` "no session yet"
  branch (credential present, jar empty → prompt `api-login`).
- **SSRF verification** — three cases: (a) a malicious `nextUrl` carrying
  a store-injected `Authorization` is blocked by the `nextLink` guard
  (existing path); (b) a `restGet` carrying an injected `Authorization`
  that 302s to an internal host is blocked because `hasAuthHeaders` forces
  the guarded redirect path (the new one-liner in `fetchUrl`); (c) a
  `restGet` carrying an injected `Authorization` that 302s to a **public**
  cross-domain host (`api.partner.com`) has the store-injected `secretRefs`
  headers stripped at the cross-domain hop (the new host-match gate in the
  guarded loop, §Cache / SSRF / redirect rules) — assert the auth header
  does not reach the partner host. In (a) and (b) assert the auth header
  does not reach the internal host; in (c) assert the literal `auth.headers`
  (guide-level) may still forward while store-injected secrets do not.
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
