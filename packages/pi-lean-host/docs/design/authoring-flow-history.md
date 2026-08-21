# Guide Authoring-Flow — Work History

Chronological record of the guide-authoring waves in this package. Current
behavior is documented in `AGENTS.md` / `README.md`; **this file is the drift
anchor** — if those docs contradict what shipped here, one of them is wrong.

The superseded wave-plan docs were deleted (they described target states that
are now the shipped state). Their decisions live in the code, `AGENTS.md`, and
the invariants section below.

## Wave 1 — Authoring-flow redesign (design + implementation plan)

Shipped (sprints S0–S5):

- **Frontmatter delimiter diagnostic** — a missing closing `---` is named as
  such, not "no frontmatter found" (CRLF + malformed-closer edge cases
  covered).
- **`schemaVersion` breaking-change detection** — stamped on save by
  `api-learn`; absent-on-read defaults to `0` (the floor, not current); a
  stale guide (`< current`) gets a non-blocking `⚠` warning in the
  `api-guide` catalog / detail / disambiguation and a note on `api-fetch`.
  **Never a gate** — the guide always loads and runs.
- **Worked example** — hardcoded `updated`/`verified` dates dropped (tool
  stamps them when omitted); `static-key` auth documented alongside `none`.
- **`api-probe` scaffold mode** — `scaffold: true` emits the full recipe
  skeleton (top-level + `auth:` translated from injection params + op block);
  auto-degrades by guide count (0 → skeleton, 1/N → op block + merge note).
  Opt-in; pagination stays op-level.
- **`api-learn` fetch-recipe** — `{domain}` with no recipe returns the raw
  recipe (with `dirName` surfaced to prevent sibling-clobber); `new: true`
  returns a fresh template; bare call = manual, `{domain, new: true}` =
  template (entry-point split).
- **`/api verify`** — always-available command; strict **any-runnable-op
  failure → no stamp**; auth precheck fail-fast; `verify.json` sidecar for
  required-params ops; `--force` (human-typed only); stamps `verified` via
  line-level frontmatter replacement.
- **`/api delete`** — always-available, **human-typed only** (no agent tool
  surface); removes the directory + invalidates the guide-store cache
  (closes the `bash rm` ghost-guide bug).

## Wave 2 — Polish

- **BOE worked example retired** → `placeholderSkeleton` (only `domains` real,
  other fields `<placeholder>` placeholders that **fail closed** — a pasted
  template cannot save). One commented `static-key` block survives.
- **`secretRefs` header→secret direction** stated on the manual Auth section
  and the probe `auth.secretRefs` param description.
- **`schemaVersion` surfaced in the save confirmation** (`Schema version: N`).
- **`stampFrontmatterField` de-glued** — blank line on insert only (replace
  never gains one, so re-stamps don't drift the file).

## Wave 3 — Loud auth

- **Strict `auth` schema** — unknown keys under `auth` are rejected (the
  wrong-but-plausible `name`/`secret` shape now fails loudly at save with an
  adaptive `fix` pointing at `secretRefs`/`requires`).
- **Manual discoverability** — auth content promoted to its own `## Auth`
  section; a validation failure appends a pointer to the governing manual
  section.
- **`required`/`default` query-param docs** in the manual — a
  `required`+`default` op is always verifiable without a sidecar.
- **Save-summary auth echo** — `Auth: static-key · Authorization ← secret
  apiKey (Bearer )`; names only, never values.

## Wave 4 — Feedback review

- **`requiresAnyOf`** — at-least-one-of group on an op (`[id, symbol, slug]`-style);
  single group per op (v1 ceiling); five parser cross-field checks
  (empty-array reject, member-exists, no-path-param, no-`required`-overlap,
  no-`default`-overlap); runtime guard in `buildQueryParams`; rendered as
  `requires any of:` in `api-guide`.
- **`verifyValue` added** — verify-only value on a query param
  (`verify.json > verifyValue > missing`). Removed in wave 6.
- **`auth.kind` missing-value fix** — the missing-`auth.kind` error now lists
  `none | static-key` and the manual states the literal `kind: static-key`.
- **Scaffold nudge** — targeted `scaffold: true` hint in the probe footer
  (only when not passed and no guide claims the domain).

## Wave 5 — Probe final fix

- **401/403 wording** — acknowledges injection state: no-auth →
  "endpoint requires auth; configure auth injection"; injected-but-rejected →
  "auth injected but rejected; verify header name and secret value";
  missing-secret → names the missing secret. The bogus "(guide is auth:none)"
  string is gone.
- **`headerPrefixes` without `secretRefs`** — surfaced as a warning instead
  of silently dropped (both error and success paths).
- **Parser `{name}` prefix value guard** — a bare `{name}` placeholder is
  rejected as a `headerPrefixes` value (defense in depth; the probe warning
  fires first).

## Wave 6 — verifyValue removal

- **`verifyValue` dropped from the schema** — precedence collapses to
  `verify.json > missing`; a constrained op with no sidecar is simply
  unverifiable (skipped + named in the report). `mergeVerifyValues` inlined
  away. Params silently ignore unknown keys, so no saved guide breaks.
- **`requiresAnyOf` group-member `default` ban removed** — the rule existed
  only to steer authors toward `verifyValue`; a defaulted member is now a
  regular defaulted param.

## Deferred (never shipped)

- **Staging / candidate-guide verification** (`_staging/` dir + promote
  command) — if editing-clobber pain proves real; the git-init-your-
  api-guides-dir safety net is the v1 answer.
- **`sample`/`example` verify-value field** — wave 6's removal closed the
  loop-closure gap; revisit only if a real author needs a representative value
  with no safe default.
- **Multi-group `requiresAnyOf` (`requiresAnyOfGroups`)** — v1 is single-group;
  the upgrade path is purely additive.
- **Per-op `lastVerified` runtime health** — a runtime-health feature, out of
  authoring-flow scope.
- **Probe pagination inference** — inherent to single-shot probing; the
  honest comment is the fix.

## Live design invariants

From the redesign; these are load-bearing and should not be changed casually:

- **`verified`** — respect-if-present, default-today (D2). No `lastModified`,
  no strip/override on the save path.
- **`api-fetch` is read-only w.r.t. `guide.md`** (D3) — no passive `verified`
  bump on use; writes go to `/tmp` spill only.
- **`/api verify`** (D4) — strict any-runnable-op failure → no stamp; skipped
  ops named; all-skipped → no stamp; auth precheck fail-fast; `verify.json`
  sidecar; `--force` is human-typed only (no agent surface).
- **`/api delete`** (D10) — human-typed only; interactive confirm for
  whole-domain; invalidates the guide-store cache.
- **Scaffold** (D11) — opt-in; auto-degrades by guide count; never emits
  conflicting `---` blocks.
- **Multi-recipe domains** (D12) — disambiguation by `shortName`; fetch/
  delete require a `guide` selector; single-guide domains stay zero-friction.
- **`schemaVersion`** (D-bootstrap) — breaking-change detection: stamped on
  save, absent → `0` floor, stale (`< current`) warns non-blockingly, **never
  a gate**.
- **Mode boundary** (D1) — use-mode tools stay use-mode; learn-mode behavior
  is never smuggled onto `api-guide` / `api-fetch`.
