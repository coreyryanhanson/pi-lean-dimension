# pi-tool-masking — Design Document

> Status: **`pi-tool-masking@1.0.0` published on npm.** The API surface
> (§5), persist schema (§7), and `DefaultResolutionMode` (§4.5) are frozen.
> The v1 shape was verified against two real consumers before publishing:
> `pi-lean-dimension` (portal + search, migrated on the
> `refactor/break-out-masking-tool` branch) and `pi-tbox` (the user-facing
> manager, §13 — built and published as `pi-tbox@0.0.1`). The portal/search
> migration is code-complete but **not yet merged to `main` or released as
> `0.3.0`** — see `implementation-plan.md`.

## 1. Purpose

This repository is the **core library** layer of a two-layer design:

1. **`pi-tool-masking` (this package)** — a pure library. It registers
   **no tools, no commands, no event handlers** with the running pi
   process. It exports plain functions (`defineToolset`,
   `setDefaultResolutionMode`, `getDefaultResolutionMode`) and the
   `TOOLSET_EVENTS` constant that *other* pi extensions call. It is not
   a pi extension in the runtime sense (no default
   `(pi: ExtensionAPI) => ...` factory); it is a library that targets
   the pi extension API, the same way a React hook library targets React
   without being a component. It does **not** register or generate any
   user-facing command (`/web`, `/api`, …) — consumers own their commands
   and call the library's primitives inside (§10).
2. **A separate user-facing extension** — `pi-tbox`, now built and
   published (`pi-tbox@0.0.1`). It depends on `pi-tool-masking`, queries
   the registered toolsets, and offers the cross-extension "toggle any
   toolset" surface plus user-tagged groups and focus (see §13). It was
   the second consumer used to verify the v1 surface before publishing.

The library centralizes the logic for grouping tools into toggleable
**toolsets** and remembering which toolsets are active across pi-session
boundaries (`/reload`, `/resume`, `/fork`, `/tree` navigation). It is
extracted from the near-identical toggle implementations in
`pi-lean-portal` (`browser-toggle.ts`) and `pi-lean-host` (`core/api-toggle.ts`),
which duplicate ~90% of their structure: a tool-name Set, an
additive-on / filter-off `setActiveTools` dance, an `appendEntry`-based
persistence schema, and a `session_start`/`session_tree` restore path.

`pi-tool-masking` is a **required peer dependency** of portal, host,
search, and `pi-tbox`. It lives in its own repository and is consumed via
a static `import` — not a `globalThis` feature-detect, not an optional
peer. If the package is absent, any of those consumers fail to load.

## 2. Goals

1. **De-duplicate** the toggle logic across portal and host.
2. **Centralize the peer-composition invariant** (the
   additive-on / filter-off-from-`getActiveTools()` rule) so it cannot
   drift between consumers.
3. **Own conversation-state memory** for toolset on/off status —
   consumers stop writing `appendEntry` / `session_start` restore code.
4. **Decouple side-effects via `pi.events`** so a toggle actuator and its
   side-effect owner (e.g. portal toggling, search updating its status
   glyph) need no import coupling.
5. **Enable a manager extension** to offer user-tagged tool groups
   (`on`/`off`/`focus` on tagged lists) without the library's own API
   changing — the registry + event surface (§6, §6.1) and the
   default-resolution mode (§4.5) already expose what such a manager
   needs, including durable focus. `pi-tbox` (§13) now ships exactly this
   against the unchanged v1 surface.

## 3. Non-goals

- **Not** a framework. The public API is a handful of exports — two
  functions (`defineToolset`, `setDefaultResolutionMode`), one getter
  (`getDefaultResolutionMode`), the `TOOLSET_EVENTS` constant, and their
  accompanying types. The library does **not** register or generate any
  user-facing command — consumers own `/web`, `/api`, etc. and call the
  library's `enable`/`disable` primitives inside their own command
  handlers (§10). The moment `ToolsetSpec` sprouts fields only one
  consumer uses, this has become the wrong abstraction.
- **Not** a tool marketplace or discovery layer. Consumers register
  toolsets they already define; the package never invents tools.
- **Not** a home for consumer-specific conversation config. Portal's
  `defaultProfile` stays in portal (see §7).
- **No** per-tool runtime hooks. Change notification is `pi.events`,
  not custom callback registration (see §6).

## 4. Core concepts

The library operates on two orthogonal axes. Keeping them separate is
the key to not over-building:

- **Activation** (on/off) — whether a tool is in the LLM's active tool
  set, driven by `pi.setActiveTools()`. Runtime state, changes on every
  toggle.

### 4.1 Toolset

A named group of tool names governed as a unit for toggling. Each toolset
has:

- an `id` (e.g. `"portal.web"`, `"portal.learn"`, `"host.api"`)
- a `names` Set of tool names it governs
- a `persistKey` (the new write key, e.g. `toolset-state:portal.web`)
  for branch-aware state memory
- an optional `defaultEnabled` boolean — the fresh-session fallback when
  no branch entry exists. The **consumer resolves any config-file default
  at the call site** and passes the resulting boolean (see §5); the
  library does not read `settings.json` (§5.1 — no library-side reader)
- an optional `requires` array (dependency — see §4.3)
- an optional `emitMemberEvents` flag (see §6)

The library does **not** own status-bar glyphs. A toolset has no `slot` /
`glyphs` fields. The side-effect of updating a status-bar slot belongs to
whoever owns that slot, driven by `pi.events` (see §9). This keeps the
library out of UI presentation and makes portal's `browser` slot work
exactly like search's `search` slot — both listen for their own
toolset's `changed`/`restored` events and render their own glyph.

There is **no `learn` field**. "Learn mode" is not a grouping primitive;
it is a two-toolset pattern a consumer composes at the call site (base
toolset + extended toolset, where "learn" = both on). See §4.2 and §10.

A toolset tolerates `names` that aren't currently registered (filtered to
the registered subset at actuation time, matching today's `getRegisteredIn`
helper). This lets a consumer define a toolset before all its tools are
loaded, and keeps a toolset non-fatal if a sibling package is absent.

