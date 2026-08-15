# pi-lean-host — Authenticated APIs (static-key retrieval)

> Design doc for the **first authenticated-API slice**: static-key retrieval
> (header + query-param secrets). Companion to and
> partial supersession of
> [`api-secrets-roadmap.md`](./api-secrets-roadmap.md) (the auth/token track)
> and [`api-stateful-sessions.md`](./api-stateful-sessions.md) (the stateful
> ladder; its cookie rung stays open — see §Auth status footer).
>
> Status: **design complete; all three sprints of the implementation plan have
> landed** (secrets store + header/query-param injection + the output-channel
> audit + `api-probe` authoring-loop auth). Deferred items are named, not
> hand-waved.

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
- **`api-stateful-sessions.md`** — **not superseded on the cookie rung.**
  Its rung 3 (additive cookie jar / login-POST) was initially in scope but
  is **deferred** by research-plan R5 (no real non-TOS-violating candidate;
  §Auth status footer). Its rung 1 (opaque-token server-side session) is
  **carried forward as supported today** — the server holds result-set
  state, the client carries an opaque token as a query param across calls;
  tokens are just params, so the stateless transport already supports it
  with no core change and no auth-store involvement (the tokens are
  public, not secrets). This doc realizes static-key retrieval, names the
  opaque-token pattern as in-scope (§Goals & scope), and leaves the cookie
  gap open.

## Goals & scope

### In scope (this slice)

- **Static-key retrieval** — keyed read APIs that authenticate via a header
  or query-param secret (e.g. `X-Api-Key`, `Authorization: Bearer`, `?key=`).
  Real credentials live in a store, never in the guide.
- **Opaque-token server-side sessions (read-only)** — APIs where the server
  holds result-set state and the client carries an opaque token as a query
  param across calls (e.g. NCBI E-utilities History server: `esearch` with
  `usehistory=y` returns `WebEnv`/`query_key`, then `esummary`/`efetch`
  pass them back). **Already supported by the stateless transport — tokens
  are just params**, no core change, no auth-store involvement (the tokens
  are public, not secrets). A guide documents the two-step flow. Named
  in-scope here so guide authors do not exclude it as "mutating": the
  `usehistory` read flow uploads a result set to the server's History
  server but retrieves records read-only — it is information retrieval
  via server-side state, not a write/mutation of the underlying database.
  (The separate `epost` op, which uploads an arbitrary UID set, *is* a
  mutation and stays excluded.) See
  [`api-stateful-sessions.md`](./api-stateful-sessions.md) rung 1.

### Deferred (named, not hand-waved)

- **OAuth2 (all flows)** — client-credentials, auth-code+redirect,
  refresh-token machinery. The `auth.kind: "oauth2"` seam stays in the
  schema, unrealized, as today.
- **General mutations / write gate** — `POST`/`PUT`/`PATCH`/`DELETE` for
  authoring or automation. The mission is information-retrieval; the
  transport stays GET-only.
- **Cookie-login (jar + `api-login`)** — deferred in full (§Auth status
  footer); the cookie jar, persistent or session-scoped, is part of that
  deferred path.
- **OS-keychain at-rest** — `@napi-rs/keyring` (the maintained `keytar`
  successor) as a store backend. The store interface is a swappable seam;
  the keychain backend is additive without a retrofit.

## Existing seams (what the code already has)

The design is additive to seams that already exist on purpose:

- **Auth dispatch point.** `AuthKind = "none" | "static-key" | "oauth2"`
  (`core/api-guide-types.ts`). `checkAuth(auth)` (`core/helpers.ts:315`)
  realizes only `none`; the other two throw "not supported." This slice
  realizes `static-key`. (`cookie-login` is **not** added — the cookie path
  is deferred; R5, §Auth status footer.) The seam makes the build additive,
  not a retrofit.
- **`auth.headers` already merged into every fetch** (`helpers.ts`) — the
  **plaintext-in-guide** path for demo keys (`X-Api-Key: DEMO_KEY`). This
  stays as-is for literal values safe to commit. It is **not** the path for
  real credentials.
- **Stateless per-request transport.** `fetchUrl` (`core/transport.ts`)
  holds no session; `sessionKey` is used only for spill filenames.
  Auth-header-bearing responses are already excluded from cache (the
  `hasAuthHeaders` gate) because they are private to the caller.
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
  only. Neither can inspect response headers — so the response-header echo
  (a server echoing the auth header) is handled by the output-channel
  audit, not by a helper.

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

## What "mutations" means, and why none are in scope

HTTP-verb line: `GET`/`HEAD`/`OPTIONS` = read; `POST`/`PUT`/`PATCH`/`DELETE`/
action-endpoint = mutate. `pi-lean-host` ships only `restGet`/`paginate`
(both GET), so every non-read verb is structurally unreachable today.

Agent-research mutation use cases, honestly surveyed: (1) provenance —
agent files findings as it goes; (2) setup-then-query — create a temp
resource then read; (3) automation-as-goal — merge PRs, send messages
(a different product); (4) login/session-establishment POST — `POST
/login` to get a session cookie, then reads (a **consumer web-login**
pattern).

**None are in scope.** The mission is information retrieval; the transport
stays GET-only. (4) was initially considered as an auth mechanism, but the
cookie-login path it requires is deferred — the only realistic candidates
are TOS-gated consumer web logins (§Auth status footer). Cases (1)–(3)
stay out of scope; if a future slice admits general mutations, that is a
separate, scoped decision.

## Read-only & scopes (no scopes field)

