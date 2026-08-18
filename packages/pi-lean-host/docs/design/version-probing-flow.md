# Version-Probing Flow for `api-probe` — Plan

Response to a recurring authoring failure: an LLM, biased by training cutoff,
assumes `/v1` (or a stale version) and never checks whether a later version
exists. This plan reworks `api-probe`'s version handling from **forward
guessing** to **verify-the-stated-version + backward recovery**, and moves the
"discover the current version" job to the guidance channel.

Status: **reviewed — ready to implement.** Findings from review folded in;
`tryPrefixes` renamed to `walkVersions` (breaking change accepted at this
stage).

---

## Root cause

`tools/api-probe.ts`, `probe()`: version prefixing today is a blind
forward guess that only fires on a 404:

```ts
if (base.status === 404 && tryPrefixes && !/^\/v\d+\//.test(path)) {
    for (const p of [`/v1${path}`, `/v2${path}`]) { /* first non-404 wins */ }
}
```

Problems:

1. **Unbounded guess in the wrong direction.** The tool invents `/v1`, `/v2`
   upward from nothing — the same guessy behavior we want the agent to stop
   relying on — and it has an arbitrary ceiling (v2; never reaches v3+ hosts
   like CoinMarketCap).
2. **Under-claim is invisible.** If the agent supplies a stale version that
   still returns 200, the probe happily summarizes it and never looks further.
   No code can fix this without polling; only guidance can.
3. **The flag name lies.** `tryPrefixes` describes the *old* mechanism
   (prepends `/v1`, `/v2` to the path). The new mechanism walks the *host*
   version, so the name is a misnomer — renamed (see below).

## Proposed flow

```
agent decides the most recent version the API supports (from its docs) → supplies it in apiHost
   ↓
probe fetches apiHost/path as given
   ↓
200 → report (trust the stated version; no polling)
   ↓
404 + path has no version prefix + apiHost pathname is /v<integer> → walk BACKWARD N-1 … 1
   → first non-404 wins (over-claim + version-gap recovery), capped at MAX_VERSION_WALK steps
   ↓
404 + gate not met → return 404 with a walk-skip note (no silent bare 404)
```

Key properties:

- **Version lives in `apiHost`** (the worked-example convention), not the path.
  Reuses the existing `versionPrefixOf(apiHost)` helper (returns `/v3`) — no
  change to the helper needed.
- **`null`/bare version → bare fetch, no probing.** Deliberately removes the
  current discover-from-nothing behavior; the tool only *confirms* a stated
  version, never fabricates one.
- **Only 404s walk.** No extra requests on a live 200 — stays a recovery
  fallback, not a poller.
- **Bounded walk.** `MAX_VERSION_WALK = 5` caps the chain even for high-version
  hosts (a `/v10` host fires at most 5 requests, not 9). `ponytail:` comment
  naming the ceiling and upgrade path.

## Changes

### Code — `tools/api-probe.ts`, `probe()`

Rewrite the prefix branch:

- Replace the `[/v1, /v2]` forward array with a host-version backward walk.
- Gate the walk on: `base.status === 404`, `walkVersions` set, path carries no
  version prefix (`!/^\/v\d+\//.test(path)` — guards the mixed-convention
  double-version), and `apiHost` pathname matches `/^\/v(\d+)$/` (skip
  non-numeric / date / versionless / subdomain-versioned hosts).
- Walk `N → N-1 → … → max(N-MAX_VERSION_WALK, 1)`, refetching the same **bare
  path** with the version substituted into `apiHost`; return the first non-404
  with a version-walk note (`404 on /v4/…; version walk → /v2`).
- **Reconstruct the apiHost URL, don't string-replace.** The version is
  substituted via `new URL(apiHost)` → `.pathname = /v${k}` →
  `.origin + .pathname`, not `apiHost.replace('/v3','/v2')` (fragile if the
  version string appears elsewhere in the host).
- **Walk-skip note.** When the gate excludes a host (non-integer pathname, bare
  host, subdomain-versioned), return `404 — no version walk (apiHost has no
  /vN prefix)` instead of a bare `404`, so the agent knows to adjust its
  convention rather than guessing why no recovery fired.

### Rename — `tryPrefixes` → `walkVersions`

`tryPrefixes` described the old "prepend `/v1`, `/v2`" mechanism; the new
behavior walks the apiHost version. Rename across:

- `ProbeOptions.walkVersions` field + JSDoc (`api-probe.ts:82`).
- The tool schema param (`api-probe.ts:576-579`): name + description.
- The `probe()` gate (`api-probe.ts:320,335`) and the execute call-site
  pass-through (`api-probe.ts:668`).
- Test fixtures and the README.

This is a breaking change to the public tool schema — accepted at this stage.

### Strings — `api-probe` param + tool descriptions

Replace the existing strings with concrete, procedure-bearing wording (the
review found the plan's earlier "identify the latest version from docs"
directive too vague to change agent behavior — it named no discovery steps).