A toolset that includes another toolset's members (e.g. "portal base +
learn") is just a second toolset whose `names = base.names ∪
learn.names` — a value union at the call site, no new mechanism.
Referencing other toolsets *by id* (resolving membership through the
registry at actuation time) is deferred: it only earns its keep if
toolset membership changes dynamically after registration, which nothing
today does.

### 4.3 Toolset dependencies (`requires`)

A toolset may declare `requires: string[]` — the ids of other toolsets
that must be enabled for it to be enabled. This is a **generic
dependency primitive**, not consumer vocabulary: "A requires B" says
nothing about browsing, learning, or APIs. It exists because portal and
host share the identical pattern (an extended toolset that is
meaningless without its base), and the invariant must hold regardless of
*who* triggers the toggle — the owning extension's command handler, the
downstream manager (§13), or a future tag operation.

Rules the library enforces (one copy, one test — the peer-composition
invariant's sibling, §9):

- `enable(A)` where `A.requires = [B, C]` → transitively `enable(B)`,
  `enable(C)` before enabling A. Cycles are a spec error, detected lazily
  at first graph resolution (not at `defineToolset` time — `requires` may
  forward-reference a toolset registered later by another extension, so
  the full graph is not available at any single `defineToolset` call). The
  cascade's graph walk carries a visited-stack; on a revisit in the
  current stack it throws `Error` naming the cycle path (e.g.
  `A → B → C → A`). No separate validation pass — the walk that resolves
  `requires` is the walk that detects it. Log-and-skip is explicitly
  *not* used: a cycle is an incoherent spec and silent partial resolution
  would produce wrong state.
- `disable(B)` → cascade `disable` to every registered toolset whose
  `requires` contains `B` (and transitively, their dependents).

This is what prevents the incoherent state `portal.learn.enabled = true`
while `portal.web.enabled = false`: `portal.learn` declares
`requires: ["portal.web"]`, so enabling learn pulls web on and disabling
web pushes learn off — no matter which surface actuates it. The
consumer's command handler no longer re-implements the composition at
every call site (see §10).

### 4.5 Default-resolution mode (exclusion vs inclusion)

The library's per-toolset persistence record (`{ enabled }`, §7) is, by
default, an **exclusion record**: a toolset with no branch entry falls
back to `spec.defaultEnabled` (typically on). This matches today's
portal/host behavior — tools are on unless explicitly turned off.

An **inclusion mode** flips only the fallback for *unknown* toolsets:
the per-toolset record shape is unchanged, but a toolset with no branch
entry defaults **off** instead of to `spec.defaultEnabled`. The
mechanism is a default-resolution policy, not a new record type — same
`{ enabled }` entries, one mode bit on the restore path the library
already owns (§7.1).

```
Exclusion mode (default):  no entry → spec.defaultEnabled   → unknowns ON
Inclusion mode (focus):     no entry → false                 → unknowns OFF
```

This is the durability mechanism for focus (§13.2): when a new
extension is installed and registers toolsets E, F, G after a focus
snapshot was taken, E/F/G have no branch entry. Under exclusion mode
they would default on and silently break focus; under inclusion mode
they default off and focus survives the installation. No event-watching,
no manager re-apply loop — the library holds the line at restore time.

Scope and defaults:

- The mode is **library-level** (one setting for the whole registry),
  not per-toolset. It governs the fallback for toolsets without a
  branch entry; toolsets *with* an entry always restore that entry's
  `enabled` regardless of mode.
- It composes with `requires` (§4.4): a new toolset E (no entry) under
  inclusion mode stays off even if its `requires` target is on — focus
  means "only what I explicitly enabled." E's `requires` only fires
  when E is actuated, and it isn't.
- Portal and host never set inclusion mode — they run in the default
  exclusion mode for their entire lifecycle. The mode exists for the
  manager's focus feature. It is built into the library now (along with
  the persist schema, §7) so the v1 storage shape and API are stable
  before any consumer ships against them; the manager later flips the
  mode and supplies the focus *intent* (which toolsets are in the
  allowlist). See §13.2.

The mode is not consumer vocabulary baked into the core — it is a policy
on default resolution, which is already a library concern (§7, §8). One
bit, one place, one test.

## 5. Public API (proposed, pre-freeze)

The entire surface — keep it this small. This is a **library API**
(imported by other extensions), not an extension factory.

```ts
// index.ts — plain exports, no default factory

export interface ToolsetSpec {
  /** Stable id, e.g. "portal.web". Used in persist keys and event payloads. */
  id: string;
  /** Human-readable name for the group as a unit, e.g. "Web Browsing".
   *  Reuses the tool-metadata field name verbatim — `pi.registerTool()`
   *  already takes `label` on individual tools, and `pi.getAllTools()`
   *  returns it. Same field, same contract, so a presenter renders a
   *  toolset row and a tool row with identical field logic. No new field
   *  name is introduced.
   *
   *  The *value* is a net-new string the consumer authors for the group:
   *  no union of member `label`s synthesizes a useful group name. The
   *  library treats it as opaque pass-through — it never reads, branches
   *  on, or renders it; it stores it on the registry for presenters
   *  (picker rows, command help, the downstream manager §13).
   *
   *  Optional — presenters fall back to `id` (trimmed at the last `.` for
   *  namespaced ids: `portal.web` → `web`) when absent. */
  label?: string;
  /** One-line description of what enabling the group does, e.g.
   *  "Interactive browser automation: navigate, click, type, inspect."
   *  Reuses the tool-metadata field name verbatim — same field individual
   *  tools expose via `pi.registerTool()` / `pi.getAllTools()`.
   *
   *  The *value* is authored for the group (not derived from member
   *  `description`s); the library treats it as opaque pass-through for
   *  presenters (picker detail, command help). Optional — presenters
   *  omit the detail line when absent. */
  description?: string;
  /** Tool names this toolset governs. */
  names: Set<string>;
  /** Primary persistence key the toolset writes, e.g.
   *  "toolset-state:portal.web". */
  persistKey: string;
  /** Fresh-session fallback when no branch entry exists. The consumer
   *  resolves any config-file default at the call site and passes the
   *  resulting boolean here — the library does not read `settings.json`.
   *  There is intentionally **no** settings-reading helper on this
   *  library: merging pi's global + project `settings.json` is a
   *  pi-platform concern, not a tool-masking concern, and freezing it
   *  into a v1-frozen library surface couples this library to pi's
   *  settings layout for no toggle-related benefit. Consumers keep a
   *  local reader (portal's `core/shared/settings-reader.ts`); do not
   *  add a shared reader here — see §5.1. */
  defaultEnabled?: boolean;
  /** Dependency: ids of toolsets that must be enabled for this one to be
   *  enabled. `enable` transitively enables them; `disable` of a required
   *  toolset cascades `disable` to every toolset that `requires` it. This
   *  is the peer-composition invariant's sibling — one copy, one test
   *  (§4.4, §9). Generic: "A requires B", never consumer vocabulary. */
  requires?: string[];
  /** When true, a group toggle additionally emits one `changed` event per
   *  member tool (with the member name in `event.member`), for per-tool UIs
   *  (the downstream picker, §13). The group-level event always fires.
   *  Default false: one group-level event per toggle. */
  emitMemberEvents?: boolean;
}

// Presenters (the manager §13, a future /toolsets command) read
// `label`/`description` from the registry. Fallback when absent:
//   label  → id trimmed at last '.' ("portal.web" → "web")
//   description → omit the detail line
// The library never renders these; it only stores and exposes them.

// Under `exactOptionalPropertyTypes: true` (the monorepo's setting),
// optional fields must be OMITTED, not set to `undefined`. When a field's
// value comes from a possibly-`undefined` variable, use conditional
// spread rather than assigning `undefined`:
//   defineToolset(pi, { id, names, persistKey, ...(m !== undefined && { requires: m }) });

export interface Toolset {
  enable(pi: ExtensionAPI): void;
  disable(pi: ExtensionAPI): void;
  isEnabled(pi: ExtensionAPI): boolean;
}

export function defineToolset(pi: ExtensionAPI, spec: ToolsetSpec): Toolset;

/** Default-resolution mode for toolsets with no branch entry (§4.5).
 *  - "exclusion" (default): no entry → spec.defaultEnabled (unknowns ON)
 *  - "inclusion":           no entry → false            (unknowns OFF)
 *  Library-level: one setting for the whole registry. Portal/host stay
 *  in exclusion mode; the manager sets inclusion mode for focus (§13.2). */
export type DefaultResolutionMode = "exclusion" | "inclusion";

export function setDefaultResolutionMode(
  pi: ExtensionAPI,
  mode: DefaultResolutionMode,
): void;

export function getDefaultResolutionMode(): DefaultResolutionMode;