Because the transport is GET-only (no non-read verb, not even a login
POST), **no write-gate consumer exists** and there is **no `scopes`
array** in the schema. Read-only is a **plugin invariant** enforced
structurally by "the only `via`s are GET `restGet`/`paginate`." The
defense-in-depth lever (provision read-only keys) stays **behavioral** —
code-injects + output-channel audit + documentation guidance — not
schema-enforced.

This retires the roadmap's plan to ship `scopes: ["read"]` with
`static-key`. Under the information-retrieval premise, `scopes` is
speculative schema for a mission that may never arrive.

## Auth contract (guide-author)

**Schema-driven literal-vs-reference distinction. The value never lives in
the guide.**

- **`auth.kind`**: `"none" | "static-key"` (`oauth2` stays in the type,
  unrealized, as today).
- **`auth.headers`**: **literal values only** — demo keys, rate-limit
  tokens safe to commit. Not the path for real credentials.
- **`auth.secretRefs: Record<headerName, secretName>`**: store-backed
  header injection. "Inject the secret named `api_key` into header
  `X-Api-Key`." Value resolved from the `0600` store at fetch time, never
  in the guide.
- **`auth.secretQueryRefs: Record<paramName, secretName>`**: parallel for
  query-param injection (`?key=<secret>`).
- **`auth.requires: string[]`**: declares the secret names the guide
  **hard-requires** (e.g. `auth.requires: [api_key]` for static-key). If a
  required secret is absent from the store, `api-fetch` **fails closed
  before the request** — no unauthenticated fetch that might return
  partial data the agent mistakes for complete. The error message tells
  the agent to inform the user: *"`<domain>` requires credential
  `<name>`, not in the store. Run `/api secrets <domain>` (interactive)
  or write the `0600` file (headless)."* The agent relays it; the
  footer (§Auth status footer) nudges the same way.
- **`auth.optional: string[]`**: declares secret names the guide can
  **use if present and skip if absent** — for APIs that work
  unauthenticated but grant a higher rate limit or extra fields with a
  token (e.g. GitHub: 60 req/hr unauth, 5000 with token). If an optional
  secret is absent, `api-fetch` **proceeds without injection** (no error,
  no nudge — the footer reports `auth: optional (not provisioned)`). If
  present, it is injected exactly like a required secret. Lives under
  the `auth` block next to `auth.requires`. **No `scopes` field.**

  The required/optional split is the answer to "what does `api-fetch` do
  when a secret is absent" — it is not one behavior, it is two, and the
  schema expresses which. A flat `requires` list with no `optional`
  cannot model the GitHub case: marking the token required blocks the
  unauthenticated path the API allows; omitting it from the ref maps
  loses injection entirely. Both are wrong.
- **Parser/validator** enforces: literal-vs-reference is a **schema
  distinction** (a header in `auth.headers` and a key in `auth.secretRefs`
  are different fields), not a string-parsing convention. Easy to
  document, validate, and surface in the footer. Concretely, `validateAuth`
  (`core/parse-api-guide.ts:389`) gains these rules (all fail-closed with a
  `fix:` hint):
  - `auth.kind` must be one of `none | static-key` (`oauth2` stays in the
    TS type but is **rejected at parse time** as "not yet implemented,"
    matching today's `checkAuth` throw — the type seam and the parse set
    diverge on purpose).
  - **Kind↔field consistency:** `secretRefs` / `secretQueryRefs` are
    rejected when `kind: none` (a none guide has no secrets).
  - **`auth.requires`/`auth.optional` ↔ referenced names:** every secret
    name appearing in `secretRefs` or `secretQueryRefs` must be declared
    in `auth.requires` ∪ `auth.optional` (catches a typo'd
    `api_key`/`apikey` mismatch at parse time, not at fetch time). A name
    listed in **both** `requires` and `optional` is a parse error
    (ambiguous). Names in `requires` or `optional` with no referrer are
    allowed (documentation-only listing is harmless).
  - **`secretQueryRefs` ↔ operation `params` collision:** a secret
    param name (a key of `auth.secretQueryRefs`) that also appears in
    any operation's `params` map is a parse error. The agent must not be
    able to supply a value for a param that is secretly injected —
    either the agent's value collides with the secret or silently
    overrides it, both unsafe. The guide author marks the param
    `secretQueryRefs`-only; the agent never sees it as a settable param.
    (Path-injected secrets, when shipped, get the same rule against
    path-template fields.)
  - **`passthrough` ops are not banned by this rule — the defense is
    runtime, in `buildQueryParams`.** The static `params` collision
    check above only inspects the declared `params` map, but an op with
    `passthrough: true` (`core/api-guide-types.ts`, forwarded in
    `core/helpers.ts` `buildQueryParams`) accepts *any* caller-supplied
    key not in that map onto the query string. A parse-time blanket ban
    (`passthrough` ⊥ `secretQueryRefs`) would block the legitimate
    combination — an open param surface *and* a secret query param on
    the same op (CKAN, OAI-PMH) — for a problem that is a one-line
    runtime guard. So `passthrough` + `secretQueryRefs` is **allowed**;
    the guarantee is enforced in the passthrough branch of
    `buildQueryParams`, which skips `secretQueryRefs` keys (code-injected,
    not agent-settable) exactly as it already skips path params and
    declared `params`. The agent's value for a secret name is silently
    dropped *before* the returned map exists; the Channel 2 injection
    fills it afterward. `restGet` and `paginate` both route through
    `buildQueryParams`, so both branches are covered by construction —
    no per-call-site defense. (See §Output-channel audit for
    `secretQueryRefs`, Channel 2.)
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
    // `set` replaces *all* values for `k`, so a multi-value `?k=a&k=b`
    // param is fully redacted on the first enumeration of `k`; the
    // second enumeration is a no-op. URLSearchParams has no per-value
    // replace, and secret params are single-value by convention.
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
returned is the pre-injection one. The same layer also closes the
`passthrough` hole: the passthrough branch of `buildQueryParams` skips
`secretQueryRefs` keys (code-injected, not agent-settable), so an agent
that supplies a secret param name on a `passthrough` op has its value
silently dropped before it can reach the query string or race the
injection — see §Auth contract, `passthrough` ops.

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
caching (`hasAuthHeaders` → skip, extended to **all** injected auth —
header *and* query-param — via the broader `hasAuth` flag in §Cache /
SSRF / redirect rules), so the redacted URL is never used as a cache
key. A `secretQueryRefs`-only guide is covered by `hasAuth`, not by the
header-only `hasAuthHeaders`.

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

