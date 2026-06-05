# Fetch Decoupling Plan — Phase 1 Implementation

> **Date**: 2026-06-05
> **Scope**: Decouple the HTTP fetch backend from the browser-navigate session/router system into a standalone `web-fetch` tool
> **Depends on**: plan.md Section 11 (Fetch Decoupling — Architectural Decision)
> **Status**: Planning — not yet implemented

---

## 1. Goal

Separate the HTTP fetch codepath from the interactive browser router so that:

1. `web-fetch` is its own tool — stateless, no sessions, no router dispatch
2. `browser-navigate` only handles interactive backends (chromium/stealth) — no `"fetch"` strategy
3. The router is simplified — no fetch branching in `navigate()`, no `BackendUsed = "fetch"`
4. Unit tests exist for the newly separated fetch functionality
5. Existing behavior is preserved (agent can still get the same content; it just calls a different tool)

---

## 2. Files Changed

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | **Modify** | Add `webFetchTool` definition; remove `"fetch"` from `browser-navigate` strategy enum; update prompt guidelines; update `/browser-status` to show fetch as separate; update startup notification |
| `backend/router.ts` | **Modify** | Remove fetch import and the Level 1 dispatch block from `navigate()`; remove `"fetch"` from `BackendUsed` type union; remove `capFetchContent`, `writeFetchTempFile`, `trackFetchFile`, `formatBytes`, `activeFetchFiles`, fetch truncation constants; `navigate()` starts at chromium for `"auto"` |
| `backend/fetch-backend.ts` | **Modify** | Add `FetchOptions` type with URL safety validation; add bot-detection import for inline bot detection; add content-capping/temp-file logic (moved from router); export `webFetch()` as the new entry point |
| `utils/url-safety.ts` | **No change** | Already shared by both fetch and router |
| `utils/bot-detection.ts` | **No change** | Newly imported by fetch-backend for inline bot detection |
| `utils/session-manager.ts` | **No change** | `BackendLevel` stays `"chromium" \| "stealth"` — fetch never created sessions |
| `package.json` | **No change** | Same dependencies; no new packages needed |
| `tsconfig.json` | **No change** | Same config |
| `__tests__/fetch-backend.test.ts` | **Create** | Unit tests for the decoupled fetch backend |
| `__tests__/url-safety.test.ts` | **Create** | Unit tests for URL safety (shared utility, good to have) |

---

## 3. Detailed Changes

### 3.1 `backend/fetch-backend.ts` — Absorb Router Fetch Logic

The fetch backend currently returns raw Markdown. The router then:
1. Runs URL safety validation
2. Caps content for inline display
3. Writes temp files for large content
4. Tracks temp files for cleanup

All of this moves into `fetch-backend.ts` so the tool can call it directly.

**New exports:**

```typescript
// Existing (unchanged signature)
export async function navigate(url: string, timeoutMs?: number, signal?: AbortSignal): Promise<FetchNavigateResult>;

// New — the entry point for the web-fetch tool
export interface WebFetchOptions {
  url: string;
  timeout?: number;  // seconds, default 30, max 120
  signal?: AbortSignal;
}

export interface WebFetchResult {
  success: boolean;
  url: string;
  title: string;
  content: string;           // Truncated inline Markdown
  backendUsed: "fetch";       // Always "fetch"
  needsJavaScript?: boolean; // True if page appears to need JS
  botDetected?: boolean;      // True if bot-detection signals found in content
  statusCode?: number;
  error?: string;
  /** Path to temp file with full content (only when content > spill threshold) */
  filePath?: string;
  /** Total character count before truncation */
  totalChars?: number;
}

export async function webFetch(options: WebFetchOptions): Promise<WebFetchResult>;

/** Remove temp files for a specific task, or all fetch temp files */
export function cleanupFetchTempFiles(taskId?: string): void;
```

**Internal changes:**

1. Move the following from `router.ts` into `fetch-backend.ts`:
   - `FETCH_TEMP_DIR`, `activeFetchFiles`, `COMPACT_FETCH_LIMIT`, `FETCH_SPILL_THRESHOLD`
   - `writeFetchTempFile()`, `trackFetchFile()`, `capFetchContent()`, `formatBytes()`, `cleanupFetchTempFiles()`