/** Enumerate every registered toolset in the global registry (§6.1).
 *  Returns a read-only snapshot — callers cannot mutate the live
 *  registry through the returned array. Each entry carries the full
 *  spec and the Toolset handle (enable / disable / isEnabled).
 *  No pi argument needed — enumeration is a pure registry read. */
export interface RegistryEntry {
  spec: ToolsetSpec;
  toolset: Toolset;
}

export function getRegisteredToolsets(): readonly RegistryEntry[];
```

There is **no `registerToggleCommand` export**. The library does not
own or generate user-facing commands — `/web`, `/api`, and any
subcommands (`on`, `off`, `learn`, `profile`, `cookies`, `status`, …)
are registered by the consuming extension via `pi.registerCommand()`
and call `toolset.enable(pi)` / `toolset.disable(pi)` inside. The
peer-composition invariant (§9) and the `requires` cascade (§4.4) live
in `enable`/`disable`, so a ~10-line command handler gets the full
invariant for free without a library-side command abstraction. An
auto-generated command surface with an override hook was considered and
rejected: its first real consumer (portal's `/web`) overrides roughly
half the generated subcommands, so the "default" is dead weight and the
override hook costs more than the dispatch it saves (see §15).

### 5.1. No settings reader (intentional)

The library exports **no** settings-reading helper and never reads
`settings.json`. `restore`/`enable`/`disable` use only
`spec.defaultEnabled` — a boolean the consumer already resolved before
calling `defineToolset`. That contract is unchanged by the absence of a
library-side reader; the consumer just reads its own settings to
produce the boolean.

Rationale:

- **Wrong scope.** Merging pi's global + project `settings.json` is a
  pi-platform concern any extension might want, not a tool-masking
  concern. Shipping it here makes the tool-masking library the
  accidental home of "how to read pi settings" simply because it was the
  first package that needed a default.
- **Freeze cost.** The §5 surface is frozen at v1. A reader here locks
  its assumptions (`~/.pi/agent/settings.json` + `.pi/settings.json`,
  project overrides global, JSON, sync reads) into a published library
  whose core logic never touches the disk. If pi's settings storage
  changes, a toggle library breaks for reasons unrelated to toggling.
- **Small duplication.** The reader exists to delete ~15-line copies in
  portal and host. Two copies of a trivial file reader, in two repos, is
  low drift risk and not enough to justify freezing an unrelated API.
- **Misleading surface.** An export named `readMergedSettings` on a
  library whose design says "the library does not read `settings.json`"
  invites the conclusion that the library touches the disk as part of
  its core flow. It does not; the export contradicts the contract.

**Do-not-add rule:** a `readMergedSettings` (or any `settings.json`
reader) must not be added to this library. If a third consumer appears
and the duplication stings, the home is a separate `pi-settings` package
or an `ExtensionAPI` method upstreamed to pi — never this library. The
Sprint 3 reader was removed before v1 shipped; see
[`revert-settings-reader.md`](./revert-settings-reader.md).

## 6. Change notification: `pi.events`, not custom hooks

The package emits typed events on every toolset status change. Consumers
listen with `pi.events.on(...)`. There are **no per-tool callback hooks** —
a custom hook system would reinvent the documented cross-extension bus
with worse decoupling.

```ts
export interface ToolsetChangedEvent {
  /** Toolset id (e.g. "portal.web"). Always set. */
  id: string;
  enabled: boolean;
  /** Present only when emitMemberEvents is on and this is a per-member fanout
   *  event: the member tool's name. Absent on the group-level event. Consumers
   *  that only care about group state check `if (!event.member)` or ignore
   *  member events entirely — a listener for `id === "portal.web"` still
   *  receives the group-level event regardless of emitMemberEvents. */
  member?: string;
}