### `/api secrets` no-arg list — store-driven, not registry-driven

`/api secrets` (no argument) walks the store dir
(`~/.pi/agent/pi-lean-host/secrets/*.json`) and lists every file that has
at least one entry, with the stored secret **names** nested under each
domain. If the store dir does not exist yet (fresh install, nothing
provisioned), the no-arg list prints `(no secrets stored)` and creates
the directory lazily on the next *write* — the list itself never
mkdirs, so a read-only `$HOME` or a dry-run `/api secrets` invocation
never has side effects:

```text
archive.org:
  - api_key
github.com:
  - token
```

This is **purely store-driven** (filenames + object keys) — it does not
need the guide registry and works even before any guide is installed.
Domains whose guide declares `auth.requires`/`auth.optional` but have
nothing stored are **not listed** (no file or empty file). Surfacing
declared-vs-stored gaps is the per-domain `<domain>` view's job, not the
no-arg list's. Secret **values** are never shown — only names.

### `/api secrets <domain>` reuse — the registry + footer, not the redactor

A `/api secrets <domain>` listing shows secret **names** (`api_key`)
and presence, never the value, so it does **not** call
`redactSecretParams` — a shared "redaction module" would have one real
consumer each, which is the wrong abstraction. What *is* shared:

1. **The secret-name source of truth** — URL scrubbing needs the
   `secretQueryRefs` keys for the guide; the per-domain listing needs the
   guide's `auth.requires` + `auth.optional` + the store's filenames. The
   no-arg list (above) needs only the store's filenames + object keys —
   no registry. One registry, two *registry-driven* consumers (URL
   scrubbing + per-domain detail); the no-arg list is a third,
   store-only consumer.
2. **The auth-status helper** (§Auth status footer) — the footer's
   "credential present / absent" branches are the presence check a
   `/api secrets` listing wants. `/api secrets <domain>` is the footer's
   presence logic lifted into a standalone command. That is the genuine
   reuse, and it is already in this design.

### `/api` command surface — the `secrets` subcommand

`/api secrets [<domain> [<name>]] [--delete]` is a **new subcommand** on
the existing `/api` command (`core/api-toggle.ts` switch, today `on | off |
learn | status | helpers | bare`). Four forms: no-arg lists
(§`/api secrets` no-arg list), `<domain>` is assisted entry or the
per-domain detail view (§Secrets store), `<domain> <name>` is manual
entry, and `--delete` is destructive removal (detailed in the Removal
bullet below). `--delete` is reserved and cannot be used as a secret
name. It is
interactive capture (§Transcript-safe capture), not a toolset actuation,
so:

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
- **Headless.** `ctx.hasUI` false → entry prints the direct-file-write
  instructions (§Secrets store) instead of prompting; deletion executes
  directly with no confirm (§Secrets store, Removal). Neither path prompts
  or hangs waiting on a dialog that will never come.

## Secrets store

**Dialog / file-write input → `0600` file store, keyed by domain.** No
env-var middleman — `PI_LEAN_HOST_KEY_<DOMAIN>` is dropped entirely.

- **Entry (interactive — TUI/RPC).** Two forms, both writing directly to
  the store and returning a metadata-only status line
  (`secret stored for <domain>/<name>`):
  - **Assisted — `/api secrets <domain>`.** Requires a registered guide
    for `<domain>`. If the guide declares exactly one secret name
    (`auth.requires ∪ auth.optional`), skip the picker and prompt for
    that name directly via `ctx.ui.input()` — the common case, one round
    trip. If it declares multiple, show a `ctx.ui.custom()` picker
    listing each name with its provisioned state (`api_key (set)` /
    `apiSecret (not set)` — the auth-status helper's presence check,
    reused); the user picks one, then `ctx.ui.input()` for the value.
    Re-selecting a `set` name overwrites — the rotate-key flow, no
    separate rotation command (removal is the one separate lifecycle
    modifier; see `--delete` below). **One secret per invocation** (no
    fill-all loop):
    a loop risks annoying a user who has already set some keys midway,
    and explicit re-invocation is cheap.
  - **Manual — `/api secrets <domain> <name>`.** The escape valve for the
    chicken-and-egg case (provision a key *before* the guide that
    declares its name is written). If a guide is registered, `name` is
    validated against `auth.requires ∪ auth.optional` (fail-closed on
    typo). If no guide is registered, the name is accepted free-form.
    Captures via the same `ctx.ui.input()`.
  Both work in TUI and RPC via the `extension_ui` request/response
  sub-protocol (§Transcript-safe capture).
- **Entry (headless — print/JSON/CI).** `ctx.hasUI` is false in
  print/JSON mode, so the dialog is unavailable there. The deployment
  writes the `0600` file directly before pi starts (a one-line
  `install -m 600` + `cat >` step or a tiny CLI helper). No env involved.