2. `webFetch()` calls `validateUrl()` from `../utils/url-safety` — rejects unsafe URLs before fetching
3. `webFetch()` calls `checkBodyText()` from `../utils/bot-detection` on the fetched content — sets `botDetected` in the result
4. `webFetch()` calls `capFetchContent()` on the Markdown output — returns truncated inline + temp file reference
5. The old `navigate()` export is preserved (unchanged) for backward compatibility during transition but marked `@deprecated`

**Why bot detection in fetch?** The router currently checks `result.needsJavaScript` and escalates to chromium. With fetch decoupled, the tool result tells the agent that `needsJavaScript: true` or `botDetected: true`, and the agent decides to follow up with `browser-navigate`. No automatic escalation — the agent is the escalation decision-maker.

### 3.2 `backend/router.ts` — Remove Fetch Path

**Removals:**

1. Remove `import * as fetchBackend from "./fetch-backend"`
2. Remove `import { mkdirSync, writeFileSync, rmSync } from "node:fs"` and `import { createHash } from "node:crypto"` (only used by fetch temp files)
3. Remove from `navigate()`:
   - The entire `// --- Level 1: HTTP Fetch ---` block (lines ~215–280)
   - The `strategy === "fetch"` check at the top of `navigate()`
4. Remove `BackendUsed` type — replace with `BackendLevel` everywhere (chromium | stealth only)
5. Remove fetch truncation constants: `COMPACT_FETCH_LIMIT`, `FETCH_SPILL_THRESHOLD`, `FETCH_TEMP_DIR`, `COMPACT_SNAPSHOT_NO_TRUNCATE`, `COMPACT_SNAPSHOT_LIMIT`, `COMPACT_SNAPSHOT_VERY_LARGE`, `COMPACT_SNAPSHOT_TOP_LIMIT`
   - **Note**: Snapshot truncation constants (`COMPACT_SNAPSHOT_*`) stay — they're used by `compactSnapshot()` which is still needed for interactive backends
   - Only `COMPACT_FETCH_LIMIT`, `FETCH_SPILL_THRESHOLD`, `FETCH_TEMP_DIR`, `activeFetchFiles`, and the temp file functions move to fetch-backend
6. Remove `NavigateResult` fields that are fetch-specific: `filePath`, `totalChars`, `statusCode`
7. Remove `cleanupFetchTempFiles` export (moved to fetch-backend)
8. Remove `capFetchContent`, `writeFetchTempFile`, `trackFetchFile`, `formatBytes` functions

**Simplifications:**

1. `"auto"` strategy now means chromium → stealth (no fetch step)
2. `NavigateResult.backendUsed` type narrows from `"fetch" | BackendLevel` to just `BackendLevel`
3. `NavigateOptions.strategy` type narrows from `"auto" | BackendLevel | "fetch"` to `"auto" | BackendLevel`

**The `navigate()` flow becomes:**

```
strategy === "auto" || strategy === "chromium":
  → createSession(taskId, "chromium")
  → playwrightBackend.navigate()
  → if botDetected && auto: escalateToStealthIfAuto()
  → return result

strategy === "stealth":
  → createSession(taskId, "stealth")
  → stealthBackend.navigate()
  → return result
```

No more fetch branch. The router only handles stateful interactive backends.

### 3.3 `index.ts` — Add `web-fetch` Tool

**New tool: `webFetchTool`**