export const TOOLSET_EVENTS = {
  /** Emitted on enable/disable AND on initial-state establishment from a
   *  config/packaged default (the no-persist-entry fresh-session case).
   *  Always one group-level event (id = toolset id). When emitMemberEvents
   *  is set, additionally one event per member tool with that tool's name in
   *  `member` (and the same group `id`). */
  changed: "toolset:changed",    // ToolsetChangedEvent
  /** Emitted after session_start / session_tree restore re-applies a
   *  PERSISTED entry from a prior session (restoration of prior intent).
   *  NOT emitted when a toolset falls back to its config/packaged default
   *  — that is initial-state establishment, which emits `changed`. The
   *  split lets a companion (§10.1) mirror a config default without
   *  clobbering an independent manager-disable on restart. */
  restored: "toolset:restored",  // ToolsetChangedEvent
} as const;
```

**The always-emit invariant.** Restore emits exactly one event per
registered toolset on every `session_start` / `session_tree` — `changed`
for a default fallback, `restored` for a persisted entry. It does **not**
skip the emit when the resolved state happens to equal the default.
Skipping would break the companion mirror in the fresh-default case
(search would never learn portal configured itself off) and would leave
`search.web` with no persist entry, violating the manager-independence
invariant (§10.1). One event per toolset, every restore, no exceptions.

**Restore is idempotent / last-writer-wins.** `enable`/`disable` are
idempotent (a second call with the same state is a no-op and emits
nothing), and restore writes its resolved state once. This keeps the
load-order interleaving safe: if search loads after portal, portal's
restore runs first and the companion mirror calls
`searchToolset.disable(pi)` (writing `toolset-state:search.web`), then
search's own restore reads the branch and finds the entry the mirror
just wrote — same final state, no double-emit, no race. This is what
eliminates the current "portal's `session_start` must fire before
search's" ordering constraint.

**Restore never persists a default fallback.** When restore resolves a
toolset with *no* branch entry to `spec.defaultEnabled`, it applies the
resolved state and emits `changed` — but it does **not** call
`appendEntry`. Only an explicit `enable()`/`disable()` persists an entry
(including a companion-mirror call like `searchToolset.disable(pi)`,
which is an explicit toggle action, not a default persistence). The
persist record is an *override*, and a toolset with no entry is
*unoverridden*: its default is recomputed from `spec.defaultEnabled`
(resolved by the consumer from config at `defineToolset` time) on every
restore, so a config-default edit takes effect on the next entry-less
restore instead of being shadowed by a stale persisted fallback.

This is what makes the `changed`/`restored` split load-bearing across
`/resume` and `/fork`, not just on a cold `session_start`. If restore
persisted the default, the *first* `session_start` would emit `changed`
(good), but every subsequent `session_tree` would find an entry and emit
`restored` — and the §10.1 "fresh config off → search mirrors → off"
row silently breaks on the second fork: `portal.web` emits `restored`,
the companion mirror listens on `changed` only, and `web-search` stays
live despite `browserToggle: false`. Keeping the default unpersisted
holds the §10.1 matrix uniformly across every restore path.

This replaces portal's current `setSearchSlot()` reach into search's
status slot: portal emits nothing, search registers its own `search.web`
toolset, co-activates it by listening for `changed` on `portal.web`, and
owns its own `search` glyph (tracking `search.web`'s state). Portal no
longer references search. See §10 / §10.1 for the full pattern and the
companion-vs-`requires` distinction.

> **Listener lifecycle.** `pi.events.on(...)` returns a cleanup
> function, but toolset-event listeners are **session-lifetime** — the
> library and its consumers register them once at module load and never
> unregister. Pi does not unload extensions mid-session, so storing /
> invoking the cleanup function is unnecessary. (If pi ever gains
> mid-session extension unloading, revisit this — the library would need
> to own cleanup for its own restore listener then.)

> **`ctx` capture pattern.** `pi.events` listeners receive only `(data)`,
> not `ctx`, so a listener that needs to touch the UI (e.g.
> `ctx.ui.setStatus`) captures `ctx` from its own `session_start` handler
> into a module variable and reuses `ctx.ui` in the bus listener.
> `ctx.ui` is stable across the session; only `ctx.sessionManager` is
> stale-sensitive (not used by glyph listeners). This is the documented
> pattern — see pi's `examples/extensions/event-bus.ts`.
>
> **Capture-ordering hazard.** Pi's extension runner dispatches
> `session_start` to handlers **in registration order** (the runner
> `await`s each handler sequentially), and `pi.events.emit` dispatches
> **synchronously** (Node `EventEmitter`). `defineToolset` registers its
> restore handler during the factory call, so if a consumer registers its
> `ctx.ui`-capture handler *after* calling `defineToolset`, the library's
> restore fires first, emits `restored`/`changed`, and the glyph `render`
> listener early-returns (`ui` still `undefined`) — the consumer's capture
> handler runs later but the event has already passed. **Fix: call
> `render()` at the end of the capture handler itself**
> (`pi.on("session_start", … => { ui = ctx.ui; render(); })`). This paints
> the post-restore state exactly once, regardless of whether capture was
> registered before or after `defineToolset`. The `changed`/`restored`
> listeners still own all subsequent updates (mid-session `session_tree`
> forks/resumes where `ui` is already captured). See §10 for the concrete
> shape in both the portal and search blocks.

> **Restore-handler dedup (and the `/reload` pitfall it fixes).** Every
> `defineToolset` call registers a `session_start` + `session_tree` restore
> handler on its `pi` (one per toolset per extension — cheap). Restore is
> deduped **at runtime by event-object identity**, not at registration
> time: the runner passes one shared `event` reference to every
> extension's handler in a single `emit()` call, so the first handler
> stamps `globalThis.__piToolMaskingLastRestoreEvent = event` and runs
> restore; the remaining handlers see the same `event` and no-op. Each
> `/reload` (and each `session_tree`/resume/fork emit) constructs a fresh
> event object, so restore re-runs against the fresh `pi` with no stale
> guard. The handler closes over the *current* `pi`, so a post-reload
> handler captures the fresh, non-stale API.
>
> This is the fix for a real pitfall caught in review: an earlier version
> guarded registration with a boolean on `globalThis`
> (`__piToolMaskingRestoreHandlerRegistered`). On `/reload`, pi discards
> the old `Extension` and builds a fresh `ExtensionAPI` per extension but
> does **not** clear `globalThis` — so the stale `true` survived, the
> fresh extension's `defineToolset` skipped handler registration, and
> `session_start` dispatched to an empty handler list: **restore silently
> never ran.** Dedup-by-event-identity makes the guard runtime instead of
> registration-time, so a fresh extension always registers a fresh handler
> and a fresh event always re-runs restore. This is distinct from the
> registry's own reload-safety (§6.1, idempotent-by-content
> re-registration) — that governs the *registry*; this governs the
> *restore handler*. The two mechanisms are independent and both required.

`emitMemberEvents` is the one forward-compat knob for the downstream
picker (§13): when on, a group toggle additionally fans out to one
`changed` event per member tool (with the member name in `event.member`)
so a per-tool UI updates without the manager re-deriving membership. The
group-level event always fires regardless — consumers keyed to a toolset
id (search listening for `portal.web`) are unaffected by the flag.
Default `false` keeps today's one-event-per-group behavior.

### 6.1 Shared registry on `globalThis` (cross-instance)

`defineToolset` records each toolset in an internal registry so a
*separate* extension (the user-facing manager `pi-tbox`, §13) can query
"which toolsets exist across all installed extensions" and toggle them.

That registry **must live on `globalThis`, not module-level state**.
Pi installs each package with separate module roots (per `packages.md`:
"Pi loads packages with separate module roots, so separate installs do
not collide or share modules"), so portal, host, and the manager each
get their own copy of the `pi-tool-masking` module under their own
`node_modules/`. Module-level state (a `Map` registry) would fragment:
portal registers into its copy, the manager reads its own empty copy.

`globalThis.__piToolMaskingRegistry` (idempotently initialized by every
copy of the library) converges all instances on one registry regardless
of how many times jiti loads the module. This is the same pattern used in
`pi-lean-host`'s `portal-projection.ts` boundary-safe detection
(`globalThis.__piLeanPortalRegisterGuideProvider`). The convergence is
now **proven in production**: `pi-tbox` (§13) queries
`getRegisteredToolsets()` from its own module copy and enumerates
toolsets registered by `pi-lean-portal` / `pi-lean-search` from theirs —
the same shared `globalThis` registry — against the published `1.0.0`.

The registry stores each toolset's `spec` (at minimum `id`, `names`,
`requires`) plus the `Toolset` object, keyed by `spec.id`. The
manager extension queries it and calls `toolset.enable(pi)` /
`disable(pi)` with its **own** `pi` — all extensions in a pi session
share the same underlying runtime, so `setActiveTools` / `appendEntry`
issued through the manager's `pi` act on the same session state the
registering extension would touch. Passing `pi` explicitly to each call
(rather than capturing it at `defineToolset` time) keeps the registry
from holding session-bound references that could go stale across
`/reload` / `/resume`.

**Collision policy (v1).** `defineToolset` **throws** on a duplicate
`spec.id` and on a duplicate `persistKey` — both are programmer errors,
not recoverable states, and a throw at registration beats silent
clobbering of another extension's `{ enabled }` entry or registry slot.
With three+ independent extensions plus a manager all funneling
into one shared registry, an unenforced collision is the most likely
silent-failure mode. The `toolset-state:<id>` convention keeps collisions
unlikely in practice; validating uniqueness at registration makes them
impossible in production. (If `persistKey` is later derived from `id`
inside the library, the second check becomes trivially true — leave the
consumer-supplied field for now, but keep the guard.)

**Reload/resume-safe re-registration.** The registry lives on
`globalThis`, which pi does **not** clear on `/reload` or `/resume`
(verified in pi's `agent-session.js` reload path: no `globalThis`
cleanup; `resourceLoader.reload()` re-invokes every factory). On
`/reload`, jiti re-evaluates the module (`moduleCache: false`) and every
factory calls `defineToolset(pi, { id: "portal.web", ... })` again. On
`/resume`, the factory is re-invoked against the same cached module —
same call. A naive throw-on-duplicate would make both paths fatal: the
second `defineToolset` finds the prior entry on the persistent
`globalThis` registry and throws. The current `browser-toggle.ts` dodges
this with module-level state (re-created on reload) plus an explicit
`resetToggleModuleState()` call at the top of the factory; the library
cannot, because the registry's whole purpose (§6.1) is to persist across
module copies.

Resolution: **`defineToolset` is idempotent by content.** A second call
with the same `id` and a `deepEqual`-identical `spec` is a no-op that
returns the existing `Toolset` handle — this is the `/reload` /
`/resume` case (no edit in between, so the spec is byte-identical). A
second call with the same `id` and a *changed* `spec` replaces the entry
and warns (the reload-after-edit case). A genuine cross-extension
collision — two different extensions registering the same `id` with
non-`deepEqual` specs — still throws; that is the programmer error the
guard exists for, and it is distinguishable from reload re-entry because
the spec differs. `deepEqual` (not reference equality) is the right
comparison: jiti hands back a fresh module object on every reload, so
the `spec` argument is always a new object even when semantically
identical — reference equality would throw on every reload.

This dissolves the obvious follow-up — "does `defineToolset` need to
distinguish same-source re-registration from cross-extension collisions?"
— without needing source-path tracking or a shutdown handler: "same
registration" is defined as "same `id` + `deepEqual` spec," which is
unambiguous and does not depend on module identity (which changes every
reload). The design's "the library never registers a shutdown handler"
stance (§10) is preserved: the registry is **not** cleared on
`session_shutdown`, it is reconciled on re-entry. If a cross-extension
id clash ever becomes a real config bug in practice, pair this with a
`session_shutdown` registry clear as defense-in-depth (within one load
pass collisions still throw; reload/resume re-entry is still safe) — but
ship idempotent-by-content first, since it alone covers both reload and
resume.

Exposing `names` in the registry is what lets the downstream
picker (§13) derive addressable units: tools are individual
addressable units. The library
does not provide a `getToggleUnits()` helper — that derivation is
trivial and belongs to the manager, not the library (building it here
is the framework smell §3 warns against).

The important boundary: **toggle actuation stays a static import** —
portal calls `defineToolset` directly, the hard-dep story from §1 holds,
no globalThis needed for that path. Only the **registry** — the part that
exists specifically to be observed by a separate extension that is NOT a
static-import consumer — uses globalThis. Clean split, proven pattern.

## 7. Conversation-state ownership

The package owns **toolset on/off memory only**. Each toolset
persists `{ enabled }` under its `persistKey` (the new
`toolset-state:<id>` key) and restores it on `session_start` +
`session_tree`. The persist schema is stable from v1: the same `{ enabled }`
record is read the same way under both default-resolution modes (§4.5) —
the mode only changes the fallback for a toolset with *no* branch entry,
never the shape of an entry that exists.

**Consumer-specific conversation config does NOT move.** The motivating
case is portal's `defaultProfile` field, which today rides inside the
`web-toggle-state` entry:

```ts
// portal today — overloaded entry
interface BrowserToggleState {
  browserToolsEnabled: boolean;   // ← portal.web toolset state (moves to pi-tool-masking)
  learnToolsEnabled: boolean;     // ← portal.learn toolset state (moves to pi-tool-masking)
  defaultProfile: string;         // ← portal-specific (stays in portal)
}
```

Clean split:

- `pi-tool-masking` writes `toolset-state:portal.web` = `{ enabled }`
  and `toolset-state:portal.learn` = `{ enabled }` — two independent
  entries (learn is its own toolset now, §4.1).
- `pi-lean-portal` writes its own `pi.appendEntry("portal-conversation-state",
  { defaultProfile })` on profile change.

Two entries, two owners, zero coupling. The package's schema never learns
what a browser profile is, and never grows a generic `extra?: Record` bag
(that would be the framework smell). Portal's `setConversationDefaultProfile`
calls one extra `appendEntry` — negligible cost.

### 7.1 Restore independence

Each toolset restores from its own `toolset-state:<id>` entry. A toolset
*with* an entry always restores that entry's `enabled`, regardless of the
default-resolution mode (§4.5) — the mode only affects toolsets with *no*
entry. A toolset with *no* entry resolves to `spec.defaultEnabled`, emits
`changed`, and does **not** persist (§6: restore never persists a
default fallback). Portal's restore does not depend on host's
`session_start` handler firing first, and vice versa. The only
cross-*extension* observer is search, which co-activates its own
`search.web` toolset off `portal.web`'s `changed` event and renders its
glyph off `search.web`'s own `changed`/`restored` events (§10.1) — so
neither depends on the other's `session_start` handler firing first,
eliminating the current portal-`session_start`-vs-search-`session_start`
race. (Portal also listens for its own toolset events to render its
`browser` glyph, but that is a same-extension observer, not a
cross-extension one.)

**`session_tree` vs today's code.** The current `browser-toggle.ts`
`session_tree` handler calls only `restoreFromBranch` and is a no-op on
an entry-less branch (tools stay in their current in-memory state). The
library's restore instead *always* resolves — entry or recomputed
default — and emits. On an entry-less branch (e.g. a fresh fork that
didn't inherit entries) this applies the config default where today it
is a no-op. This is an intended improvement, not a regression: an
unoverridden toolset converges to `spec.defaultEnabled` on every branch,
and because the default is not persisted (§6), the next `/resume` of an
*unoverridden* branch still recomputes fresh — config-default edits
remain effective across forks. An *overridden* branch (one that wrote
an explicit toggle) restores that override as `restored`, unchanged
from today's semantics.

**Persisted state is always consistent.** The `requires` cascade
(§4.4) makes an incoherent persisted combo unreachable during live
toggling — you cannot persist `portal.web = false` while
`portal.learn = true`, because `enable(learn)` transitively enables
`web` and `disable(web)` cascades `disable` to `learn`. Restore reads
each toolset's own entry independently, so registration order cannot
produce an inconsistent restored state either. Register toolsets in
dependency order (base before dependent: `portal.web` before
`portal.learn`) as defense-in-depth — it is cheap and keeps the restore
trace readable — but the invariant does not depend on it.

Two restore-path details, both deliberate and verified by tests: (1)
restore applies each toolset's entry **independently and does NOT re-run
the `requires` cascade** — persisted state is already consistent (the
live cascade made any incoherent combo unreachable), so re-cascading on
restore would only double-toggle and break the independence above. (2)
restore's disable branch filters active tools by `spec.names.has(n)` —
the full spec membership, not just the registered subset — so it matches
live `disable()` (`_applyDisable`, §9): an unregistered spec member that
is somehow active is removed on restore exactly as a manual `disable`
would remove it. The enable-side filter-to-registered stays (you cannot
activate an unregistered tool, §4.1).

## 8. No legacy persistence migration

There is **no** legacy read path. Branches created before 0.3.0 (the
release that introduces `pi-tool-masking`) restore tools to
`spec.defaultEnabled` and portal's `defaultProfile` to the fresh-session
default. The genuinely valuable persisted state — cookies, localStorage,
named profiles, `browser-state/<profile>/storage-state.json` — lives in
`~/.pi/agent/pi-lean-portal/browser-state/`, completely outside the old
`web-toggle-state` / `api-toggle-state` entries, and is unaffected.

What an old branch loses on first `/resume` under 0.3.0 is exactly two
one-toggle corrections: tool on/off memory (tools return to the config
default) and `defaultProfile` (returns to session/none). No cookies
evaporate, no named profile is deleted. A user who'd done `/web off`
sees tools back on and re-runs `/web off`; a user who'd set a profile
re-runs `/web profile <name>`. That is a one-time UX blip per old branch
on upgrade, not data loss, and does not justify a `legacyPersistKeys`
field on every `ToolsetSpec`, a scan-and-boolean-map read path in
`restore()`, a cross-consumer "drop after one cycle" coordination
burden, and dedicated legacy-read tests — nor the portal-side dual-read
the library-only-reads-booleans split would force for `defaultProfile`.

// ponytail: no legacy read path. Old branches reset to defaults; the
// persisted browser state that actually matters lives outside the entry.

## 9. The peer-composition invariant (load-bearing)

The single most important line in the package. Lives in `disable()`:

```ts
disable(pi: ExtensionAPI): void {
  const current = pi.getActiveTools();        // NOT getAllTools()
  pi.setActiveTools(current.filter((n) => !this.spec.names.has(n)));
  // then cascade disable to dependents (§4.4)
}
```

`enable()` is additive: `[...new Set([...current, ...registered])]`,
where `registered` is `spec.names` filtered to tools actually present in
`pi.getAllTools()` (see §4 — a toolset tolerates unregistered names).
`enable()` also transitively `enable()`s every toolset in `spec.requires`
before applying its own change (§4.4).

`disable()` filters `spec.names` out of the *currently active* set (the
rule below), then cascades `disable()` to every registered toolset whose
`requires` contains this one's id (§4.4).

The library does **not** call `ctx.ui.setStatus`. `enable`/`disable`
take only `pi` (for `setActiveTools` + `appendEntry`), not `ctx`. Status-
bar glyphs are a side-effect owned by whoever owns the slot: the consumer
listens for `TOOLSET_EVENTS.changed`/`restored` and renders its own glyph.
This makes portal's `browser` slot work exactly like search's `search`
slot — both listen, neither is reached into. See §10.

**Why `getActiveTools()` and not `getAllTools()` on disable:** using
`getAllTools()` would re-activate every registered tool outside this
toolset's set, silently re-enabling tools another toggle (e.g. host's
`/api off`) has already disabled. This is the bug class the extraction
exists to kill. One copy, one test, one place to break it.

The canonical tests:

- **Peer composition:** two toolsets A and B, both enabled; disable A;
  assert B's tools remain active and A's are gone. Disable B; assert A's
  tools are *not* re-activated.
- **Dependency cascade:** toolset L declares `requires: ["B"]`; `enable(L)`
  → B is enabled too; `disable(B)` → L is disabled too; `enable(L)` while
  B is independently disabled re-enables B. No path produces
  `L.enabled && !B.enabled`.

## 10. Consumer integration (post-extraction)

### pi-lean-portal

`browser-toggle.ts` collapses from ~450 lines to roughly:

```ts
import { defineToolset, TOOLSET_EVENTS } from "pi-tool-masking";
import { readMergedSettings } from "./core/shared/settings-reader.js";