- **`apiHost` param** (`api-probe.ts:562-564`):

  > Base URL including the API's current version prefix, e.g.
  > `'https://api.example.com/v3'`. Find the latest version before probing:
  > check the API's docs page, `openapi.json`/`swagger.json` at the API root,
  > or `llms.txt`. Supply the newest version you can verify — if it 404s, the
  > probe walks backward (v3→v2→v1) to recover. Do not default to `/v1` from
  > memory; a stale version that still returns 200 is not detected as old.

  (The current example `'https://api.github.com'` is versionless and
  contradicts the goal — replaced.)

- **Tool `description`** (`api-probe.ts:549-556`) — append:

  > Before authoring a new guide, identify the latest API version from the
  > provider's docs, OpenAPI spec, or `llms.txt` — not from training-era
  > recall. The probe recovers an over-claimed version (404→backward walk) but
  > cannot detect that a working version is stale; always probe the newest
  > version you can cite.

- **`walkVersions` param** (`api-probe.ts:576-579`):

  > On 404, walk the apiHost version backward (vN→v1) to find the highest live
  > version. Default true.

- **`ProbeOptions` JSDoc** (`api-probe.ts:82`):

  > On 404, walk the apiHost version backward (vN→v1). Default true.

### Tests — `__tests__/api-probe.test.ts`

- **Rewrite the existing `tryPrefixes hit` test** (`api-probe.test.ts:209-230`).
  It uses a *bare* host and expects `/v1/items` to win; under the new
  `/^\/v(\d+)$/` gate a bare host doesn't match, so no walk fires and the test
  fails as-is. Rewrite to use a versioned apiHost (e.g.
  `http://127.0.0.1:PORT/v3`) and assert the backward walk to `/v2`. Rename
  the flag to `walkVersions` in the fixture.
- **Over-claim recovery:** stated `/v3`, host returns 404 → walk hits `/v2`,
  draft/note carry the true version.
- **Version gaps:** `/v4` 404, `/v3` 404, `/v2` 200 → `/v2`.
- **Walk cap:** stated `/v10`, all lower versions 404 → at most
  `MAX_VERSION_WALK` requests fired (assert URL list length).
- **Same-version 200:** no extra requests fired (assert URL list length).
- **Bare host 404:** no probing, returns the walk-skip note (regression of the
  removed forward-guess).
- **Non-integer pathname** (e.g. `https://host/api` or a date): no walk,
  walk-skip note.
- **Version-in-path (mixed convention):** path `/v3/data` → no host walk.

### Docs — `README.md`

- **`README.md:266`** — update the user-facing description from "auto-tries
  `/v1` and `/v2` prefixes (disable with `tryPrefixes=false`)" to describe the
  backward version walk and the renamed `walkVersions=false` opt-out.

## Honest boundary

This flow **recovers over-claim** (doc/agent states too-new a version) by code
and **prevents under-claim** (stale-but-200 version) by guidance only. The
"confront every 200 with sibling versions to find the latest" alternative was
considered and **rejected**: it turns recovery into polling, doubles request
load on arbitrary third-party APIs, and still cannot know what's *latest* —
only what's highest that answered. The probe stays a shape-discovery tool; the
version is an authoritative fact owned by the docs (per the existing
`DOCS_NUDGE`).

## Risks

- **Subdomain-versioned hosts** (e.g. `https://v3.api.host`):
  `versionPrefixOf` returns `` (pathname is `/`) → gate fails → no walk. This
  is *correct* (the walk can't reconstruct a subdomain version by swapping a
  pathname), and the walk-skip note now tells the agent why, so it can adjust
  its `apiHost` convention rather than guessing.
- **Redirect during walk.** If `/v3` 404s and the walk hits `/v2` which
  301-redirects to `/v3` (or any other version), `fetchUrl` follows the
  redirect and returns the final status. A 200 redirect-target stops the walk,
  but the draft would carry `/v2` as the prefix while the actual response came
  from the redirect target. The version-walk note should advise the agent to
  check `finalUrl` when a walk hit occurs. Extremely unlikely for
  version-prefix conventions, but documented.
- **Under-claim remains guidance-only.** A stale-but-200 version is never
  detected as old by code. The strengthened `apiHost`/tool description wording
  (concrete discovery steps + "do not default to `/v1` from memory") is the
  mitigation; it is not a guarantee.

## Out of scope

- Making the probe a version resolver / polling a live 200.
- Guessing *upward* from a versionless host (removed, not extended).
- Versioning by date / non-integer path segments (no walk for those).
- Subdomain-versioned hosts (no walk; walk-skip note only).
- Any change to `restGet` / `paginate` execution — this is `api-probe`
  (authoring) only.

## Sequence

Independent of the web-learn / round-2 items. Lands as one focused PR (code +
rename + strings + tests + README). `tsc --noEmit` clean; host suite green.