```typescript
const webFetchTool = defineTool({
  name: "web-fetch",
  label: "Fetch Web Page",
  description:
    "Fetch a web page via HTTP and convert it to Markdown for reading. " +
    "Fast and lightweight — no JavaScript execution, no browser session. " +
    "Use when you only need to read page content. " +
    "If the page needs JavaScript or has bot detection, use browser-navigate instead.",
  promptSnippet: "Fetch and read web pages in text form",
  promptGuidelines: [
    "Use web-fetch when you only need to read a page's content — it's fast and lightweight.",
    "The tool converts HTML to Markdown for readability.",
    "If the result indicates the page needs JavaScript (needsJavaScript: true), use browser-navigate with strategy='chromium' to get an interactive session.",
    "If the result indicates bot detection (botDetected: true), use browser-navigate with strategy='stealth' to bypass bot protection.",
    "When the result mentions a temp file with full content, use the read tool with offset/limit to access specific sections — do not read the entire file at once.",
    "Fetch results are truncated to ~4K chars inline. If you need more content, either read the temp file in sections or use browser-navigate for interactive access.",
  ],
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds (default: 30, max: 120)",
        minimum: 1, maximum: 120,
      }),
    ),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { url, timeout = 30 } = params as { url: string; timeout?: number };
    const tid = taskId(ctx);

    signal?.addEventListener("abort", () => {
      fetchBackend.cleanupFetchTempFiles(tid);
    }, { once: true });

    const result = await fetchBackend.webFetch({ url, timeout, signal: signal ?? undefined });

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed to fetch page: ${result.error ?? "unknown error"}` }],
        details: { error: true, backendUsed: "fetch", url: result.url },
      };
    }

    const lines = [
      `Title: ${result.title || "(no title)"}`,
      `URL: ${result.url}`,
      `Backend: fetch`,
      result.needsJavaScript ? "⚠ This page appears to need JavaScript for full rendering." : "",
      result.botDetected ? "⚠ Bot detection triggered — may need stealth backend." : "",
      result.statusCode ? `HTTP ${result.statusCode}` : "",
      "",
      result.content,
    ];

    return {
      content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
      details: {
        title: result.title,
        url: result.url,
        backendUsed: "fetch",
        needsJavaScript: result.needsJavaScript,
        botDetected: result.botDetected,
        statusCode: result.statusCode,
        ...(result.filePath ? { filePath: result.filePath } : {}),
        ...(result.totalChars ? { totalChars: result.totalChars } : {}),
      },
    };
  },
  renderCall(args, theme, _context) {
    return new Text(`${theme.fg("toolTitle", theme.bold("web-fetch "))}${theme.fg("accent", `"${args.url}"`)}`, 0, 0);
  },
  renderResult(result, { expanded }, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", `Failed: ${(result.content?.[0] as any)?.text ?? "?"}`), 0, 0);
    const title = (d?.title as string) || "(no title)";
    const url = (d?.url as string) || "";
    const js = d?.needsJavaScript as boolean | undefined;
    const bot = d?.botDetected as boolean | undefined;
    let text = theme.fg("accent", theme.bold(`📡 ${title}`));
    text += `\n${theme.fg("dim", url)}`;
    if (js) text += ` ${theme.fg("warning", "⚠ needs JS")}`;
    if (bot) text += ` ${theme.fg("warning", "⚠ bot detected")}`;
    const content = (result.content?.[0] as any)?.text ?? "";
    if (expanded) {
      const preview = content.replace(/\n{3,}/g, "\n\n").slice(0, 500);
      text += `\n\n${theme.fg("dim", preview)}`;
      if (content.length > 500) text += `\n${theme.fg("muted", `… ${content.length - 500} more chars`)}`;
    } else {
      text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
    }
    return new Text(text, 0, 0);
  },
});
```

**Changes to `browser-navigate`:**

1. Remove `"fetch"` from `strategy` enum: `StringEnum(["auto", "chromium", "stealth"] as const, ...)`
2. Update description: remove "simple HTTP fetch for static sites" — now says "Playwright Chromium for JS-heavy pages, or stealth Firefox for bot-protected sites"
3. Update `promptGuidelines`:
   - Remove "If the page seems empty or JS-dependent, try strategy='chromium'" (replaced by web-fetch guidance)
   - Add: "For fast content retrieval without interaction, use web-fetch instead"
   - Remove the temp-file and truncation guidelines (those now belong to web-fetch)
4. In `execute()`: remove `result.filePath` and `result.totalChars` from details (no longer in `NavigateResult`)
5. Remove the 8000-char safety net cap for fetch content (fetch no longer comes through this path)
6. Update `renderResult()`: remove `backendUsed === "fetch"` display path

**Changes to extension entry point:**

1. Register `webFetchTool` via `pi.registerTool(webFetchTool)`
2. Import `cleanupFetchTempFiles` from `./backend/fetch-backend` instead of `./backend/router`
3. Update `/browser-status` command: show fetch availability separately from backend levels
4. Update startup notification: `"Browser extension loaded. Use web-fetch for reading pages, browser-navigate for interactive browsing."`
5. Update `session_shutdown` handler: call `cleanupFetchTempFiles()` from fetch-backend instead of router

### 3.4 `NavigateResult` Type Changes

Before:

```typescript
export interface NavigateResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  backendUsed: BackendUsed;  // "fetch" | "chromium" | "stealth"
  elementCount?: number;
  botDetectionWarning?: boolean;
  error?: string;
  statusCode?: number;
  filePath?: string;
  totalChars?: number;
}
```

After:

```typescript
export interface NavigateResult {
  success: boolean;
  url: string;
  title: string;
  content: string;           // Always a11y tree snapshot (compact)
  backendUsed: BackendLevel;  // "chromium" | "stealth" only
  elementCount?: number;
  botDetectionWarning?: boolean;
  error?: string;
}
```

The fetch-specific fields (`statusCode`, `filePath`, `totalChars`) are removed. They now live on `WebFetchResult`.

---

## 4. Test Plan

### 4.1 Test Infrastructure Setup

**Test runner**: Node.js built-in `node:test` (no external dependency needed, available since Node 18+).

**Test file**: `__tests__/fetch-backend.test.ts`

**Why no external test framework?**
- The project currently has zero tests and `package.json` has no test dependencies
- `node:test` is zero-config and built-in
- Keeping the test infrastructure minimal reduces friction for the first test suite
- If a more full-featured framework is wanted later, migrating from `node:test` is straightforward

**Test helpers needed:**

```typescript
// __tests__/helpers/test-server.ts
// A minimal HTTP server for serving test fixtures
import { createServer, type Server } from "node:http";