// Consumer resolves the config-file default once at load time, from its
// own local reader — the library never reads settings.json itself (§5.1).
const webDefault = readMergedSettings().browserToggle?.defaultEnabled ?? true;

const webToolset = defineToolset(pi, {
  id: "portal.web",
  names: BROWSER_TOOL_NAMES,
  persistKey: "toolset-state:portal.web",
  defaultEnabled: webDefault,
});

const learnToolset = defineToolset(pi, {
  id: "portal.learn",
  names: LEARN_TOOL_NAMES,
  persistKey: "toolset-state:portal.learn",
  defaultEnabled: false,                     // learn starts off
  requires: ["portal.web"],                  // learn is meaningless without web (§4.4)
});

// Portal owns the /web command outright — no library command generator.
// The requires invariant (§4.4) does the composition; the handler is
// ~10 lines of dispatch calling toolset.enable/disable.
pi.registerCommand("web", {
  description: "Enable/disable browser automation tools. Usage: /web on | off | learn | status | profile | cookies",
  handler: async (args, ctx) => {
    const cmd = args.trim().toLowerCase();
    if (cmd === "on")         { webToolset.enable(pi); learnToolset.disable(pi); }
    else if (cmd === "learn") { learnToolset.enable(pi); }        // pulls web on via requires
    else if (cmd === "off")   { webToolset.disable(pi); }         // cascades learn off via requires
    else if (cmd === "profile" || cmd.startsWith("profile "))
      await handleProfileSubcommand(cmd.slice("profile".length).trim(), ctx, pi);
    else if (cmd === "cookies" || cmd.startsWith("cookies "))
      await handleCookiesSubcommand(cmd.slice("cookies".length).trim(), ctx);
    else if (cmd === "status")
      handleStatusSubcommand(ctx, webToolset.isEnabled(pi), learnToolset.isEnabled(pi));
    else /* default */ ctx.ui.notify(/* …status help… */, "info");
  },
});