- **Removal — `--delete`.** Two shapes, both removing the `0600` file's
  last entry and pruning the now-empty file (so the domain no longer
  appears in `listDomains()` / the no-arg list):
  - **Single — `/api secrets <domain> <name> --delete`.** Drops one
    secret. The name is explicit, so this runs **without confirmation**
    (mirroring the manual-entry asymmetry: a typed name is deliberate).
    Missing name or missing domain → fail-closed error message, no
    mutation. The value is never echoed in the confirmation/status line
    (the same metadata-only contract as entry).
  - **Whole-domain — `/api secrets <domain> --delete`.** Drops every
    secret for the domain. This is broad enough to warrant an
    **interactive confirm** (`ctx.ui.custom()` yes/no) when `ctx.hasUI`
    is true; an empty or already-absent domain is a no-op with a status
    line, not an error.
  **Headless deletion** (`ctx.hasUI` false): **no confirmation, no hang**
  — both shapes execute directly. This matches the entry contract (the
  headless path never prompts) and the deployment reality (headless
  stores are typically written and torn down by the deployment script,
  not by a human at a confirm dialog). A scripted teardown that wants a
  guard simply checks `listNames` before calling `--delete`.
  Like entry, `--delete` is a peer of `status`/`helpers`/bare, so the
  focus-mode guard does not apply (it writes no `{enabled}` entry).
- **Persistence.** `~/.pi/agent/pi-lean-host/secrets/<domain>.json` at
  mode `0600`. The file is the single store; both input channels write to
  it. **Schema: a flat JSON object keyed by secret name → value**, e.g.
  `{ "api_key": "…", "api_secret": "…" }` — keyed by the `secretName` in
  the guide's `auth.secretRefs`/`auth.secretQueryRefs` ref maps, not by
  header/param name. A domain may hold several named secrets (injected
  into different headers/params); one file per domain holds them all.
  **Pruning:** when `--delete` removes a domain's last entry, the now-empty
  file is unlinked so the domain disappears from `listDomains()` / the
  no-arg list — empty domain files are never left behind.
- **Read.** `api-fetch` and `api-probe` (§api-probe — store-backed auth
  for the authoring loop) read the file at fetch/probe time. The value
  never enters the agent's context as a string (code-injects; §Threat
  model).
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

## api-probe — store-backed auth for the authoring loop

**The gap.** `api-probe` is the authoring-loop tool (shape-discovery
before a guide exists), but today it calls
`fetchUrl(url, { headers: { accept }, fresh: true })`
(`tools/api-probe.ts:216`) — no auth injection, and `ProbeOptions`
accepts only `accept` + `tryPrefixes`. Header-auth APIs (the common
case) cannot be probed through the sanctioned transport without pasting
the key into the probe call's `params` — a transcript-exposed one-time
leak, and for header auth not even that works (no header surface).
Since the library's purpose is helping users author their own API
guides, a broken authoring loop for header-auth is a core pain point,
not an edge case. `api-probe` gains store-backed auth.

**Design — the guide's `auth` ref maps, inline.** `api-probe` grows an
optional `auth` parameter mirroring the guide's injection fields only
(no `kind`/`requires`/`optional` — those are guide-level metadata):

```ts
auth?: {
  secretRefs?: Record<string, string>;      // headerName  → secretName
  secretQueryRefs?: Record<string, string>; // paramName   → secretName
}
```

The probe resolves each `secretName → value` from the `0600` store and
injects. The value never enters the transcript — only header/param
**names** and secret **names** do, neither of which is secret. Store
file selection: an optional `domain` parameter (defaults to the
`apiHost` hostname) names the `<domain>.json` file — the same file
`api-fetch` reads once the guide is written, so provisioning during
authoring and consumption after authoring share one store entry.
`domain` is **agent-visible**: it is added to `api-probe`'s `Type.Object`
parameter schema (today the probe takes only `apiHost` + `path` + `accept`

- `tryPrefixes`), so the agent can override it when the API host's
hostname is not the key under which the secret was provisioned (e.g.
probing `api.github.com` against a `github.com` store entry).

**Store-miss path — report the miss, do not fail closed.** The inline
`auth` block carries no `requires`/`optional` metadata (those are
guide-level, and the guide does not exist yet), so the probe has no
schema field that says what to do when a named secret is absent from
the store. Three ways a miss happens: the `<domain>.json` file does
not exist (author has not run `/api secrets <domain>` yet), the file
exists but the secret-name key is wrong (`github_token` vs `token` —
a typo the guide parser's `requires ∪ optional` consistency check
would have caught, but the probe has no such check), or the `domain`
resolved to a different file than where the secret was provisioned
(e.g. probed `api.github.com` but provisioned under `github.com`).

The probe does **not** fail closed on a miss (contrast `api-fetch`'s
`auth.requires` absent → error before the request, §Auth contract):
`api-probe` is a human-in-the-loop authoring tool, not a production
fetch path, and the author is right there to read a clear note and
re-provision — partial data mistaken for complete is not the failure
mode it is for `api-fetch`. Instead the probe **fetches anyway with
the missing header/param omitted** and reports the miss in the note.
This requires distinguishing two cases in `fetchOne`'s status-note
branch (`tools/api-probe.ts:222`, today a single `401 || 403` arm
that always appends `(guide is auth:none)`):

- **No `auth` block passed** → keep the existing wording: `401 —
  requires authentication? (guide is auth:none)`. The probe genuinely
  attempted no auth; the hint is accurate.
- **`auth` block passed but a named secret did not resolve** → new
  wording naming the miss: `401 — auth requested but secret
  "<secretName>" not found in store for domain "<domain>"`. The
  stale `(guide is auth:none)` text **must not** fire here — it is
  now false (auth *was* attempted) and sends the agent toward the
  anti-pattern this whole design exists to kill: pasting the key into
  the probe's `params` (a transcript-exposed leak) or concluding the
  endpoint is broken.