export interface TestServer {
  server: Server;
  url: string;  // Base URL like http://127.0.0.1:{port}
  stop(): Promise<void>;
}

export async function startTestServer(handler: (req, res) => void): Promise<TestServer>;
```

This avoids hitting real websites in tests and makes assertions deterministic.

### 4.2 Test Cases

#### Category A: `webFetch()` — Core Fetch Functionality

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| A1 | Fetches a simple HTML page and returns Markdown | `webFetch()` makes HTTP request, parses HTML, converts to Markdown via Turndown |
| A2 | Returns correct title from `<title>` tag | Title extraction from parsed HTML |
| A3 | Follows HTTP redirects | `redirect: "follow"` behavior; final URL in result |
| A4 | Handles HTTP error codes (404, 500) | Returns `success: false` with `statusCode` and error message |
| A5 | Handles network timeouts | Returns `success: false` with `error` containing "timeout" |
| A6 | Handles DNS failures | Returns `success: false` with error message |
| A7 | Handles empty response body | Returns `success: false` with `error: "Empty body"` |
| A8 | Strips `<script>`, `<style>`, `<noscript>` tags | Markdown output doesn't contain script/style content |
| A9 | Converts SVGs to descriptive placeholders | `[SVG: label]` or `[SVG graphic]` in Markdown |
| A10 | Compresses data URI images | `[Image: data URI - alt]` in Markdown instead of base64 blob |
| A11 | Compresses large code blocks | Large `<pre>` becomes `[code code (N lines, ~M chars)]` |

#### Category B: `webFetch()` — JS Detection

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| B1 | Detects empty `#root` div as needing JS | SPA shell detection |
| B2 | Detects `#__next` div with <100 chars | Next.js shell detection |
| B3 | Does not flag content-rich pages | `needsJavaScript: false` for normal HTML |
| B4 | Detects `<noscript>` heavy pages | Most content in `<noscript>` tags |

#### Category C: `webFetch()` — Bot Detection (Inline)

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| C1 | Detects "cloudflare" in body text | `botDetected: true` |
| C2 | Detects "please verify you are human" | `botDetected: true` |
| C3 | Does not flag normal page content | `botDetected: false` for clean pages |
| C4 | Detects "captcha" keyword | `botDetected: true` |