// Portal owns its own `browser` status-bar slot — listens, renders glyph.
// `pi.events` listeners receive only `(data)`, no `ctx`, so capture `ctx`
// from session_start and reuse its `.ui` (the documented pattern — see
// pi's examples/extensions/event-bus.ts). `ctx.ui` is stable across the
// session; only `ctx.sessionManager` is stale-sensitive (not used here).
let ui: ExtensionContext["ui"] | undefined;
pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; render(); });

const render = () => {
  if (!ui) return;
  const on = webToolset.isEnabled(pi), learn = learnToolset.isEnabled(pi);
  ui.setStatus("browser",
    !on ? "○ web off"
      : learn ? ui.theme.fg("success", "●") + " idle"
      : ui.theme.fg("accent", "●") + " idle");
};
pi.events.on(TOOLSET_EVENTS.changed, render);
pi.events.on(TOOLSET_EVENTS.restored, render);
```

`render()` is called from inside the `session_start` capture handler so
the first paint lands on the post-restore state regardless of handler
registration order (see the capture-ordering note in §6).

The `/web` command handler is portal's own — `profile`, `cookies`, and
`status` (portal's status shows sessions/plugins/profiles, not just
on/off) stay where they belong, with no library override hook needed.
The `requires` invariant (§4.4) makes the composition a one-liner:

```ts
// /web on    → webToolset.enable(pi);   learnToolset.disable(pi);   // learn off, web on
// /web learn → learnToolset.enable(pi);                          // pulls web on via requires
// /web off   → webToolset.disable(pi);                           // cascades learn off via requires
```

- `SIBLING_TOOL_NAMES` / `setSearchSlot` block: **deleted**. Search owns
  its own `search.web` toolset and co-activates off `portal.web`'s
  `changed` event — see §10.1. Portal no longer touches search's tools
  or its status slot.
- `defaultProfile`: portal keeps a separate `appendEntry`.
- `restoreFromBranch` / `applyConfigDefault` / `session_start` restore
  wiring: **deleted** — owned by `defineToolset`.
- Status-bar glyph logic: portal's own `changed`/`restored` listener,
  not a library concern.

### pi-lean-host

`core/api-toggle.ts` collapses the same way against `host.api` /
`api-toggle-state`, resolving its config default from its own local
reader as `readMergedSettings().apiToggle?.defaultEnabled ?? false`
(host keeps its own `settings-reader.ts`; the library exports none —
§5.1).

### pi-lean-search

Search registers its **own** `search.web` toolset (so the tool is
toggleable, persistent, and discoverable by the manager (`pi-tbox`, §13))
and co-activates it with `portal.web` by listening for `changed` events
— not `restored`. The glyph then tracks `search.web`'s own state, not
portal's.

```ts
import { defineToolset, TOOLSET_EVENTS } from "pi-tool-masking";

const searchToolset = defineToolset(pi, {
  id: "search.web",
  names: new Set(["web-search"]),
  persistKey: "toolset-state:search.web",
  defaultEnabled: true,
});

// Co-activation: /web on brings search on, /web off takes it off.
// Listen on `changed` ONLY — not `restored`. On restore, each toolset
// honors its own persist entry, so an independent manager disable of
// search survives session restart (see §10.1).
pi.events.on(TOOLSET_EVENTS.changed, ({ id, enabled }) => {
  if (id === "portal.web") {
    if (enabled) searchToolset.enable(pi);
    else searchToolset.disable(pi);
  }
});