The non-4xx miss is covered by the same `auth`-block presence check:
a 200 with a missing secret is still a successful shape probe, but the
note should record `auth: partial — secret "<name>" not in store` so
the author notices before copying the ref map into `guide.md`.

**The inline refs are the guide's auth draft.** The authoring loop is:
probe with inline `auth.secretRefs`/`auth.secretQueryRefs` → confirm
shape → write `guide.md` copying the same ref maps verbatim into
`auth.secretRefs`/`auth.secretQueryRefs`. One source of truth; the
probe call's `auth` block is the draft of the guide's `auth` block,
the same paste-and-go pattern `api-probe` already uses for the draft
YAML op block.

**Output-channel audit — reused, not re-derived.** The probe emits
`details.url`/`finalUrl` and a `raw` body slice; with
`secretQueryRefs` the URL must be redacted and the secret injected
below the returned `params`. This is exactly the two-channel defense
from §Output-channel audit for `secretQueryRefs` — same
`redactSecretParams`, same inject-below rule, applied at the probe's
`fetchUrl` call site. Header secrets are cleaner on the probe than on
`api-fetch`: the probe does not emit response headers (no
`details.headers` surface), so the response-header echo channel from
§Risks does not exist for `api-probe`. The `raw` body slice could echo
a server-reflected secret, but that is the shared server-echo risk
(covered for `api-fetch` too), not a probe-specific channel.

**Cache + redirects.** `api-probe` already passes `fresh: true`
(bypasses the ETag cache), so the cache-skip concern from §Cache / SSRF
/ redirect rules does not apply — the probe never caches. Redirect
forcing (`hasAuth`) does apply and should be set when `auth` is
non-empty, for the same SSRF reason as `api-fetch`.

**Secret-name discovery — the bootstrap gap (learn-only list mode).**
There is a second, separate gap in the authoring loop that store-backed
auth does not close: the agent's chicken-and-egg problem when a user
pre-provisions a key. `/api secrets <domain> <name>` (the manual-entry
escape valve, §`/api` command surface) lets a user stash a key under a
name of their choosing before any guide exists. The agent authoring the
guide invents its own `secretName` (say `api_key`), writes the inline
`auth.secretRefs` ref map, probes — and on a store miss gets the miss-note
from the path above. But the miss-note names the secret the agent asked
for, not the one sitting in the store. The agent has **no programmatic
way** to learn that `coingecko-key` is already provisioned, because the
only names-listing surface (`/api secrets`) is a user-typed slash
command: pi runs extension commands before agent processing, so the
agent never invokes `/api secrets` — it can only call the four
registered tools, none of which surface stored names.

The fix is one tool, two modes — not a new tool. `api-probe` gains an
optional `listSecrets: true` parameter, **gated to learn mode**
(`learnToolsEnabled`). When set, the probe short-circuits the fetch and
returns the provisioned secret names for `domain` (defaulting to the
`apiHost` hostname) via the store's existing `listNames(domain)` — names
only, never values, reusing the names-only contract the store already
enforces. No new tool, no new plumbing: `api-probe` already takes the
`domain` parameter (this slice) and already does store reads for its
auth injection; list mode is a second mode on the same instrument.

The return carries a `secrets` block on `ProbeResult`:
`{ domain, provisioned: string[], declared?: string[] }`. `declared` is
populated when a guide is already registered for the domain (from
`auth.requires ∪ auth.optional`), so the agent sees provisioned-vs-
declared gaps in one call — the same gap view `/api secrets <domain>`
offers the human, now reachable by the authoring agent. Absent a
registered guide, `declared` is omitted and only `provisioned` is
returned (the common pre-guide case). The fetch fields
(`url`/`status`/`shape`/`draft`/`raw`) are empty in list mode.

