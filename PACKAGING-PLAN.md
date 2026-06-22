# Packaging Plan — `pi-lean-portal` and the Web-Tools Suite

> Drafted 2026-06-22. **Revised to Option A** (portal owns `/web`, no command
> split, no degradation message). All open decisions **locked** (see §8).
> Reference implementation studied: `~/rpiv-mono` (the `@juicesharp/rpiv-*`
> family). Pi packaging docs consulted: `@earendil-works/pi-coding-agent/docs/packages.md`
>
> + `docs/extensions.md`.

---

## 1. The core decision: `pi-lean-portal` owns `/web` outright

Your suite-of-web-tools goal runs into one load-bearing Pi behavior:

> **`pi.registerCommand()` does not collide — it suffixes.** If two loaded
> extensions both register `"web"`, Pi keeps both and exposes them as
> `/web:1` and `/web:2` (in load order). See `docs/extensions.md` →
> "pi.registerCommand(name, options)".

So `/web` must have **exactly one owner** across any installed subset of the
suite. The cleanest way to guarantee that — without a third "core" package and
without splitting `/web profile` / `/web cookies` into a separate `/browser`
command — is:

> **`pi-lean-portal` owns the entire `/web` surface.** `on | off | learn |
> status | profile | cookies` all live in portal. Sibling packages
> (`pi-lean-seer`) register **no** `/web` command — they're leaves that
> contribute tools only.

This works because the web browser is the **required** component for `/web` (your
call). The `/web` command and its backing browser code are the same package, so
if `/web` is runnable, its backer is loaded by definition — no degradation
message needed, no missing-backer state to handle.

A second Pi rule shapes how `/web on|off` reaches sibling tools:

> **Pi loads each package with a separate module root.** Independently
> installed Pi packages do **not** share module instances or in-memory state
> (`packages.md` → "Dependencies").

So `/web on` cannot consult a cross-package registry. It discovers sibling tools
by **exact name** over `pi.getAllTools()` — the same approach your current
`browser-toggle.ts` already uses with a hardcoded `BROWSER_TOOL_NAMES` set; we
keep the exact-name approach (no regex) and add a sibling set when seer lands.
The Pi docs at `extensions.md:1506` explicitly warn "Do not infer ownership
from command names or from ad hoc path parsing" in favor of `sourceInfo`, but
for *toggling* (not ownership inference) exact tool-name membership is the
right tool: zero false positives, works uniformly across Mode A and Mode B
(see §2.3 for why `sourceInfo`-based grouping is deferred to v0.2).

### 1.1 What this means for each install combination

| Installed packages | `/web` exists? | `/web on/off` toggles | Behavior |
|---|---|---|---|
| `pi-lean-portal` only | ✅ (portal owns it) | browser tools | Exactly today's behavior. **Recommended install** (decision 14). |
| `pi-lean-portal` + `pi-lean-seer` | ✅ (portal owns it, single) | browser + search tools | Unified toggle, no `/web:1`/`/web:2`. |
| `pi-lean-nexus` (umbrella) | ✅ (bundles both above) | browser + search tools | Full-suite power-user option — requires SearXNG server + URL config (§3 Mode B). |
| `pi-lean-seer` only | ❌ no `/web` | (search tool always on) | Search-only user has nothing to toggle. Acceptable — see §1.2. |

### 1.2 The one tradeoff (and why it's fine)

A **search-only user** (seer installed without portal) gets **no `/web`** and
their search tool is just always on. Is that a loss? No — `/web on/off` exists
to hide ~1500–2000 tokens of browser tool descriptions from the system prompt.
A search-only user has one tiny tool and nothing to profile or cookie. `/web`
gives them nothing meaningful. If they type `/web on` out of habit, they get
Pi's generic "unknown command" — the honest answer. The recommended install
is `pi-lean-portal` (decision 14), which ships `/web`; users who want search
alongside it add `pi-lean-seer` (Mode B-seer) and portal's `/web on/off`
picks up the `web-search` tool automatically.

### 1.3 Why not "each package registers `/web` if absent"?