#### Category D: `webFetch()` — URL Safety Validation

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| D1 | Blocks localhost URLs | `success: false`, error mentions "private/internal" |
| D2 | Blocks 127.0.0.1 | SSRF prevention |
| D3 | Blocks 169.254.169.254 | Cloud metadata endpoint protection |
| D4 | Blocks file:// scheme | Only http/https allowed |
| D5 | Allows valid HTTPS URLs | `success: true` (or network error, but not URL-blocked) |
| D6 | Detects secrets in URL query params | `?api_key=xxx` blocked |
| D7 | Detects GitHub tokens in URL | `ghp_...` pattern blocked |

#### Category E: `webFetch()` — Content Capping & Temp Files

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| E1 | Small content returned inline, no temp file | Content ≤ 5000 chars: `filePath` is undefined |
| E2 | Large content truncated inline with temp file | Content > 5000 chars: `filePath` set, inline truncated at ~4000 chars |
| E3 | Inline truncation respects newline boundaries | Cut point is at a `\n` near the limit |
| E4 | Temp file contains full content | Read temp file and verify it matches original Markdown |
| E5 | Temp file path format is correct | `fetch-{safeTaskId}-{hash}.md` in `/tmp/pi-browser/` |
| E6 | `cleanupFetchTempFiles()` removes tracked files | After cleanup, temp file is deleted |
| E7 | New fetch replaces previous temp file | Second call with same taskId cleans up first file |
| E8 | `totalChars` reflects original content length | Not the truncated length |

#### Category F: `webFetch()` — AbortSignal Handling

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| F1 | Aborting during fetch returns error | `success: false` with timeout/error message |
| F2 | Cleanup runs on abort | Temp files cleaned up when signal aborts |

#### Category G: Integration — `web-fetch` Tool Definition

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| G1 | Tool has correct name and parameters | `name === "web-fetch"`, parameters have `url` (required) and `timeout` (optional) |
| G2 | Tool result includes `details.backendUsed === "fetch"` | Always "fetch" for this tool |
| G3 | Tool result includes `details.needsJavaScript` when true | Agent can decide to follow up with browser-navigate |
| G4 | Tool result includes `details.botDetected` when true | Agent can decide to use stealth |

### 4.3 URL Safety Unit Tests (Separate File)

**Test file**: `__tests__/url-safety.test.ts`

| # | Test Name | What It Validates |
|---|-----------|-------------------|
| U1 | Valid HTTPS URL passes | `{ safe: true }` |
| U2 | localhost blocked | `{ safe: false, category: "ssrf" }` |
| U3 | 10.x private IP blocked | `{ safe: false, category: "ssrf" }` |
| U4 | 192.168.x private IP blocked | `{ safe: false, category: "ssrf" }` |
| U5 | 172.16-31.x blocked | `{ safe: false, category: "ssrf" }` |
| U6 | file:// scheme blocked | `{ safe: false, category: "scheme" }` |
| U7 | ftp:// scheme blocked | `{ safe: false, category: "scheme" }` |
| U8 | data: scheme blocked | `{ safe: false, category: "scheme" }` |
| U9 | API key in query param blocked | `?api_key=xxx` → `{ safe: false, category: "secret" }` |
| U10 | GitHub token in URL blocked | `ghp_...` pattern |
| U11 | AWS access key blocked | `AKIA...` pattern |
| U12 | Malformed URL rejected | `{ safe: false, category: "malformed" }` |
| U13 | Percent-encoded secret blocked | Double-check after decode |
| U14 | IPv6 loopback blocked | `[::1]` |

---

## 5. Implementation Order

The changes are ordered to minimize breakage at each step. Each step should leave the codebase in a working state.

### Step 1: Create test infrastructure + URL safety tests
- Create `__tests__/helpers/test-server.ts`
- Create `__tests__/url-safety.test.ts`
- Run tests: `npx tsx --test __tests__/url-safety.test.ts`
- This proves the test harness works with no production code changes