**Orphan view (no `domain`, no `apiHost`).** A bare `listSecrets` call
(no target) additionally surfaces the **unscoped** store domains — those
provisioned but not scoped to any registered guide
(`unscopedStoreDomains()`, names only): the authoring-bootstrap and
post-flip-migration-cleanup view. This is the inverse of the per-domain
gap view (it lists domains whose *store* entries have no guide, rather
than a guide's declared-versus-stored gap). It emits no URL, params, or
body, so it carries the same names-only, no-leak invariant as the
per-domain list.

The learn gate is **hard**, not advisory. `/api on` (non-learn) calls
with `listSecrets: true` are refused with a one-line "learn mode only"
note and do not touch the store. In normal use the agent has no business
enumerating the secrets store: discovery is an authoring act,
provisioning is a human act, and the split is the same one that gates
`api-learn` and `api-probe` themselves to learn mode.

List mode emits no URL, no params, no body — so the two output-channel
defenses for `secretQueryRefs` (§Output-channel audit) and the
probe-local 401-body scrub do not apply. The only emit is the names
array, which is names-only by the store contract; there is no value to
leak. This is why list mode is safe to expose to the agent at all, and
why it does not need its own audit beyond the names-only invariant.

## Auth status footer (shared auth-status helper)

Every `api-guide` and `api-fetch` result against an auth-bearing guide
carries a deterministic, state-aware footer, computed by **one shared
auth-status helper** used by both tools (the logic lives in one place, not
duplicated):

| State | Footer |
|-------|--------|
| No auth needed | (nothing) |
| Auth required + credential present | `🔑 auth: ok` |
| Auth required + credential **absent** | `🔑 auth: requires <name> — not provisioned. Run /api secrets <domain>.` — nudges out-of-band provisioning |
| Auth optional + credential present | `🔑 auth: ok (optional provisioned)` |
| Auth optional + credential **absent** | `🔑 auth: ok (optional <name> not provisioned — unauthenticated; provision with /api secrets <domain> for higher limits)` — informational, no nudge, no error |

The footer is **metadata, never the value.** It is safe under the
output-channel audit. The required-absent branch is worded to steer
the user to **out-of-band** provisioning channels — the agent is a messenger,
not a credential handler. A "helpful" agent may still ask the user to
paste a key into chat; the footer wording steers away from that but cannot
fully prevent it. The footer must never include the credential value.

> **`hasAuth` is per-request, not per-guide.** The cache-skip and
> redirect-forcing gates (§Cache / SSRF / redirect rules) key on whether
> *this call* actually injected a secret, not on whether the guide
> *declares* one. This matters for `auth.optional`: an optional-secret
> guide fetched unauthenticated (token absent) has `hasAuth=false` and
> **is** cached under the bare URL — correct, that is the unauthenticated
> state. The moment a token is provisioned, the next call injects it,
> `hasAuth=true`, the cache is **skipped on read**, and a fresh
> authenticated fetch runs. The stale bare-URL entry is never read again
> (it just ages out via LRU). No cache-clear-on-login side effect is
> needed — and a global clear would be overreach (the cache is URL-keyed,
> shared across guides), while a domain-scoped clear would be new code
> for a problem already solved by the per-request flag. Do **not** cache
> the guide-level "has optional auth" flag and use it for `hasAuth`;
> that is the one mistake that would create the stale-authenticated-read
> bug a login-clears-cache hack would be reaching for.

> **Cookie-login (A3/A4) — no cookie-login path this slice.** Research-plan
> R5: the only realistic candidates are consumer web-app logins whose
> automated login is TOS-gated — a path not intended for these APIs. The
> `oauth2`-style type seam (§Existing seams) remains, so an api-key-based
> session-cookie API can be adopted non-breaking in a later slice.

## Cache / SSRF / redirect rules

- **Auth-bearing responses → private → not cached.** The existing
  `hasAuthHeaders` gate (any non-`accept` header, incl. store-injected
  `secretRefs`) skips the cache for auth-bearing requests.
- **`hasAuthHeaders` doesn't cover `secretQueryRefs`-only guides — use a
  broader `hasAuth` flag.** `hasAuthHeaders` checks only for non-`accept`
  request *headers*; a guide using only `secretQueryRefs` (query-param
  secrets, no `secretRefs`, no literal `auth.headers`) has
  `hasAuthHeaders === false`, so today its authenticated response *is*
  cached (private, potentially secret-bearing body held in memory, served
  stale after a key rotation) and its redirects auto-follow up to 5 hops
  with no SSRF check (the secret doesn't follow the redirect — `Location`
  is a fresh URL — but the agent can still reach an internal host via
  redirect through an authenticated endpoint). Both gates must key on
  header secrets *and* query-param secrets. Introduce `hasAuth` (or pass
  an explicit `isAuthenticated: boolean` to `fetchUrl`), true when
  *either* header secrets *or* query-param secrets are injected, and use
  it for both cache-skip and redirect-forcing below. The laziest
  plumbing: compute it in `fetchUrl` from the already-merged `reqHeaders`
  (non-`accept`) **and** a new `opts.hasQuerySecret: boolean` set by
  `helpers.ts` when the op's `auth.secretQueryRefs` injected any params —
  no new transport-layer type, one extra boolean threaded through
  `fetchWithOpts`.
- **Auth-bearing requests → forced guarded redirects.** Today
  `guardRedirects` is opt-in and only `paginate`'s `nextLink` branch sets
  it; a `restGet` carrying a store-injected `Authorization` that 302s to
  an internal host would follow the redirect with the header attached and
  no SSRF check. The fix is one line in `fetchUrl`: force
  `getWithGuardedRedirects` whenever `hasAuth` (the broader flag above,
  already computed for the cache gate) is true, in addition to the
  existing `opts?.guardRedirects` opt-in:

  ```ts
  } = opts?.guardRedirects || hasAuth
      ? await getWithGuardedRedirects(url, reqHeaders, startTime, timeout)
      : await singleGet(url, reqHeaders, remaining, redirectAgent);
  ```

  `hasAuth` fires on any non-`accept` header **or** an injected
  query-param secret, which covers literal `auth.headers`, store-injected
  `secretRefs`, *and* `secretQueryRefs`-only guides in one test — the
  "merged header set" concern is handled by construction (the flag is
  source-agnostic). The guard itself inspects redirect-target hostnames,
  not headers, so the old "confirm the guard runs on the merged header
  set" framing is dropped: the real question was always whether guarding
  is *enabled* for the request, and for `restGet` it wasn't. No behavior
  change for public/keyless requests (`hasAuth` is false →
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
  (`transport.ts:259`, `singleGet` called per hop at `transport.ts:273`
  with the original header set). A 302 from `api.example.com` to a **public** partner host
  (`api.partner.com`) would carry the auth header to the partner domain
  with no check: the SSRF guard passes it (public host), but the header
  has leaked cross-domain. The fix is a **host-match gate inside the
  guarded redirect loop**: before forwarding `reqHeaders` to the next
  hop, drop any store-injected `secretRefs` headers (and the
  `Authorization` header) when the redirect target's hostname
  differs from the request URL's hostname. Literal `auth.headers` stay
  (they are guide-level, intended for the routing domain);
  store-injected secrets are caller-scoped and must not follow a
  cross-domain redirect.

**Plumbing (the under-specified part):** `getWithGuardedRedirects`
(`transport.ts:259`) receives all headers as one merged `reqHeaders` map
and calls `singleGet` per hop with that original set (`transport.ts:273`) —
it cannot, on its own, tell a store-injected `secretRefs` header from a
literal `auth.headers` entry. The laziest plumbing that preserves the
"literal stays, injected goes" rule: `helpers.ts` passes a
`secretHeaderNames: Set<string>` alongside `reqHeaders` (populated from
the keys of the `secretRefs` map it just resolved from the store), and
the cross-domain hop strips `secretHeaderNames ∪ {"authorization"}`.
The threading is a new optional field on `FetchOptions`
(`secretHeaderNames?: Set<string>`, alongside the existing `headers` /
`guardRedirects` fields in `transport.ts`) rather than a new positional
parameter on `fetchWithOpts` — `fetchUrl` already takes `opts?:
FetchOptions`, so this adds a field, not a signature change. The
`hasQuerySecret` boolean above is the same shape (`opts.hasQuerySecret?:
boolean`) — two new `FetchOptions` fields, no new transport-layer type.
  `Authorization` is always stripped on cross-domain hops regardless of
  source (standard browser behavior), so a guide that sets a literal
  `Authorization` header and expects it to survive a cross-domain redirect
  is out of luck by design — guides routing through a cross-domain
  redirect should use a domain-scoped header name instead. Update the
  `guardRedirects` doc comment to note auth-bearing requests are also
  forced into the guarded path (for header-leak prevention, not
  initial-URL SSRF) and that the guarded path strips injected secrets
  on cross-domain hops.

## Risks

- **Accidental key leak via 401 body / error echo / debug log → flows to
  inference server.** PRIMARY. The output-channel audit must catch every
  path. The concrete code path to audit is `checkResponseStatus`
  (`core/helpers.ts:361`; the `body.slice(0, 500)` is at line 369): on a non-2xx it does `result.body.slice(0, 500)`
  and embeds the slice in a `HelperError` message, which flows through
  `formatHelperError` (`tools/api-fetch.ts`) into the agent's tool-result
  `content` — the prompt channel. A 401 body that echoes the auth header
  value (or a `WWW-Authenticate` value containing the secret) leaks
  directly into agent context here. The fix is to scrub known secret
  values from the sliced body, or (simpler, fail-closed) cap/drop the body
  excerpt for auth-bearing requests. This is the most-skippable-under-deadline
  threat; name `checkResponseStatus` explicitly in the PR and add it to
  the output-channel audit tests.
- **Response-header echo via `details.headers` (restGet-only).**
  `api-fetch` emits the full response headers as `details.headers` in the
  **restGet branch only** (`tools/api-fetch.ts:243`); the `paginate`
  branch does **not** emit `details.headers` (no echo surface there —
  confirmed by reading the code, don't waste time auditing a non-existent
  paginate `headers` emit). On a `restGet`, a server that echoes the auth
  header in a **response** header (e.g. `X-Api-Key: <value>` echoed back,
  or a `WWW-Authenticate` echo that includes the value) leaks the secret
  to the session file on the first authenticated `restGet`. This is a
  `secretRefs` (header-secrets) output-channel concern, distinct from the
  `secretQueryRefs` URL/params channels — header secrets avoid the URL and
  params map but still traverse this surface. The output-channel audit
  must scrub or filter any response header whose value matches a known
  secret, or (simpler, fail-closed) drop `details.headers` entirely for
  auth-bearing `restGet` requests. Add a test asserting no secret value
  appears in `details.headers` for an auth-bearing `restGet`.
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
- **Read-only scoping helps but doesn't stop private-data read or quota
  burn** if leaked. Defense-in-depth, not a substitute.
- **A "helpful" agent may ask the user to paste a key into chat.** Footer
  wording steers to out-of-band channels; cannot fully prevent.
- **Footer must be metadata-only** (no credential value). Enforced by the
  shared auth-status helper.
- **Store-injected `Authorization` following a `restGet` redirect.**
  Today `guardRedirects` is `nextLink`-only, so an auth-bearing `restGet`
  that 302s to an internal host would leak the header unguarded. Fixed by
  forcing `getWithGuardedRedirects` when `hasAuth` in `fetchUrl`
  (§Cache / SSRF / redirect rules) — a one-liner, not a header-set change.
  Note `hasAuth` (not the header-only `hasAuthHeaders`) is what forces the
  guard, so a `secretQueryRefs`-only guide is also covered.
  That closes the **SSRF-to-internal** case. The **cross-domain-to-public**
  case (a 302 to `api.partner.com` carrying the injected `Authorization`)
  is a separate leak: the SSRF guard passes public hosts, so the guarded
  loop alone does not stop it. Fixed by the host-match gate inside the
  guarded loop that strips store-injected `secretRefs` headers on
  cross-domain hops (§Cache / SSRF / redirect rules).

## Validation / testing notes

Carried by the implementation, not separately designed here:

- **Parser/validator tests** for the new auth fields: `auth.secretRefs`,
  `auth.secretQueryRefs`, `auth.requires`, `auth.optional`. Literal-vs-reference is a schema
  distinction. Concretely assert the §Auth contract rules: kind↔field
  consistency (`secretRefs` rejected on `kind: none`; `oauth2` rejected
  at parse with the "not yet implemented" fix), `auth.requires`/`auth.optional` ↔
  referenced-name validation (a `secretRefs`/`secretQueryRefs` name not
  in `requires` ∪ `optional` is a parse error; a name in **both** is a
  parse error), and the `secretQueryRefs` ↔
  operation `params` collision rule (a secret param name also in an
  op's `params` map is a parse error).
- **Store lifecycle tests** — read/write/resolve, `0600` perms,
  lazy-mkdir-on-write-only, names-only listing, missing file/dir handling;
  and `--delete` removal: single-name delete (no confirm) prunes the
  entry and unlinks the now-empty file so the domain exits
  `listDomains()`; whole-domain delete (interactive confirm when
  `ctx.hasUI`, direct execution when headless) removes the file; missing
  name/domain on single-delete fails closed with no mutation; an empty
  domain on whole-domain delete is a no-op status line, not an error;
  and the delete status/confirm line never echoes the value (same
  metadata-only contract as entry).
- **Output-channel audit tests** — the security-critical path. Assert no
  result or error path echoes a secret value: a 401 body, a request-header
  echo, a debug log, and a **response-header
  echo in `details.headers`** (`tools/api-fetch.ts:243`, restGet branch
  only) are all scrubbed. The 401-body case has a named code path:
  `checkResponseStatus` (`core/helpers.ts:361`; slice at `:369`) does
  `result.body.slice(0, 500)` → `HelperError.message` →
  `formatHelperError` → agent tool-result `content`; assert the sliced
  body is scrubbed (or dropped) for auth-bearing requests so a 401 body
  echoing the auth header value cannot reach agent context. The
  response-header case is the one a server that echoes the auth header
  (e.g. `X-Api-Key: <value>` in the response) would leak to the session
  file; assert no secret value appears in `details.headers` for an
  auth-bearing `restGet` (scrub matching headers, or drop
  `details.headers` entirely for auth-bearing `restGet` requests — the
  `paginate` branch has no `details.headers` emit, so it is not a
  concern). This is the work most likely to be skipped under deadline;
  ship it with the first keyed guide, not "later."
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
- **Footer tests** — the five auth-status states (none / auth-ok /
  nudge-provision / auth-ok-optional / optional-not-provisioned), via
  the shared auth-status helper, covering both `api-guide` and
  `api-fetch`. Plus the split absent-secret behavior: a `requires`
  secret absent → `api-fetch` hard-errors before the request with the
  provision-via-`/api secrets` message; an `optional` secret absent →
  `api-fetch` proceeds unauthenticated with the
  `auth: optional (not provisioned)` footer.
- **SSRF verification** — three cases: (a) a malicious `nextUrl` carrying
  a store-injected `Authorization` is blocked by the `nextLink` guard
  (existing path); (b) a `restGet` carrying an injected `Authorization`
  that 302s to an internal host is blocked because `hasAuth` forces
  the guarded redirect path (the new one-liner in `fetchUrl`); (c) a
  `restGet` carrying an injected `Authorization` that 302s to a **public**
  cross-domain host (`api.partner.com`) has the store-injected `secretRefs`
  headers stripped at the cross-domain hop (the new host-match gate in the
  guarded loop, §Cache / SSRF / redirect rules) — assert the auth header
  does not reach the partner host. In (a) and (b) assert the auth header
  does not reach the internal host; in (c) assert the literal `auth.headers`
  (guide-level) may still forward while store-injected secrets do not.
- **`secretQueryRefs`-only parity with header secrets** — the gap that
  motivated the `hasAuth` flag (finding: `hasAuthHeaders` is header-only).
  A guide with `auth.secretQueryRefs` and **no** `secretRefs` / literal
  `auth.headers`: (i) its authenticated response is **not cached**
  (`hasAuth` skips the cache, where `hasAuthHeaders` would not); (ii) a
  `restGet` that 302s to an internal host is **blocked** by the forced
  guarded path (`hasAuth`, not `hasAuthHeaders`). Without the broader
  flag both regress silently — assert both.
- **A real keyed guide** as production validation. The auth-injection code
  path is untested until a keyed guide exercises it; do not ship the store
  without a guide that uses it.
- **`api-probe` secret-name discovery (list mode)** — the bootstrap-gap
  closure. Assert `listSecrets: true` in learn mode returns the
  `provisioned` names for the domain (names only, no value ever appears);
  with a registered guide, `declared` is populated and a
  provisioned-vs-declared gap is visible in one call; absent a registered
  guide, only `provisioned` is returned and the fetch fields are empty.
  Assert the learn gate: `listSecrets: true` under `/api on` (non-learn)
  is refused with the "learn mode only" note and does not read the store.
  This is structural (no network) — list mode short-circuits the fetch.

## Deferred items (explicit)

- OAuth2 (all flows) — `auth.kind: "oauth2"` seam stays, unrealized.
- General mutations / write gate — separate scoped decision; the transport
  stays GET-only this slice.
- Cookie-login (jar + `api-login`) — deferred in full (§Auth status
  footer); persistent jar and full session orchestration are part of that
  deferred path.
- OS-keychain at-rest (`@napi-rs/keyring`) — additive store backend;
  daemon-gated on headless, file is the honest default.

## Cross-references

- [`api-secrets-roadmap.md`](./api-secrets-roadmap.md) — superseded on
  storage choice and `scopes`; carried forward on output-channel audit and
  SSRF verification.
- [`api-stateful-sessions.md`](./api-stateful-sessions.md) — rung 1
  (opaque-token server-side session) **carried forward as supported today**
  (§Goals & scope; no core change — tokens are just params); **the cookie
  rung (3) is deferred (R5), not superseded** (§Auth status footer); this
  doc leaves the cookie gap open and does not claim to close it.
- [`api-helper-escape-valve.md`](./api-helper-escape-valve.md) §5 —
  authentication / header injection (`auth.headers` seam; real keyed auth
  was out of scope; this doc brings it in scope).
- [`api-hardening-and-proof-recipes.md`](./api-hardening-and-proof-recipes.md)
  — same "add when a recipe forces it" posture; the first keyed guide is
  the forcing function for this slice.