(Considered and rejected — recorded here so we don't revisit it.)

`pi.getCommands()` is list-only (no atomic "register if absent" primitive), and
extension load order across packages is not guaranteed. So whichever package
loads first wins `/web` — if seer loads before portal, **seer owns `/web`**
and its handler has no idea what `/web profile` means. Register-if-absent turns
"noisy when both installed" into "nondeterministically broken when both
installed." Strictly worse than the rejected `/browser` split. Portal-owns-`/web`
is deterministic by construction.

---

## 2. Recommended architecture

### 2.1 Package topology (npm workspaces monorepo)

```
pi-lean-portal/                      (repo root — named after the main feature, the browser)
├── package.json                      (name: "pi-lean-portal-workspace", private: true; workspaces: ["packages/*"], lockstep versioning)
├── tsconfig.base.json
├── vitest.config.ts
├── scripts/
│   ├── sync-versions.js              (lockstep bump, port from rpiv)
│   └── release.mjs                   (port from rpiv)
└── packages/
    ├── pi-lean-portal/               ← the browser + owns /web (most of current pi-browser)
    ├── pi-lean-seer/                 ← leaf: SearXNG search tool (web-search), no /web
    └── pi-lean-nexus/                ← umbrella meta-package = "install everything"
```

> **Naming.** The repo dir + GitHub repo are named `pi-lean-portal` (the main
> feature, the browser — most discoverable name). The root `package.json` is
> named `pi-lean-portal-workspace` with `"private": true` to avoid an npm
> duplicate-name collision with the `pi-lean-portal` workspace child (rpiv
> follows the same pattern: root `rpiv-mono` ≠ children `@juicesharp/rpiv-*`).
> The umbrella package keeps the name `pi-lean-nexus` at
> `packages/pi-lean-nexus/` — its name describes its role (bundle), not the
> repo. All names **unscoped** (`pi-lean-portal`, `pi-lean-seer`,
> `pi-lean-nexus`); they're unique enough to resist squatting.

| Package | Type | Ships `/web`? | Heavy deps? | Role |
|---|---|---|---|---|
| `pi-lean-portal` | extension | **yes (sole owner)** | `playwright`, `node-html-parser`, `turndown` | All browser tools, `web-fetch`, `web-guide`, profiles, cookies, guides, **and the entire `/web` command** |
| `pi-lean-seer` | extension | no | (whatever it needs) | SearXNG search tool (`web-search`). Name lives in portal's `web-` namespace so `/web on/off` picks it up with no special-casing. |
| `pi-lean-nexus` | extension (umbrella) | no (delegates to bundled portal) | none directly | `bundledDependencies` of portal + seer; `pi.extensions` references each via `node_modules/...` |

### 2.2 `/web` surface — all owned by `pi-lean-portal`, no split

| Command | Owner | Notes |
|---|---|---|
| `/web on` | portal | Enables all web tools (browser + any installed siblings) by convention. |
| `/web off` | portal | Disables all web tools. |
| `/web learn` | portal | Enables the `*-learn` tool group (today: `web-learn`) alongside browsing. |
| `/web status` | portal | Lists all web tools by name with on/off state (current behavior, generalized to include seer tools). Grouping by source package deferred to v0.2 (see §5.11, decision 12). |
| `/web profile` | portal | Unchanged from today. |
| `/web cookies` | portal | Unchanged from today. |
| `/web` (bare) | portal | Help text listing all subcommands. |

**No command moves. No `/browser` split. No degradation message.** Every
subcommand is implemented inside portal, so every subcommand's backer is
guaranteed present whenever the command is runnable.

### 2.3 How `/web on|off|learn` discovers sibling tools without a shared registry

Keep the existing **exact-name-set** approach — do NOT switch to a regex.
The current `BROWSER_TOOL_NAMES` / `LEARN_TOOL_NAMES` `Set<string>` constants
in `browser-toggle.ts:35–50` already do this correctly: `getRegisteredBrowserTools`
filters `pi.getAllTools()` by exact `Set.has(name)` membership. We keep that
mechanism and add one new set for sibling tools.

```ts
// pi-lean-portal: exact-name-set discovery (NO regex — avoids false positives
// from third-party tools whose names happen to start with web-/browser-)
const BROWSER_TOOL_NAMES = new Set([
  "web-fetch", "browser-navigate", "browser-snapshot", "browser-click",
  "browser-type", "browser-scroll", "browser-back", "browser-press",
  "browser-console", "browser-inspect", "web-guide",
]);
const SIBLING_TOOL_NAMES = new Set<string>([
  // "web-search",  // ← added at seer integration (step 5, decision 10)
]);
const LEARN_TOOL_NAMES = new Set(["web-learn"]);
```

+ `/web on`  → enable every registered tool whose name is in
  `BROWSER_TOOL_NAMES ∪ SIBLING_TOOL_NAMES` and NOT in `LEARN_TOOL_NAMES`;
  disable `LEARN_TOOL_NAMES`.
+ `/web learn` → enable `BROWSER_TOOL_NAMES ∪ SIBLING_TOOL_NAMES ∪ LEARN_TOOL_NAMES`.
+ `/web off` → disable all three sets.
+ `/web status` → list tools by name with on/off state (grouping by source
  package deferred to v0.2 — decision 12).

**Why exact names, not a regex.** A regex like `/^(?:web-|browser-)/` would
match **any** third-party tool whose name happens to start with `web-` or
`browser-` — install someone's `pi-web-scraper`, run `/web off`, and their
tool gets disabled unexpectedly. Exact-name membership has **zero false
positives**: only the tools portal explicitly lists are ever toggled. This
also sidesteps the `sourceInfo` mode-dependence problem (Mode A bundled
installs attach the umbrella's `source` to both children's tools, so
`sourceInfo`-based grouping is ambiguous for Mode A — see decision 12). Exact
names work identically in Mode A and Mode B.

**The cross-package contract is now same-monorepo and review-caught, not a
fragile prefix.** Portal hardcodes `"web-search"` in `SIBLING_TOOL_NAMES`; if
seer ever renames its tool, portal's tests fail (the simulated `web-search`
registration in `browser-toggle.test.ts` no longer matches), not a silent
runtime miss. Both packages live in one monorepo under lockstep versioning
(decision 4), so drift is caught at review. This is strictly safer than the
regex+prefix approach the plan previously proposed (which had no enforcement
at all — reviewer NOTE-5's original concern, now fully dissolved).

> `web-fetch` and `web-guide` stay in `BROWSER_TOOL_NAMES` (unchanged from
today). They live in portal, so listing them is self-referential — no
cross-package contract involved.

### 2.4 Toggle state — renamed to `web-toggle-state`, no legacy reader

**Decision: rename the persisted key from `browser-toggle-state` to
`web-toggle-state`.** No legacy/back-compat reader. Rationale: the current
`pi-browser` package is `"private": true` (pre-ship), so there are no external
users to migrate, and the developer's own existing sessions losing toggle
position is acceptable.

The state shape stays the same:

```ts
pi.appendEntry("web-toggle-state", {
  enabled: boolean,        // was browserToolsEnabled
  learn: boolean,          // was learnToolsEnabled
  defaultProfile: string,  // unchanged
});
```

> ❓ **Field rename consideration.** The shape above also renames
> `browserToolsEnabled` → `enabled` and `learnToolsEnabled` → `learn` for
> clarity. Since we're already breaking the key name with no legacy reader,
> renaming the fields too is free. If you'd rather keep the field names to
> minimize the `browser-toggle.ts` diff, that's fine — only the key name
> matters for persistence. Pick one when you implement step 3 of §7.

`~/.pi/agent/browser-state/` storage path and the `browser.plugins` settings
key both stay as-is (portal still owns them; they're not user-facing command
names).

---

## 3. The installer story (three supported modes)

> **Recommended: Mode A (`pi-lean-portal`).** Rationale (decision 14): the
> "recommended" label should match the install that **works fully out of the
> box** with the least friction. Portal needs one Playwright command after
> `pi install` and you're browsing. Nexus bundles seer, which requires a running
> SearXNG server + a configured API URL — real setup friction most users won't
> want up front. Nexus is reframed as the **full-suite power-user option** for
> those who already run SearXNG (or want to). The architecture is unchanged;
> this is a re-ranking of the install matrix, not a redesign.

### Mode A — "Install the browser" (recommended default)

```bash
pi install npm:pi-lean-portal
```

The browser + `/web`. After install, run `npx playwright install chromium
firefox` (the `.npmrc` suppresses the auto-download — see §5.4) and you're
browsing. This is the common case and the install the README leads with. If you
later want search, `pi install npm:pi-lean-seer` adds it (§3 Mode B-seer) and
portal's `/web on/off` picks it up automatically via the `web-` prefix
convention.

### Mode B — "Install the full suite" (power-user, requires SearXNG)

```bash
pi install npm:pi-lean-nexus
```

`pi-lean-nexus`'s `package.json`:

```jsonc
{
  "name": "pi-lean-nexus",
  "version": "0.1.0",
  "pi": {
    "extensions": [
      "./node_modules/pi-lean-portal/index.ts",
      "./node_modules/pi-lean-seer/index.ts"
    ]
  },
  "dependencies": {
    "pi-lean-portal": "^0.1.0",
    "pi-lean-seer": "^0.1.0"
  },
  "bundledDependencies": ["pi-lean-portal", "pi-lean-seer"]
}
```

This is the **official Pi pattern** for bundling sibling Pi packages
(`packages.md` → "Dependencies"). One install, one settings entry, both
extensions load, `/web` is owned by the bundled `pi-lean-portal` exactly once
(no `/web:1`/`/web:2`). **Caveat:** `web-search` is non-functional until you
configure a SearXNG URL (decision 15 — seer degrades gracefully and prints
setup instructions on first call, so the bundle doesn't break; the browser
works immediately). Choose this mode if you already run SearXNG or want to.

### Mode B-seer — "Install search only" (requires SearXNG)

```bash
pi install npm:pi-lean-seer          # search only, no /web
```

Search-only. No `/web` (§1.2 — a single tiny tool has nothing to toggle). Same
SearXNG-server + URL-config requirement as Mode B. For users who want search
without the browser.

### Mode C — Auto-setup command (deferred to v0.2)

Ship a `/web-setup` command (in portal or nexus) that mirrors rpiv's
`/rpiv-setup`:

+ Declares a `SIBLINGS` table (`pkg`, `matches` regex, `provides`) — single
  source of truth, exactly like `rpiv-pi/extensions/rpiv-core/siblings.ts`.
+ Detects which web-family packages are missing from the active Pi settings file.
+ Confirms with the user, then runs `pi install npm:<pkg>` for each missing one
  (Windows-safe spawn, port `pi-installer.ts`).
+ Optionally prunes legacy entries (e.g. the old private `pi-browser` package).

This is the safety net for users who installed only portal and want to add
seer, or vice versa. **v0.1 ships Mode A + Mode B + Mode B-seer only; Mode C
lands in v0.2 if support requests come in.**

> **`pi-lean-seer` peer-dep on portal.** `pi-lean-seer` declares
> `pi-lean-portal` in `peerDependencies` for npm-graph/documentation
> correctness, but does **not** enforce it (search-only installs remain valid
> — the seer tool works standalone; it just doesn't get a `/web` toggle). Do
> NOT mark it a hard peer: npm-installing a package does not add it to Pi's
> `settings.json`, so a hard peer wouldn't solve the Pi-load problem anyway;
> Mode C does.

---

## 4. What lives where (file migration from current `pi-browser`)

### `pi-lean-portal` (the bulk of current `pi-browser` — and now the `/web` owner)

```
pi-lean-portal/
├── package.json          (pi: { extensions: ["./index.ts"] }; deps: playwright, node-html-parser, turndown)
├── index.ts              (plugin registration, tool registration, session lifecycle, initBrowserToggle(pi))
├── browser-toggle.ts     (KEEPS owning /web: on|off|learn|status|profile|cookies — add SIBLING_TOOL_NAMES set (empty for v0.1), rename key to web-toggle-state)
├── browser-profile.ts    (unchanged — still called via /web profile)
├── browser-cookies.ts    (unchanged — still called via /web cookies)
├── browser-status.ts     (unchanged — generalized to group by sourceInfo)
├── backends/             (chromium/, firefox/, chromium-py/, firefox-py/, python-adapter.ts, python-base/)
├── core/                 (plugin-api, plugin-registry, plugin-config, router, guides, fetch-backend, shared/)
├── tools/                (12 tool definitions)
├── guides/               (user-authored, gitignored)
├── README.md
├── LICENSE
├── ship-manifest.test.ts
└── __tests__/
```

**The migration is strikingly small** because Option A keeps `/web` in portal:

| Current file | Change under Option A |
|---|---|
| `index.ts` | None — still calls `initBrowserToggle(pi)`. |
| `browser-toggle.ts` | **(1)** Add a `SIBLING_TOOL_NAMES = new Set<string>([])` constant (empty for v0.1; populated with `"web-search"` at step 5). **(2)** Rename the persisted key from `browser-toggle-state` to `web-toggle-state` (§2.4). The existing `BROWSER_TOOL_NAMES` / `LEARN_TOOL_NAMES` exact-name sets stay as-is — **no regex** (§2.3). Everything else (state machine, branch restoration, config default, profile/cookies/status subcommand routing) stays. |
| `browser-profile.ts` | None. |
| `browser-cookies.ts` | None. |
| `browser-status.ts` | Optional: group output by `sourceInfo` so sibling tools show their origin package. |
| `tools/*` | None. |
| `backends/*`, `core/*` | None. |

### `pi-lean-seer` (future — you've coded it)

```
pi-lean-seer/
├── package.json          (pi: { extensions: ["./index.ts"] }; soft peer dep on pi-lean-portal)
├── index.ts              (registers the `web-search` tool)
└── ...
```

Requirements to integrate with `/web`:

1. **Its tool is named `web-search`** (decision 10, §8) — chosen to match
   agent-training conventions so models reach for it instinctively. Portal
   lists `"web-search"` in its `SIBLING_TOOL_NAMES` set (§2.3) so `/web on/off`
   toggles it via exact-name membership. No regex, no prefix contract, no
   false-positive risk on third-party `web-*` tools.
2. It registers **no** `/web` command (and no other command that would collide).

**Namespace-ownership boundary** (a same-monorepo convention, not an enforced
contract — and now weaker than before: portal only needs to avoid naming a
tool `web-search`, not avoid a whole prefix):

| Owner | Tool names portal lists |
|---|---|
| `pi-lean-portal` | `browser-navigate`, `browser-snapshot`, `browser-click`, `browser-type`, `browser-scroll`, `browser-back`, `browser-press`, `browser-console`, `browser-inspect`, `web-fetch`, `web-guide`, `web-learn` |
| `pi-lean-seer` | `web-search` |

Both packages live in one monorepo under lockstep versioning (decision 4), so
a collision or rename is caught at review (portal's tests reference `web-search`
by exact name). If seer later adds `web-search-images` or `web-search-news`,
portal adds those exact names to `SIBLING_TOOL_NAMES` too. Portal must not add
a `web-search` tool of its own — that's seer's slot.

### `pi-lean-nexus` (umbrella)

```
pi-lean-nexus/
├── package.json          (bundledDependencies + node_modules/... in pi.extensions)
├── README.md
└── LICENSE
```

No code — just the manifest that bundles portal + seer. (The repo root dir is
`pi-lean-portal`; the umbrella package lives at `packages/pi-lean-nexus/` per
the workspaces layout in §2.1. The root `package.json` — named
`pi-lean-portal-workspace`, `private: true` — is the workspace root, distinct
from the umbrella package's `package.json` and from the browser child's
`package.json`.)

---

## 5. Tricky parts (the list you anticipated, plus a few more)

1. **`/web` single-owner** — solved by portal owning it outright. The only
   package that registers `/web` is `pi-lean-portal`. Siblings register no
   `/web`. Deterministic by construction. *(§1, §2.2)*

2. **No cross-package in-memory state** — solved by exact-name-set membership
   over `pi.getAllTools()`. Do NOT attempt a shared singleton registry; Pi's
   separate module roots make it unreliable. Do NOT use a name-prefix regex
   either (false-positive risk on third-party tools + the Pi docs discourage
   inferring ownership from names); exact-name `Set.has()` is the right
   mechanism for toggling. *(§2.3)*

3. **`/web on/off` semantics widening** — today `BROWSER_TOOL_NAMES` toggles
   only browser tools. After adding `"web-search"` to `SIBLING_TOOL_NAMES` at
   seer integration, `/web on` enables **all** web tools including seer. This
   is the intended "unifying" behavior. For existing portal-only users there's
   no breakage — they just also get search toggled, and search isn't installed
   for them anyway. Document in CHANGELOG. **Status display stays per-group**
   (decision 11): the `browser` glyph reflects only browser tools; a separate
   `search` glyph reflects only seer tools. So `/web on` with browser tools off
   and seer on shows `browser: ● off` / `search: ● on`, not an overloaded
   browser slot. Portal owns both slots (it already knows which tools are
   browser-group vs sibling-group by which set they're in); seer needs no
   status logic. The `search` slot is implemented at seer integration (step 5),
   not v0.1 — for v0.1 (portal-only) the `browser` slot behaves exactly as today.

4. **`playwright` is heavy** — **decision: skip auto-download + lazy-load +
   notify.** Ship a `.npmrc` file in `pi-lean-portal` containing
   `playwright_skip_browser_download=true`. npm reads `.npmrc` from the package
   dir **before** running lifecycle scripts, so Playwright's own `postinstall`
   sees the env var and skips the browser download — this is the key reason a
   `.npmrc` works where a self-`postinstall` cannot (npm runs dependency
   `postinstall` scripts before the depending package's `postinstall`, so a
   portal `postinstall` would set the env var too late). Result:
   `pi install npm:pi-lean-portal` is fast and non-surprising. ChromiumPlugin
   lazy-loads Playwright; on first `browser-navigate` with no browsers
   installed, emit a `ctx.ui.notify` with
   `npx playwright install chromium firefox`. `playwright` stays a regular
   `dependency` (not peer/optional) so `npm install` resolves it; the `.npmrc`
   just suppresses the binary download. (Resolves reviewer NOTE-6.)

5. **Python bridges ship `.py` sources** — `backends/chromium-py/bridge.py`,
   `backends/firefox-py/bridge.py`, and all of `backends/python-base/` must be
   in `pi-lean-portal`'s `files` array. Document the Python venv requirement
   (chromium-py / firefox-py auto-skip if absent — already handled in tests).

6. **`files` array completeness** — port rpiv's `ship-manifest.test.ts` pattern
   (`verifyShipManifest(import.meta.url)` from `@juicesharp/rpiv-test-utils` —
   or write a small local equivalent) into **every** package. This test fails
   the build if any production `.ts`/`.py` module isn't covered by `files`. It
   catches the classic "forgot to ship a directory" bug before publish.

7. **Source-only shipping (no build step)** — keep `tsconfig` `noEmit: true`.
   Pi loads `.ts` directly. `module: "nodenext"` requires `.js` extensions in
   imports (already done in this repo). No bundler, no `dist/`. This matches
   rpiv exactly.

8. **`peerDependencies` for Pi core libs** — every package **that ships code** lists
   `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
   `@earendil-works/pi-tui`, `typebox` as `peerDependencies: "*"`. **Never
   bundle these.** (`packages.md` → "Dependencies".) `playwright`,
   `node-html-parser`, `turndown` are regular `dependencies` of portal only.
   (Codeless packages like `pi-lean-nexus` list no peer deps — they bundle
   transitively.)

9. **Monorepo mechanics** — npm workspaces (`"workspaces": ["packages/*"]`),
   **lockstep versioning** via a ported `scripts/sync-versions.js`, release via
   a ported `scripts/release.mjs`. Single `npm publish -ws --access public`.
   Lockstep for v0.x (simpler reasoning about suite compat); switch to
   independent versioning once the packages stabilize.

10. **`pi-package` keyword + `publishConfig`** — every publishable package:
    `"keywords": ["pi-package", "pi-extension", ...]`,
    `"publishConfig": { "access": "public" }`,
    `"type": "module"`. This gets them into the Pi package gallery
    (`packages.md` → "Gallery Metadata").

11. **Status-bar glyph (`ctx.ui.setStatus("browser", …)`)** — **decision: keep
    the `"browser"` slot name for the browser group.** Stays owned by
    `browser-toggle.ts` in portal. The slot name is internal; users see the
    rendered glyph (`● idle`), not the key. **A separate `search` slot is
    added for the seer group at seer integration (step 5, decision 11)** so the
    browser slot isn't overloaded with search state — `browser` reflects only
    browser tools, `search` reflects only seer tools. For v0.1 (portal-only,
    no seer), the `browser` slot behaves exactly as today; no churn. (Could
    rename `browser` → `web` in a later minor if the widened scope ever makes
    the misnomer feel wrong, but the per-group split makes that less pressing.)

12. **Tests** — the current 24 test files / 803 tests **stay almost entirely in
    portal** (no core extraction means no test split). Only new work:
    + Update `browser-toggle.test.ts` to assert the exact-name-set discovery
      picks up a simulated `web-search` tool registration (seer's contracted
      name, decision 10) once added to `SIBLING_TOOL_NAMES`, and to use the new
      `web-toggle-state` key.
    + Add `ship-manifest.test.ts` to portal (and seer, and nexus).
    **Decision: ship `ship-manifest.test.ts` only** in each package's `files`;
    keep all other tests dev-only to shrink install footprint. (Test-count fix:
    AGENTS.md and `ls __tests__/*.test.ts` both report 24 files, not 25 —
    resolves reviewer NOTE-3.)

13. **Existing `pi-browser` private package** — superseded by `pi-lean-portal`.
    Since it's `"private": true`, there are no external users to migrate. The
    developer's own settings entries pointing at the local `pi-browser` path
    get repointed to `npm:pi-lean-portal` (or `npm:pi-lean-nexus`) on first
    install. Document the switch in the root README.

14. **AGENTS.md / README** — root README covers the suite + install matrix
    (**Mode A** recommended / **Mode B** full-suite / **Mode B-seer** search-only
    / **Mode C** auto-setup v0.2); each package gets its own README; `AGENTS.md`
    moves to the monorepo root (and a copy/symlink in portal for dev agents
    working in-package).

15. **Seer graceful degradation when unconfigured** — `pi-lean-seer` requires
    a running SearXNG instance + a configured API URL (settings key
    `searxng.url` or env var `SEARXNG_URL`). Because nexus bundles seer, a user
    who `pi install`s nexus without having SearXNG set up would get a
    non-functional `web-search` tool. **Decision: seer registers `web-search`
    normally regardless of config; on first call with no URL configured, it
    returns a clear setup message** (not a silent failure or thrown error):
    point the user at `searxng.url` in settings or `SEARXNG_URL`, and at the
    `pi-lean-seer` README for self-host vs public-instance options. This keeps
    nexus **safe to install before SearXNG is ready** — the browser works
    immediately, and the search tool self-documents its setup. It also gives a
    portal-only user who later adds seer a clear first-use path. Seer-side
    design; track for step 5. (Captured as decision 15.)

---

## 6. Proposed `package.json` skeletons

### `pi-lean-portal/package.json`

```jsonc
{
  "name": "pi-lean-portal",
  "version": "0.1.0",
  "description": "Pi extension. Interactive web browsing for Pi — Playwright Chromium/Firefox, accessibility-tree snapshots, profiles, cookies, guides. Owns the /web command.",
  "keywords": ["pi-package", "pi-extension", "browser", "playwright", "web"],
  "type": "module",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "files": [
    "index.ts",
    "browser-toggle.ts", "browser-profile.ts", "browser-cookies.ts", "browser-status.ts",
    "backends/", "core/", "tools/", "guides/",
    ".npmrc",
    "README.md", "LICENSE", "ship-manifest.test.ts"
  ],
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "playwright": "^1.60.0",
    "node-html-parser": "^6.1.0",
    "turndown": "^7.2.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

### `pi-lean-seer/package.json`

```jsonc
{
  "name": "pi-lean-seer",
  "version": "0.1.0",
  "description": "Pi extension. SearXNG search tool for Pi. Pairs with pi-lean-portal's /web toggle (soft peer — search-only installs are valid).",
  "keywords": ["pi-package", "pi-extension", "searxng", "search", "web"],
  "type": "module",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "files": ["index.ts", "/* …your searxng source files… */", "README.md", "LICENSE", "ship-manifest.test.ts"],
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "pi-lean-portal": "*",
    "typebox": "*"
  },
  "peerDependenciesMeta": {
    "pi-lean-portal": { "optional": true }
  }
}
```

> `peerDependenciesMeta.pi-lean-portal.optional: true` makes it a **soft peer**
> — npm won't error if portal isn't installed, but the relationship is
> documented in the graph and `npm ls` shows it.

### `pi-lean-nexus/package.json`

```jsonc
{
  "name": "pi-lean-nexus",
  "version": "0.1.0",
  "description": "Pi extension. The full pi web-tools suite — interactive browsing (pi-lean-portal) and SearXNG search (pi-lean-seer), unified under /web.",
  "keywords": ["pi-package", "pi-extension", "web", "suite"],
  "type": "module",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "files": ["README.md", "LICENSE"],
  "pi": {
    "extensions": [
      "./node_modules/pi-lean-portal/index.ts",
      "./node_modules/pi-lean-seer/index.ts"
    ]
  },
  "dependencies": {
    "pi-lean-portal": "^0.1.0",
    "pi-lean-seer": "^0.1.0"
  },
  "bundledDependencies": ["pi-lean-portal", "pi-lean-seer"]
}
```

---

## 7. Migration sequence (suggested order of work)

0. **Umbrella spike (de-risking, ~30 min)** — before any real packaging code,
   build a throwaway `bundledDependencies` umbrella with two trivial bundled
   extensions and `pi install` it. Confirm: (i) both extensions load, (ii) a
   single `/web` registers with no `:1`/`:2` suffix, (iii) `pi.getAllTools()`
   distinguishes the two children in `sourceInfo`. This validates the only
   architectural pattern with no rpiv prior-art (see §9, BLOCKER-1 in
   `REVIEW-packaging-plan.md`). Steps 1–5 can proceed in parallel with this;
   step 6 (real umbrella wiring) must **not** start until this spike passes.
   If the spike fails, the umbrella design needs rework before committing to
   it. Per `packages.md:159–176`, the pattern is Pi-documented and expected to
   work — this is a belt-and-suspenders check, not a likely failure.
1. **Create monorepo skeleton** — rename current repo dir to `pi-lean-portal`
   (decision 8); root `package.json` named `pi-lean-portal-workspace` with
   `"private": true` (distinct from the `pi-lean-portal` workspace child —
   avoids npm duplicate-name collision, matches rpiv's root ≠ children pattern).
   Set up npm workspaces (`packages/*`), port `sync-versions.js` + `release.mjs`
   from rpiv, base `tsconfig.json`, root `vitest.config.ts`.
2. **Rename `pi-browser` package → `pi-lean-portal`** — update `package.json`
   `name`, update README/AGENTS references. Code stays in place. Tests green.
3. **Rename state key + add sibling set skeleton** — in `browser-toggle.ts`,
   add a `SIBLING_TOOL_NAMES = new Set<string>([])` constant (empty for v0.1;
   populated at step 5) alongside the existing `BROWSER_TOOL_NAMES` /
   `LEARN_TOOL_NAMES` exact-name sets, and rename the persisted key from
   `browser-toggle-state` to `web-toggle-state` (§2.4). **No regex** — keep the
   existing exact-name `Set.has()` mechanism (§2.3). Update
   `browser-toggle.test.ts` to use the new key and to cover a simulated
   `web-search` tool (asserted against `SIBLING_TOOL_NAMES` membership, not a
   regex). Tests green.
4. **Add `ship-manifest.test.ts`** to portal; fix `files` array until green.
5. **Add `pi-lean-seer`** package (your existing searxng code); register its tool
   as `web-search` (decision 10). **Add `"web-search"` to portal's
   `SIBLING_TOOL_NAMES` set** (§2.3) so `/web on/off` toggles it via exact-name
   membership — no regex, no prefix contract, no false-positive risk on
   third-party `web-*` tools. **Add the `search` status slot** in
   `browser-toggle.ts`: portal sets `ctx.ui.setStatus("search", …)` based on
   whether `web-search` is in the active set, alongside the existing `browser`
   slot (decision 11) — the `browser` slot reflects only browser tools, `search`
   reflects only seer tools. Decide at implementation time whether the `search`
   slot renders when seer isn't installed (likely: only set it if `web-search`
   is present in `pi.getAllTools()`). **Implement graceful degradation**
   (decision 15): seer registers `web-search` regardless of config; on first
   call with no `searxng.url` / `SEARXNG_URL`, returns a clear setup message
   pointing at the README — keeps nexus safe to install before SearXNG is ready.
   Add seer's `ship-manifest.test.ts`.
6. **Wire `pi-lean-nexus`** umbrella package; verify one
   `pi install npm:pi-lean-nexus` loads both packages with a single `/web`
   (no `/web:1`/`/web:2`).
7. **Playwright install UX** — ship a `.npmrc` with
   `playwright_skip_browser_download=true` in `pi-lean-portal` (§5.4, decision
   3) + lazy-load in `ChromiumPlugin` + helpful-notify path on first navigate
   if browsers are missing. (Not a self-`postinstall` — see §5.4 for why that
   doesn't work; resolves reviewer NOTE-6.)
8. **Docs** — root README with install matrix (Mode A recommended /
   Mode B full-suite / Mode B-seer search-only / Mode C v0.2), per-package
   READMEs, CHANGELOGs, migration note for the `pi-browser` → `pi-lean-portal`
   rename. Lead with `pi install npm:pi-lean-portal` as the recommended install
   (decision 14); document SearXNG setup requirement for Mode B / B-seer.
9. **(v0.2)** Port rpiv's `/web-setup` (Mode C) — `SIBLINGS` table +
   `spawnPiInstall` + legacy prune.

---

## 8. Decisions (locked)

| # | Decision | Resolution |
|---|---|---|
| 1 | npm scope vs. unscoped names | **Unscoped**: `pi-lean-portal`, `pi-lean-seer`, `pi-lean-nexus` (unique enough to resist squatting) |
| 2 | Toggle-state key | **Rename to `web-toggle-state`**, no legacy reader (pre-ship, old sessions disposable) |
| 3 | Playwright download strategy | **Skip auto-download + lazy-load + notify** via a shipped `.npmrc` (`playwright_skip_browser_download=true`) — npm reads it before Playwright's postinstall runs, so the download is suppressed; ChromiumPlugin lazy-loads; notify on first navigate if browsers missing. A self-`postinstall` can't work (npm runs dependency postinstalls first). Resolves reviewer NOTE-6. |
| 4 | Versioning | **Lockstep for v0.x** (all packages share one version; switch to independent once stable) |
| 5 | Tests in `files` | **Ship `ship-manifest.test.ts` only**; all other tests dev-only |
| 6 | Status-bar glyph slot (browser group) | **Keep `"browser"`** for the browser group (internal key, zero v0.1 churn). A separate `"search"` slot for the seer group is added at seer integration (decision 11) so the browser slot isn't overloaded. |
| 7 | `/web-setup` (Mode C) | **v0.2** — v0.1 ships Mode A + Mode B + Mode B-seer only |
| 8 | Repo name | **`pi-lean-portal`** (repo dir + GitHub repo named after the main feature, the browser — most discoverable). Root `package.json` named `pi-lean-portal-workspace` (`private: true`) to avoid npm duplicate-name collision with the browser workspace child. Umbrella package stays `pi-lean-nexus` at `packages/pi-lean-nexus/`. Resolves reviewer NOTE-1. |
| 9 | `pi-lean-seer` → portal peer dep | **Soft peer** (`peerDependencies` + `peerDependenciesMeta.optional: true`; search-only installs valid) |
| 10 | Seer tool name | **`web-search`** — matches agent-training conventions so models reach for it instinctively. Portal lists `"web-search"` in its `SIBLING_TOOL_NAMES` set (§2.3) so `/web on/off` toggles it via exact-name `Set.has()` membership. **No regex, no prefix contract** — avoids false positives from third-party `web-*` tools and aligns with the Pi docs' guidance against inferring ownership from command names. Namespace boundary: portal owns the 12 `browser-*`/`web-*` tool names it already lists; seer owns `web-search` (portal must not define a tool by that name). Drift is caught at review (portal's tests reference `web-search` by exact name) under lockstep versioning (decision 4). Resolves reviewer NOTE-5 (the unenforced `seer-` prefix contract is gone) and the regex false-positive concern raised in review. |
| 11 | Search status slot | **Separate `search` glyph slot** for the seer group, owned by portal's `browser-toggle.ts` (which already groups tools by name prefix when toggling). The `browser` slot reflects only browser tools; `search` reflects only seer tools — `/web on` with browser off + seer on shows `browser: ● off` / `search: ● on`, not an overloaded browser slot. Implemented at seer integration (step 5), not v0.1. Resolves reviewer NOTE-4. |
| 12 | `/web status` grouping | **v0.1: simple list, no grouping** — `/web status` lists tools by name with on/off state (current behavior, generalized to include seer tools). The `packageFromSourceInfo()` helper (no `packageName` field on `sourceInfo`; Mode A vs Mode B path layouts differ) is deferred to v0.2. Downgrades §2.2 to match §4's "optional." Resolves reviewer NOTE-2. |
| 13 | `/web off` re-enable behavior | **Accept for v0.1** — `/web off` reconstructs the active set from the full registry, so it re-enables any seer tool the user had manually toggled off (pre-existing browser behavior, widened by the additional sibling name). Revisit at seer integration if it matters. Resolves reviewer NOTE-7. |
| 16 | Toggle discovery mechanism | **Exact-name `Set.has()` membership, not a regex.** Keep the existing `BROWSER_TOOL_NAMES` / `LEARN_TOOL_NAMES` sets; add a `SIBLING_TOOL_NAMES` set (empty for v0.1, `"web-search"` at step 5). A regex like `/^(?:web-\|browser-)/` was considered and rejected: it would match any third-party tool whose name happens to start with `web-`/`browser-` (false-positive risk — install `pi-web-scraper`, run `/web off`, their tool gets disabled). Exact names have zero false positives and work uniformly across Mode A (bundled) and Mode B (independent) installs — `sourceInfo`-based grouping is mode-dependent and deferred to v0.2 (decision 12). The Pi docs (`extensions.md:1506`) also discourage inferring ownership from command names; exact-name *toggling* is not ownership inference, but the conservative choice aligns with that guidance. Supersedes the regex approach the plan previously proposed in §2.3. |
| 14 | Recommended install | **`pi-lean-portal`** (Mode A) — least friction, works fully after `npx playwright install chromium firefox`. `pi-lean-nexus` (Mode B) reframed as the full-suite power-user option — requires a running SearXNG server + URL config, which is setup friction most users won't want up front. `pi-lean-seer` (Mode B-seer) is search-only with the same SearXNG requirement. The "recommended" label should match the install that works fully out of the box. Architecture unchanged; this is a re-ranking of the install matrix. |
| 15 | Seer graceful degradation when unconfigured | **Seer registers `web-search` normally regardless of config; on first call with no `searxng.url` / `SEARXNG_URL` set, returns a clear setup message** (not a silent failure or thrown error) pointing the user at settings + the README (self-host vs public SearXNG instance). Keeps `pi-lean-nexus` safe to install before SearXNG is ready — the browser works immediately, and `web-search` self-documents its setup. Also gives portal-only users who later add seer a clear first-use path. Seer-side design; implemented at step 5. |

---

## 9. Why this architecture (recap, for reviewers)

+ **One `/web` owner** (`pi-lean-portal`) sidesteps Pi's `/web:1`/`/web:2`
  suffixing — deterministic in every install combination.
+ **No command split** — `/web profile` / `/web cookies` stay under `/web`,
  exactly as today. No UX change for users.
+ **No degradation message** — the `/web` owner and its backer are the same
  package, so there's no missing-backer state to handle. Dead code avoided.
+ **Browser is required for `/web`** — your call; matches the fact that `/web`'s
  subcommands are browser-specific. Search-only users have nothing to toggle.
+ **Exact-name-set discovery** (`pi.getAllTools()` + `Set.has(name)`, no regex)
  sidesteps Pi's separate-module-roots rule — `/web on/off` reaches sibling
  tools with no fragile cross-package singletons and no false-positive risk on
  third-party `web-*` tools. Works uniformly across Mode A (bundled) and Mode B
  (independent) installs, unlike `sourceInfo`-based grouping (decision 12).
+ **Recommended install = `pi-lean-portal`** (decision 14) — the install
  that **works fully out of the box** after one Playwright command. Nexus
  (Mode B) is the full-suite power-user option, gated on a running SearXNG
  server + URL config; seer degrades gracefully (decision 15) so nexus doesn't
  break when SearXNG isn't set up yet — the browser works immediately and
  `web-search` self-documents its setup on first call.
+ **Umbrella `pi-lean-nexus`** uses Pi's `bundledDependencies` +
  `node_modules/...` manifest pattern for "install everything in one command"
  (documented at `packages.md` → "Dependencies"). **This pattern has no
  rpiv-mono precedent** — rpiv coordinates siblings via `peerDependencies`, not
  bundling, and ships no umbrella package. `pi-lean-nexus` is the one genuinely
  novel piece of this architecture; see §7 step 0 (the pre-implementation
  umbrella spike) and BLOCKER-1 in `REVIEW-packaging-plan.md`.
+ **Tiny migration** — portal keeps `browser-toggle.ts`, `browser-profile.ts`,
  `browser-cookies.ts`, `browser-status.ts` in place. The only code changes are
  adding an empty `SIBLING_TOOL_NAMES` set (populated at step 5) and renaming
  one persisted key (no legacy reader needed). The existing exact-name `Set.has()`
  toggle mechanism stays — no regex swap.
+ **Storage paths preserved** — `~/.pi/agent/browser-state/` path and
  `browser.plugins` settings key stay as-is; only the toggle-state session key
  is renamed.

The rpiv mono-repo validated the *mechanical* patterns we're porting
(`SIBLINGS`/`spawnPiInstall`/`ship-manifest.test.ts`/lockstep versioning/npm
workspaces). It does **not** validate `bundledDependencies` or the umbrella
meta-package concept — rpiv has neither (grep across `/root/rpiv-mono` returns
zero matches for `bundledDependencies`, and no rpiv package plays the umbrella
role). The `bundledDependencies` + `node_modules/...` pattern is verified
directly by `packages.md`, and de-risked by the step 0 umbrella spike before
any real packaging code is written.

The Option A twist — portal owns `/web` outright, siblings are silent leaves —
is simpler than rpiv's sibling-orchestrator model because our suite has a
natural required component (the browser) where theirs didn't.