### Step 2: Add `webFetch()` and temp-file logic to `fetch-backend.ts`
- Move content-capping functions from `router.ts` into `fetch-backend.ts`
- Add `webFetch()` function that combines: URL safety → fetch → JS detection → bot detection → content capping
- Add `cleanupFetchTempFiles()` export
- Keep old `navigate()` export for backward compatibility (router still calls it)
- All new code is additive — no existing behavior changes

### Step 3: Write fetch-backend unit tests
- Create `__tests__/fetch-backend.test.ts`
- Implement tests from categories A–F above
- Use `test-server.ts` helper for deterministic HTML responses
- Verify all tests pass

### Step 4: Add `webFetchTool` to `index.ts`
- Define the new tool
- Register it in the extension entry point
- **Do not** remove `"fetch"` from `browser-navigate` yet — both paths exist

### Step 5: Remove fetch from router
- Remove the fetch dispatch block from `router.ts navigate()`
- Remove `"fetch"` from `NavigateOptions.strategy` type
- Remove `BackendUsed` type, use `BackendLevel` directly
- Remove fetch-specific fields from `NavigateResult`
- Remove fetch temp file code (already moved to fetch-backend)
- Remove import of fetch-backend from router
- Update `cleanupFetchTempFiles` import in `index.ts` to come from fetch-backend

### Step 6: Update `browser-navigate` tool
- Remove `"fetch"` from strategy enum
- Update description and prompt guidelines
- Remove fetch-specific rendering code
- Update startup notification

### Step 7: Final verification
- Run all tests: `npx tsx --test __tests__/**/*.test.ts`
- Manual smoke test: launch pi, call `web-fetch` on a known URL, call `browser-navigate` on a known URL
- Verify `browser-navigate` with `strategy="auto"` no longer tries fetch
- Verify `/browser-status` shows fetch separately
- Verify temp file cleanup on session shutdown

---

## 6. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Latency regression for `"auto"` strategy** | Medium | Medium | Agents must call `web-fetch` for content-retrieval tasks. Update prompt guidelines prominently. The `"auto"` path now starts chromium directly — slightly slower for simple pages, but the agent should be using `web-fetch` for those. |
| **Agent confusion about which tool to use** | Medium | Low | Clear prompt guidelines: "Use web-fetch for reading, browser-navigate for interacting." Both tools' descriptions cross-reference each other. |
| **Breaking change for `strategy="fetch"`** | High | Low | No existing callers should be using `strategy="fetch"` explicitly (agents always use `"auto"` or the default). The strategy enum removal is a compile-time error, not a runtime one. |
| **Temp file cleanup regression** | Low | Low | Cleanup is tested (E6, E7). The `session_shutdown` handler still calls cleanup, just from a different module. |
| **Bot detection not triggered during fetch** | Low | Medium | Bot detection is now inline in `webFetch()` (checked on fetched content). The agent sees `botDetected: true` and can escalate. Previously the router auto-escalated; now the agent decides. This is intentional per plan.md Section 11.4 point 5. |

---

## 7. What This Does NOT Cover (Future Work)

This plan is scoped to Phase 1 fetch decoupling only. The following are explicitly out of scope:

1. **`BrowserPlugin` interface extraction** — That's the rest of Phase 1 from plan.md. This plan only decouples fetch.
2. **Plugin registry / typed dispatch** — Router still uses if/else for chromium/stealth.
3. **Directory restructuring** — Files stay in `backend/` and `utils/`. No `core/` directory yet.
4. **Shared code consolidation** — `utils/` files are not moved to `core/shared/`.
5. **Quirks interface** — Not needed until a 3rd backend arrives.
6. **Deprecation shims in `utils/`** — No re-exports needed since we're not moving files.

However, this plan is designed to be **compatible** with all of the above. The fetch decoupling removes the biggest contradiction in the architecture (fetch being a "Level 1 backend" but not implementing BrowserPlugin), making the subsequent plugin interface extraction cleaner.

---

## 8. Test File Templates

### 8.1 `__tests__/helpers/test-server.ts`