// Glyph tracks search.web's OWN state (not portal.web's). The chain is:
// /web on → portal.web changed → co-activation enables search.web →
// search.web changed → glyph renders. One direction, no double-toggle.
let ui: ExtensionContext["ui"] | undefined;
pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; render("search.web", searchToolset.isEnabled(pi)); });
const render = (id: string, enabled: boolean) => {
  if (id !== "search.web" || !ui) return;
  // search glyph reflects search.web activation; health probe is separate
  ui.setStatus("search", enabled ? /* healthy color */ : "○ searxng");
};
pi.events.on(TOOLSET_EVENTS.changed, ({ id, enabled }) => render(id, enabled));
pi.events.on(TOOLSET_EVENTS.restored, ({ id, enabled }) => render(id, enabled));
```

`render()` is called from inside the capture handler (with search.web's
own post-restore state) so the first paint lands regardless of handler
registration order — see the capture-ordering note in §6.

Portal no longer references search at all. The coupling direction is
**companion listens for base**, never the reverse: portal (the base
capability) stays ignorant of search (the add-on) — the correct
dependency direction, and what §6 already wants.

Each consumer that owns a status-bar slot keeps its own
`session_shutdown` handler to clear it (search already does this for
its `search` slot today). The library never registers a shutdown
handler — glyph cleanup is a consumer concern, symmetric with glyph
ownership.

### 10.1 Companion co-activation vs `requires`

Portal/search is **not** a `requires` (§4.4) relationship. `requires`
models an asymmetric dependency — "learn is meaningless without web" —
and only gives one direction for free: `disable(B)` cascades to
dependents. The enable direction is deliberately not symmetric
(`enable(A)` pulls in `A.requires`, but enabling B does **not** enable
A's dependents — otherwise `/web on` would force-enable `portal.learn`,
which shares the same `requires: ["portal.web"]`).

Portal/search is symmetric **UX co-activation**: the user thinks of
`/web on` as "turn on the web tools," and `web-search` is one of those
tools. `requires` is the wrong primitive here, both semantically (search
is a stateless SearXNG fetch that works fine with no browser) and
directionally. The event-listener mirror above is the right primitive:
symmetric, one-directional (companion listens for base), and it leaves
`requires` doing only what it's good at.

**Why `changed` and not `restored` for the co-activation mirror.** The
`changed` vs `restored` split (§6) is what makes this work:

- **Persisted entry from a prior session** → `restored`. Companions hold
  their ground: their own persist entries win, so an independent manager
  disable of search survives a restart instead of being clobbered by a
  portal `restored` listener.
- **Config/packaged default (no persist entry)** → `changed`. This is
  initial-state establishment, not restoration of prior intent, so the
  companion mirrors it — a fresh session with `browserToggle: false` in
  settings propagates `/web off` to search, and `web-search` starts
  disabled. Without this, search would stay live (pi activates every
  extension tool at startup) despite the user configuring the web tools
  off.

The mirror listens on `changed` only. On restart, each toolset restores
from its own `toolset-state:<id>` entry: `search.web` restores to
whatever the cascade last persisted (consistent with portal), but a
prior independent manager disable is also honored (its own entry
wins). The matrix:

| Scenario | portal.web | event | search.web |
|----------|-----------|-------|------------|
| Fresh, config off | default false | `changed` | mirrors → off |
| Fresh, default on | default true | `changed` | mirrors → on |
| Restart after `/web off` | persisted false | `restored` | own persist false |
| Restart, manager disabled search (portal on) | persisted true | `restored` | own persist false (not mirrored) |

This is the invariant that lets an independent search toggle coexist
with the group behavior, while still syncing the config-default case.

If a second sibling group ever appears, promote the listener to a
declarative `companions: string[]` primitive (undirected companion
graph, registry-resolved) — but one group today does not justify it.

## 11. Dependency & versioning strategy

- `pi-tool-masking` is a **`peerDependency`** of portal, host, search, and
  `pi-tbox` — declared in each consumer's `peerDependencies` alongside the
  other shared pi-ecosystem packages (`@earendil-works/pi-ai`,
  `pi-coding-agent`, `pi-tui`, `typebox`), which are all peers too. A peer
  dep expresses "the host tree provides one shared instance" — the
  correct npm idiom for a library several extensions import, since it
  avoids each consumer bundling its own copy. It is a **required** peer
  (not optional): npm v7+ errors if it can't be resolved, and if the
  package is absent the consumer fails to load. (Search depends on it for
  the `TOOLSET_EVENTS` constant it listens for in §10; portal and host
  depend on it for `defineToolset` and the `Toolset.enable`/`disable`
  primitives their command handlers call; `pi-tbox` depends on it for
  `getRegisteredToolsets` + `setDefaultResolutionMode`.)
- Pinned `"pi-tool-masking": "^1.0.0"` in each consumer's `peerDependencies`
  (portal and search already ship this pin on the migration branch;
  `pi-tbox` ships it in its published `0.0.1`).
- The `globalThis` registry (§6.1) is robust to either module resolution:
  if pi hoists one shared instance (the peer-dep intent), the registry is
  a harmless single-writer; if pi loads separate copies, the registry is
  what converges them. Belt-and-suspenders, not a contradiction.
- Lockstep versioning across the **five** repos (pi-tool-masking +
  portal + host + search + pi-tbox), mirroring the monorepo's existing
  `scripts/sync-versions.js` discipline. A semver-major change in the
  masking package forces coordinated releases across all five.
- No build step — source-only TS loaded by jiti, same as every pi
  extension.

## 12. Testing strategy

- **In `pi-tool-masking`'s repo:** a MockPI that records
  `setActiveTools` / `appendEntry` calls. The canonical test is the
  peer-composition invariant from §9. Plus persistence round-trip
  (write → restore → assert re-applied), the `requires`-cycle throw, and
  the default-resolution mode test: register toolset A (with entry,
  enabled) and toolset B (no entry); under exclusion mode B defaults on,
  under inclusion mode B defaults off, while A's entry is honored in
  both — proving the mode flips only the fallback for unknown toolsets.
- **GlobalThis registry convergence (required).** The most novel
  mechanism is the multi-instance `globalThis.__piToolMaskingRegistry` —
  it cannot be verified by reading code alone and is the primary thing
  that could silently fail in production (portal registers into its own
  module copy, the manager reads an empty registry). The test simulates
  two isolated module loads against one shared `globalThis` (e.g. clear
  the module cache, import the library a second time under a fresh
  `jiti` instance), registers a toolset from copy A, and asserts copy B's
  registry enumerates it. Without this, the §6.1 convergence guarantee
  is asserted only by prose.
- **In `pi-lean-portal` / `pi-lean-host`:** thin integration tests that
  call `defineToolset` against a MockPI, plus consumer-specific glyph /
  command tests. **Do not** duplicate the invariant tests here — one
  home for the invariant, one test. Duplicated invariant tests across
  two repos is the framework smell.

## 13. User-facing manager extension (`pi-tbox`)

> **Status: realized.** `pi-tbox` is built and published (`pi-tbox@0.0.1`).
> It was the second consumer used to verify the v1 surface before this
> library was published — exercising the globalThis registry convergence,
> the `changed`/`restored` event split, and `setDefaultResolutionMode`
> against a real pi extension lifecycle. The library's API needed no
> change to support it; the section below records the design rationale
> `pi-tbox` implements.

A **separate, real pi extension** (not this repo) that depends on
`pi-tool-masking` and provides the end-user upgrade path:

- a cross-extension "toggle any installed toolset" surface (queries the
  globalThis registry from §6.1, calls `Toolset.enable/disable` across
  all registered toolsets regardless of which extension owns them),
- user-tagged tool groups (`on`/`off`/`focus` on tagged lists),
- whatever UI (command, TUI component, status surface) the manager wants
  to present.

Because the manager is a separate extension, the upgrade path is
**opt-in**: users who don't install it get exactly today's experience
(portal's `/web`, host's `/api`). Users who do install it get the unified
cross-extension surface. The library's API needs no change to support it
— the registry + `TOOLSET_EVENTS` already expose everything the manager
needs.

### 13.1 Addressability, tagging, and the picker

The manager's picker renders "all available tools" — every tool is an
addressable unit. The picker enumerates registry toolsets and
computes the addressable-unit list:

- a toolset → one unit (the group); members appear as individual
  units in the picker; the group may appear as a convenience
  "select all" card, but that is a manager UI choice, not a library
  concern;
- a standalone tool (no toolset) → an individual unit.

Tags are user-assigned labels on **addressable units** (tools or groups),
stored in the manager's own user config. The library never knows what a
tag is. `on`/`off`/`focus` on a tag resolves the tag → its addressable
units → activates/deactivates each (focus additionally flips the
library's default-resolution mode to inclusion so the focus set survives
new-tool drift — see §13.2). Because every tool is addressable, tags
can target any individual tool or group, and the operation hits the
target as a whole.

`emitMemberEvents` (§6) is the one library-side affordance the picker may
opt into: a group toggle can additionally fan out to one `changed` event
per member (with `event.member` set) so a per-tool UI updates without the
manager re-deriving which members moved. The group-level event always
fires regardless. Default `false`; the manager sets it on toolsets it
renders per-tool.

### 13.2 "Only" / focus mode: library mechanism, manager intent

The user-facing "focus on this tag" / "only these tools" operation —
reduce the active tool set to just the named tools, and keep it that way
as new tools are installed — splits cleanly into **library mechanism**
and **manager intent**.

The **drift problem** a naive focus snapshot has: focus is a batch of
`disable()` calls producing "active = {A, B}" at a moment in time. It
records *what's off* (C, D), not a forward-going intent. When a new
extension registers toolsets E, F, G and the user `/reload`s, E/F/G have
no branch entry — under the default exclusion mode (§4.5) they fall back
to `spec.defaultEnabled` (on) and silently break focus. A manager-only
fix (re-apply the allowlist on every `session_start`) works but is racy
and re-implements default resolution at the wrong layer.

The **library mechanism** is inclusion mode (§4.5): the manager calls
`setDefaultResolutionMode(pi, "inclusion")`, and unknown toolsets
(those with no branch entry) default **off** instead of on. Same `{
enabled }` persist records, one mode bit on the restore path the library
already owns. New toolsets E/F/G default off → focus survives the
installation. No event-watching, no manager re-apply loop. The mechanism
is built into the library from v1 so the persist schema and API are
stable before any consumer ships against them; portal/host never set it
and run in exclusion mode for their entire lifecycle.

The **manager intent** is *which* toolsets are in the focus set (the
positive allowlist / tag). The manager owns that choice in its own user
config; the library holds the line against drift once the mode is set.
A focus operation is therefore:

```ts
// manager: "focus on tag X"
setDefaultResolutionMode(pi, "inclusion");      // library: unknowns stay off
const keep = new Set(tagX.toolsetIds);
for (const ts of registry.allToolsets()) {
  if (keep.has(ts.spec.id)) ts.enable(pi);      // allowlist on (requires pulls deps)
  else ts.disable(pi);                          // everything else off
}
```

There is **no `focus()` verb on `Toolset`** — focus is a composition
over `enable`/`disable` plus a mode flip, not a third activation verb.
Adding one would bake a one-consumer recipe into the core. The library's
contribution is the mode (one bit, default resolution); the manager's
is the intent (the allowlist). The split keeps the library free of tag
vocabulary while giving focus a durable foundation.

> **`pi-tbox` implementation note.** `pi-tbox`'s `/tbox focus` is
> **single-unit** (one group name or one toolset id, never a builtin):
> the resolved unit's forward `requires` closure *and* reverse
> `dependents` closure becomes the allowlist, matching the library's
> bi-directional `enable` cascade. Enter flips inclusion mode on and
> disables every non-allowlist toolset (the mechanism above). Exit is
> **re-actuation**, not a mode flip: every toolset is driven back to its
> `spec.defaultEnabled`, overwriting the focus-era persist entries — so
> drift on exit is impossible without a durable mode bit lingering. The
> design rationale above holds; this is the refinement that shipped.

**Pi's built-in tools (`read`, `bash`, …) are preserved emergently.**
Disabling a toolset only removes *its own members* from the active set;
builtins are not members of any `defineToolset` toolset, so disabling
every non-allowlist toolset leaves builtins active. No "protected
builtin group" registration is load-bearing for focus. `pi-tbox` does
auto-register a `pi.builtin` toolset (plus per-source orphan toolsets)
at load so builtins are a toggleable unit in its list/toggle surface,
but it **excludes `pi.builtin` from focus** (focus on builtins is
rejected) — so the focus path still relies on the emergent preservation
above, not on the builtin group being in the allowlist.

Also still deferred (orthogonal to the manager):

- **Direct `setActiveTools` bypass.** A rogue extension can call
  `pi.setActiveTools([...])` directly with any tool name, bypassing
  the library's `enable`/`disable` surface. No need to encode
  deeper until a real threat model requires it.

## 14. Publishing & gallery visibility

`pi-tool-masking` is a library, not a user-facing pi extension. Two
decisions, both independent:

- **Runtime**: pi treats it as an npm `dependency` of portal/host (per
  `packages.md`: "Dependencies that do not register extensions, skills,
  prompt templates, or themes also belong in `dependencies`"). It is
  not auto-discovered as an extension — no default factory, nothing in
  `extensions/`, nothing in a `pi` manifest.
- **Gallery**: the [package gallery](https://pi.dev/packages) lists
  packages tagged `pi-package` in `package.json` `keywords`. The
  published `pi-tool-masking@1.0.0` is **not** tagged `pi-package`
  (verified). Tag the consumer packages (portal, host, and `pi-tbox`)
  instead. A gallery listing that, installed
  alone, surfaces no tools/commands/skills confuses end-users who expect
  every listing to do something on its own. The library remains fully
  public on npm and installable as a dep; it just isn't gallery-marketed.
  This mirrors how `@earendil-works/pi-ai` is handled — a pi-ecosystem
  dependency listed in `peerDependencies`/`dependencies`, not a gallery
  entry.

## 15. Open implementation questions

None open. The library shipped at `1.0.0` after verification against
`pi-lean-dimension` and `pi-tbox`. Decisions recorded here so they don't
re-surface:

1. **No library command generator.** The library does not register or
   generate any user-facing command. Consumers own `/web`, `/api`, etc.
   via `pi.registerCommand()` and call `toolset.enable(pi)` /
   `toolset.disable(pi)` inside (§10). An auto-generated command surface
   with an override hook was rejected: its first real consumer (portal's
   `/web`) overrides roughly half the generated subcommands (`profile`,
   `cookies`, a richer `status`), so the "default" is dead weight and the
   override hook costs more than the ~10 lines of trivial dispatch it
   would save. The peer-composition invariant (§9) and the `requires`
   cascade (§4.4) live in `enable`/`disable`, so a hand-written handler
   gets the full invariant for free.
2. **Typed event payloads.** Events ship a typed `ToolsetChangedEvent`
   (§6), not `Record<string, unknown>` — the type is free and prevents
   bag-of-anything drift.