```typescript
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface TestServer {
  server: Server;
  url: string;
  stop(): Promise<void>;
}

export async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        resolve({
          server,
          url: `http://127.0.0.1:${addr.port}`,
          stop: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        });
      } else {
        reject(new Error("Could not determine server address"));
      }
    });
    server.on("error", reject);
  });
}
```

### 8.2 `__tests__/fetch-backend.test.ts` — Skeleton

```typescript
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webFetch, cleanupFetchTempFiles, type WebFetchResult } from "../backend/fetch-backend";
import { startTestServer, type TestServer } from "./helpers/test-server";

describe("webFetch", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer((req, res) => {
      // Route-based test fixtures
      const url = new URL(req.url!, `http://${req.headers.host}`);
      switch (url.pathname) {
        case "/simple":
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>");
          break;
        case "/spa-shell":
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end('<html><head><title>SPA</title></head><body><div id="root"></div></body></html>');
          break;
        case "/bot-page":
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><head><title>Attention Required!</title></head><body><p>Please verify you are human</p></body></html>");
          break;
        case "/large":
          res.writeHead(200, { "Content-Type": "text/html" });
          const body = "<p>" + "x".repeat(10000) + "</p>";
          res.end(`<html><head><title>Big</title></head><body>${body}</body></html>`);
          break;
        case "/404":
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end("<html><body>Not Found</body></html>");
          break;
        case "/redirect":
          res.writeHead(302, { Location: `${server.url}/simple` });
          res.end();
          break;
        default:
          res.writeHead(404);
          res.end("Not found");
      }
    });
  });

  after(async () => {
    await server.stop();
  });

  afterEach(() => {
    cleanupFetchTempFiles();
  });

  // --- Category A: Core Fetch ---

  it("A1: fetches a simple HTML page and returns Markdown", async () => {
    const result = await webFetch({ url: `${server.url}/simple` });
    assert.equal(result.success, true);
    assert.equal(result.backendUsed, "fetch");
    assert.match(result.content, /Hello/);
    assert.match(result.content, /World/);
  });

  it("A2: returns correct title", async () => {
    const result = await webFetch({ url: `${server.url}/simple` });
    assert.equal(result.title, "Test Page");
  });

  it("A3: follows HTTP redirects", async () => {
    // Note: redirect test needs the server URL before server starts,
    // so we'll use a relative redirect target
    const result = await webFetch({ url: `${server.url}/redirect` });
    assert.equal(result.success, true);
    assert.equal(result.title, "Test Page");
  });

  it("A4: handles HTTP error codes", async () => {
    const result = await webFetch({ url: `${server.url}/404` });
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  });

  // --- Category B: JS Detection ---

  it("B1: detects empty #root div as needing JS", async () => {
    const result = await webFetch({ url: `${server.url}/spa-shell` });
    assert.equal(result.needsJavaScript, true);
  });

  // --- Category C: Bot Detection ---

  it("C1: detects bot block text", async () => {
    const result = await webFetch({ url: `${server.url}/bot-page` });
    assert.equal(result.botDetected, true);
  });

  // --- Category D: URL Safety ---

  it("D1: blocks localhost", async () => {
    const result = await webFetch({ url: "http://localhost/test" });
    assert.equal(result.success, false);
    assert.match(result.error!, /private|internal/i);
  });

  // --- Category E: Content Capping ---

  it("E1: small content returned inline, no temp file", async () => {
    const result = await webFetch({ url: `${server.url}/simple` });
    assert.equal(result.filePath, undefined);
    assert.equal(result.totalChars, undefined);
  });

  it("E2: large content truncated with temp file", async () => {
    const result = await webFetch({ url: `${server.url}/large` });
    assert.equal(result.success, true);
    assert.notEqual(result.filePath, undefined);
    assert.ok(result.totalChars! > 5000);
    assert.ok(result.content.length < result.totalChars!);
  });
});
```

### 8.3 `__tests__/url-safety.test.ts` — Skeleton

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateUrl } from "../utils/url-safety";

describe("URL Safety", () => {
  it("U1: allows valid HTTPS URL", () => {
    const result = validateUrl("https://example.com/page");
    assert.equal(result.safe, true);
  });

  it("U2: blocks localhost", () => {
    const result = validateUrl("http://localhost/admin");
    assert.equal(result.safe, false);
    assert.equal(result.category, "ssrf");
  });

  it("U3: blocks 10.x private IP", () => {
    const result = validateUrl("http://10.0.0.1/internal");
    assert.equal(result.safe, false);
    assert.equal(result.category, "ssrf");
  });

  it("U4: blocks file:// scheme", () => {
    const result = validateUrl("file:///etc/passwd");
    assert.equal(result.safe, false);
    assert.equal(result.category, "scheme");
  });

  it("U5: blocks API key in query params", () => {
    const result = validateUrl("https://example.com/api?api_key=secret123");
    assert.equal(result.safe, false);
    assert.equal(result.category, "secret");
  });

  it("U6: rejects malformed URL", () => {
    const result = validateUrl("not a url");
    assert.equal(result.safe, false);
    assert.equal(result.category, "malformed");
  });

  it("U7: blocks 169.254.169.254 (cloud metadata)", () => {
    const result = validateUrl("http://169.254.169.254/latest/meta-data/");
    assert.equal(result.safe, false);
    assert.equal(result.category, "ssrf");
  });

  it("U8: blocks GitHub token pattern in URL", () => {
    // Using a clearly-fake token value that matches the ghp_ regex pattern
    const fakeToken = "ghp_" + "A".repeat(36);
    const result = validateUrl(`https://api.github.com?token=${fakeToken}`);
    assert.equal(result.safe, false);
    assert.equal(result.category, "secret");
  });

  it("U9: blocks 192.168.x private IP", () => {
    const result = validateUrl("http://192.168.1.1/router");
    assert.equal(result.safe, false);
    assert.equal(result.category, "ssrf");
  });

  it("U10: blocks data: scheme", () => {
    const result = validateUrl("data:text/html,<h1>test</h1>");
    assert.equal(result.safe, false);
    assert.equal(result.category, "scheme");
  });

  it("U11: blocks percent-encoded secret param", () => {
    // %61%70%69 decodes to "api" — so the full param name is api_key
    const result = validateUrl("https://example.com/api?%61%70%69_key=testvalue");
    assert.equal(result.safe, false);
    assert.equal(result.category, "secret");
  });

  it("U12: blocks IPv6 loopback", () => {
    const result = validateUrl("http://[::1]/admin");
    assert.equal(result.safe, false);
    assert.equal(result.category, "ssrf");
  });

  it("U13: blocks 172.16-31.x range", () => {
    assert.equal(validateUrl("http://172.16.0.1/").safe, false);
    assert.equal(validateUrl("http://172.31.255.255/").safe, false);
    assert.equal(validateUrl("http://172.15.0.1/").safe, true);
    assert.equal(validateUrl("http://172.32.0.1/").safe, true);
  });

  it("U14: allows valid HTTP URL", () => {
    const result = validateUrl("http://example.com/page");
    assert.equal(result.safe, true);
  });
});
```

---

## 9. Summary of Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Fetch is a tool, not a backend** | Fetch cannot implement `BrowserPlugin` (11 of 13 operations would be no-ops). It produces Markdown, not a11y trees. It has no sessions. |
| **Agent decides escalation, not router** | The agent has context about whether it needs to interact. Auto-escalation hid this decision and produced inconsistent output types (Markdown vs. a11y tree) in the same tool. |
| **Bot detection inline in `webFetch()`** | The agent needs to see `botDetected: true` in the result to make an informed decision about following up with `browser-navigate strategy="stealth"`. Previously the router auto-escalated. |
| **Temp file logic moves to fetch-backend** | The router shouldn't manage fetch-specific temp files. Each tool's backend owns its resource lifecycle. |
| **`node:test` for test framework** | Zero-config, built-in, no new dependency. Minimizes friction for the first test suite. |
| **Test server for deterministic HTML** | Tests should not depend on external websites. A local HTTP server provides deterministic fixtures for JS detection, bot detection, content capping, etc. |
| **Phase-scoped: no directory restructuring** | This plan only decouples fetch. The `BrowserPlugin` interface, plugin registry, and directory restructuring are separate Phase 1 tasks from plan.md. |
