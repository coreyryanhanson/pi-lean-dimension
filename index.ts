import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { accessSync, constants } from "node:fs";
import * as router from "./backend/router";
import { cleanupFetchTempFiles } from "./backend/router";
import { cleanupAll as cleanupPlaywright } from "./backend/playwright-backend";
import { cleanupAll as cleanupStealth } from "./backend/stealth-backend";
import { sessionManager } from "./utils/session-manager";

// ============================================================
// Status bar update helper
// ============================================================
function updateFooterStatus(ctx: { ui: { setStatus: (key: string, label: string) => void } }): void {
  ctx.ui.setStatus("browser", sessionManager.getStatus());
}

// ─── Helper to get a stable taskId from tool call context ──────
// Each pi session gets one browser session (not one per tool call).
// ctx.sessionManager.getSessionId() provides a stable per-session key.
// Fallback to a single shared key if unavailable.
const _sessionKeys = new Map<string, string>(); // pi sessionId → browser taskId
let _sessionCounter = 0;

function taskId(ctx: { toolCallId?: string; sessionManager?: { getSessionId?: () => string } }): string {
  const piSessionId = ctx?.sessionManager?.getSessionId?.();
  if (piSessionId) {
    if (!_sessionKeys.has(piSessionId)) {
      _sessionKeys.set(piSessionId, `browser-${++_sessionCounter}`);
    }
    return _sessionKeys.get(piSessionId)!;
  }
  // Fallback: single shared session (better than per-toolCallId)
  return "browser-default";
}

// ============================================================
// Tool: browser-navigate
// ============================================================
const browserNavigateTool = defineTool({
  name: "browser-navigate",
  label: "Browse Web",
  description:
    "Navigate a browser to a URL and return the page as an accessibility tree with @e1, @e2 element references. " +
    "Auto-selects the best backend: simple HTTP fetch for static sites, " +
    "Playwright Chromium for JS-heavy pages, or stealth Firefox for bot-protected sites.",
  promptSnippet:
    "Fetch and read web pages in text form",
  promptGuidelines: [
    "Use browser-navigate when you need to read a web page's content.",
    "The tool converts HTML to Markdown for readability.",
    "If the page seems empty or JS-dependent, try strategy='chromium' when the Playwright backend is available.",
    "Use @e1, @e2 references from the accessibility tree with browser-click and browser-type to interact with page elements.",
    "If snapshot or interaction returns 'No active session', the page was fetched via HTTP. Calling browser-snapshot now will auto-launch an interactive browser and navigate to the last URL.",
    "After auto-launch, @e refs may have changed — a fresh accessibility tree is returned automatically. Use the new refs for interaction.",
    "When the fetch result mentions a temp file with full content, use the read tool with offset/limit to access specific sections — do not read the entire file at once.",
    "Fetch results are truncated to ~4K chars inline. If you need more content, either read the temp file in sections or re-navigate with strategy='chromium' for interactive access.",
  ],
  parameters: Type.Object({
    url: Type.String({ description: "The URL to navigate to" }),
    strategy: Type.Optional(
      StringEnum(["auto", "fetch", "chromium", "stealth"] as const, {
        description:
          'Backend strategy: "auto" (default) tries fetch first, escalates as needed; ' +
          '"fetch" uses plain HTTP; "chromium" uses Playwright Chromium; "stealth" uses invisible Playwright Firefox (anti-detection)',
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds (default: 30, max: 120)",
        minimum: 1, maximum: 120,
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { url, strategy = "auto", timeout = 30 } = params as {
      url: string; strategy?: string; timeout?: number;
    };
    const tid = taskId(ctx);

    signal?.addEventListener("abort", () => {
      sessionManager.removeSession(tid);
      updateFooterStatus(ctx);
    }, { once: true });

    const result = await router.navigate(url, {
      strategy: strategy as any,
      timeout,
      signal: signal ?? undefined,
      taskId: tid,
    });

    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed to load page: ${result.error ?? "unknown error"}` }],
        details: { error: true, backendUsed: result.backendUsed, url: result.url },
      };
    }

    // Safety net: if this is an interactive backend (a11y tree, not fetch markdown)
    // and the content somehow escaped truncation, enforce a cap here.
    // This prevents unbounded context flooding even if a code path in router.ts
    // forgets to call compactSnapshot().
    let contentText = result.content;
    if (
      result.elementCount !== undefined &&
      result.backendUsed !== "fetch" &&
      contentText.length > 8000
    ) {
      // Interactive a11y tree content should never exceed 8K chars after truncation.
      // If it does, something went wrong — cap it at the compact limit.
      let cut = contentText.lastIndexOf("\n", 4000);
      if (cut < 2000) cut = 4000;
      contentText = contentText.slice(0, cut) +
        `\n… ${contentText.length - cut} more chars (auto-truncated)`;
    }

    const lines = [
      `Title: ${result.title || "(no title)"}`,
      `URL: ${result.url}`,
      `Backend: ${result.backendUsed}`,
      result.elementCount !== undefined ? `Interactive elements: ${result.elementCount}` : "",
      result.botDetectionWarning ? `⚠ Bot detection triggered — may need stealth backend.` : "",
      // filePath and totalChars are embedded in the content by router.ts for
      // fetch results, but we include them in details for downstream use.
      "",
      contentText,
    ];

    return {
      content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
      details: {
        title: result.title,
        url: result.url,
        backendUsed: result.backendUsed,
        elementCount: result.elementCount,
        botDetectionWarning: result.botDetectionWarning,
        ...(result.filePath ? { filePath: result.filePath } : {}),
        ...(result.totalChars ? { totalChars: result.totalChars } : {}),
      },
    };
  },

  renderCall(args, theme, _context) {
    const parts: string[] = [theme.fg("toolTitle", theme.bold("browser-navigate "))];
    parts.push(theme.fg("accent", `"${args.url}"`));
    if (args.strategy && args.strategy !== "auto") parts.push(theme.fg("dim", `via ${args.strategy}`));
    return new Text(parts.join(" "), 0, 0);
  },

  renderResult(result, { expanded, isPartial }, theme, _context) {
    if (isPartial) return new Text(theme.fg("warning", "Navigating…"), 0, 0);
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", `Failed: ${(result.content?.[0] as any)?.text ?? "?"}`), 0, 0);

    const title = (d?.title as string) || "(no title)";
    const backend = (d?.backendUsed as string) || "?";
    const url = (d?.url as string) || "";
    const ec = d?.elementCount as number | undefined;
    const botWarn = d?.botDetectionWarning as boolean | undefined;

    let text = theme.fg("accent", theme.bold(`🌐 ${title}`));
    text += `\n${theme.fg("dim", url)}`;
    text += `\n${theme.fg("muted", `via ${backend}`)}`;
    if (ec !== undefined) text += ` · ${ec} elements`;
    if (botWarn) text += ` ${theme.fg("warning", "⚠ bot detection")}`;

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

// ============================================================
// Tool: browser-snapshot
// ============================================================
const browserSnapshotTool = defineTool({
  name: "browser-snapshot",
  label: "Page Snapshot",
  description:
    "Get the current page's accessibility tree with @e1, @e2 element references. " +
    "Use after browser-navigate to refresh the element list, or after page changes (click, scroll) to see the updated state.",
  parameters: Type.Object({
    full: Type.Optional(Type.Boolean({ description: "If true, return complete tree instead of compact view (default: false)" })),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const p = params as { full?: boolean; taskId?: string };
    const tid = p?.taskId ?? taskId(ctx);
    const full = p?.full ?? false;
    const result = await router.snapshot(tid, full);
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Snapshot failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    return {
      content: [{ type: "text", text: result.snapshot || "(empty page)" }],
      details: { elementCount: result.elementCount, full },
    };
  },

  renderCall(args, theme, _context) {
    const label = args.full ? "full" : "compact";
    return new Text(`${theme.fg("toolTitle", theme.bold("browser-snapshot"))} ${theme.fg("dim", label)}`, 0, 0);
  },

  renderResult(result, { expanded, isPartial }, theme, _context) {
    if (isPartial) return new Text(theme.fg("warning", "Taking snapshot…"), 0, 0);
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Snapshot failed"), 0, 0);
    const ec = (d?.elementCount as number) ?? 0;
    const content = (result.content?.[0] as any)?.text ?? "";
    const isFull = !!(d?.full as boolean);
    if (expanded) {
      const preview = content.slice(0, 400);
      let text = theme.fg("accent", `📋 ${ec} elements`);
      text += isFull ? "" : theme.fg("dim", " (compact)");
      text += `\n${theme.fg("dim", preview)}`;
      if (content.length > 400) text += `\n${theme.fg("muted", `… ${content.length - 400} more chars`)}`;
      return new Text(text, 0, 0);
    }
    const label = isFull ? " (full)" : " (compact)";
    return new Text(theme.fg("accent", `📋 ${ec} elements${label} (expand)`), 0, 0);
  },
});

// ============================================================
// Tool: browser-click
// ============================================================
const browserClickTool = defineTool({
  name: "browser-click",
  label: "Click Element",
  description:
    "Click an element on the page by its @e reference ID (e.g., @e5). " +
    "Use element references from browser-navigate or browser-snapshot output.",
  parameters: Type.Object({
    ref: Type.String({ description: "Element reference like @e5 (from the accessibility tree)" }),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { ref, taskId: tid } = params as { ref: string; taskId?: string };
    const result = await router.click(tid ?? taskId(ctx), ref);
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Click failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    const lines = [
      `Clicked ${ref}`,
      result.newUrl ? `URL: ${result.newUrl}` : "",
      result.newTitle ? `Title: ${result.newTitle}` : "",
    ].filter(Boolean);

    // Include auto-snapshot in the content so the model sees updated page state
    let content = lines.join("\n");
    if (result.snapshot) {
      content += `\n\n${result.snapshot}`;
    }
    if (result.elementCount !== undefined) {
      content += `\n\nInteractive elements: ${result.elementCount}`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { newUrl: result.newUrl, newTitle: result.newTitle, elementCount: result.elementCount },
    };
  },

  renderCall(args, theme, _context) {
    return new Text(`${theme.fg("toolTitle", theme.bold("browser-click"))} ${theme.fg("accent", args.ref)}`, 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", `Click failed: ${d.error}`), 0, 0);
    const newUrl = d?.newUrl as string | undefined;
    const ec = d?.elementCount as number | undefined;
    if (newUrl) {
      let text = theme.fg("success", `✅ → ${newUrl}`);
      if (ec !== undefined) text += ` · ${ec} elements`;
      return new Text(text, 0, 0);
    }
    return new Text(theme.fg("success", `✅ clicked${ec !== undefined ? ` · ${ec} elements` : ""}`), 0, 0);
  },
});

// ============================================================
// Tool: browser-type
// ============================================================
const browserTypeTool = defineTool({
  name: "browser-type",
  label: "Type Text",
  description:
    "Type text into an input element identified by its @e reference ID. " +
    "Clears existing content before typing. Use after browser-navigate or browser-snapshot.",
  parameters: Type.Object({
    ref: Type.String({ description: "Element reference like @e5 (must be a textbox, searchbox, or combobox)" }),
    text: Type.String({ description: "Text to type into the element" }),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { ref, text, taskId: tid } = params as { ref: string; text: string; taskId?: string };
    const result = await router.type(tid ?? taskId(ctx), ref, text);
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Type failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    // Include auto-snapshot so the model sees updated page state
    let content = `Typed "${text}" into ${ref}`;
    if (result.snapshot) {
      content += `\n\n${result.snapshot}`;
    }
    if (result.elementCount !== undefined) {
      content += `\n\nInteractive elements: ${result.elementCount}`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { typed: true, ref, text, elementCount: result.elementCount },
    };
  },

  renderCall(args, theme, _context) {
    return new Text(`${theme.fg("toolTitle", theme.bold("browser-type"))} ${theme.fg("accent", args.ref)} "${args.text}"`, 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", `Type failed: ${d.error}`), 0, 0);
    const ec = d?.elementCount as number | undefined;
    return new Text(theme.fg("success", `📝 typed "${d?.text || "?"}"${ec !== undefined ? ` · ${ec} elements` : ""}`), 0, 0);
  },
});

// ============================================================
// Tool: browser-scroll
// ============================================================
const browserScrollTool = defineTool({
  name: "browser-scroll",
  label: "Scroll Page",
  description: "Scroll the page up or down by approximately one viewport height.",
  parameters: Type.Object({
    direction: StringEnum(["up", "down"] as const, { description: "Scroll direction" }),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { direction, taskId: tid } = params as { direction: "up" | "down"; taskId?: string };
    const result = await router.scroll(tid ?? taskId(ctx), direction);
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Scroll failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    // Include auto-snapshot so the model sees updated page state
    let content = `Scrolled ${direction}`;
    if (result.snapshot) {
      content += `\n\n${result.snapshot}`;
    }
    if (result.elementCount !== undefined) {
      content += `\n\nInteractive elements: ${result.elementCount}`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { direction, elementCount: result.elementCount },
    };
  },

  renderCall(args, theme, _context) {
    return new Text(`${theme.fg("toolTitle", theme.bold("browser-scroll"))} ${theme.fg("dim", args.direction)}`, 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Scroll failed"), 0, 0);
    const ec = d?.elementCount as number | undefined;
    return new Text(theme.fg("dim", `↕ ${d?.direction || "?"}${ec !== undefined ? ` · ${ec} elements` : ""}`), 0, 0);
  },
});

// ============================================================
// Tool: browser-screenshot
// ============================================================
const browserScreenshotTool = defineTool({
  name: "browser-screenshot",
  label: "Take Screenshot",
  description:
    "Take a screenshot of the current page for visual analysis. " +
    "Returns a JPEG data URI (80% quality, max 1024px wide) that vision-capable models can examine.",
  parameters: Type.Object({
    question: Type.Optional(Type.String({ description: "Optional — if provided and the model has vision, it will answer questions about the screenshot" })),
    fullPage: Type.Optional(Type.Boolean({ description: "If true, capture full-page screenshot (default: viewport only)" })),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const p = params as { question?: string; fullPage?: boolean; taskId?: string };
    const tid = p?.taskId ?? taskId(ctx);
    const fullPage = p?.fullPage ?? false;
    const result = await router.screenshot(tid, fullPage);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Screenshot failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    // Build content: if a question was provided, include it in the text output
    // so both vision and text-only models can work with it.
    // The image is always attached for vision-capable models.
    const textContent = p?.question
      ? `Screenshot captured. Question: ${p.question}`
      : "Screenshot captured:";

    // Derive media type from data URI (backends return JPEG at 80% quality)
    const mediaType = result.dataUri.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
    const base64Data = result.dataUri.replace(/^data:image\/\w+;base64,/, "");

    return {
      content: [
        { type: "text", text: textContent },
        { type: "image", source: { type: "base64", mediaType, data: base64Data } },
      ],
      details: { screenshot: true, question: p?.question },
    };
  },

  renderCall(args, theme, _context) {
    if (args.question) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser-screenshot"))} ${theme.fg("dim", `“${args.question.slice(0, 60)}”`)}`, 0, 0);
    }
    return new Text(theme.fg("toolTitle", theme.bold("browser-screenshot")), 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.question) {
      return new Text(`${theme.fg("accent", "📸 Screenshot")} ${theme.fg("dim", `“${(d.question as string).slice(0, 60)}”`)}`, 0, 0);
    }
    return new Text(theme.fg("accent", "📸 Screenshot captured"), 0, 0);
  },
});

// ============================================================
// Tool: browser-get-images
// ============================================================
const browserGetImagesTool = defineTool({
  name: "browser-get-images",
  label: "Get Page Images",
  description:
    "Extract all <img> tags from the current page with src, alt, dimensions. " +
    "Useful for understanding visual content structure without taking a full screenshot. " +
    "Excludes data URIs.",
  parameters: Type.Object({
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { taskId: tid } = params as { taskId?: string };
    const result = await router.getImages(tid ?? taskId(ctx));

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed to get images: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    if (result.count === 0) {
      return {
        content: [{ type: "text", text: "No images found on this page." }],
        details: { count: 0 },
      };
    }

    const lines = [`Found ${result.count} image(s):`, ""];
    for (const img of result.images) {
      lines.push(`- ${img.alt ? `"${img.alt}" ` : ""}${img.src} (${img.width}x${img.height})`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: result.count, images: result.images },
    };
  },

  renderCall(_args, theme, _context) {
    return new Text(theme.fg("toolTitle", theme.bold("browser-get-images")), 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Failed to get images"), 0, 0);
    const count = (d?.count as number) ?? 0;
    if (count === 0) return new Text(theme.fg("dim", "No images"), 0, 0);
    return new Text(theme.fg("accent", `🖼 ${count} image(s)`), 0, 0);
  },
});

// ============================================================
// Tool: browser-back
// ============================================================
const browserBackTool = defineTool({
  name: "browser-back",
  label: "Go Back",
  description: "Navigate back in browser history.",
  parameters: Type.Object({
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { taskId: tid } = params as { taskId?: string };
    const result = await router.goBack(tid ?? taskId(ctx));
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Go back failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    // Include auto-snapshot so the model sees the previous page
    let content = `Went back to: ${result.newUrl || "?"}`;
    if (result.snapshot) {
      content += `\n\n${result.snapshot}`;
    }
    if (result.elementCount !== undefined) {
      content += `\n\nInteractive elements: ${result.elementCount}`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { newUrl: result.newUrl, newTitle: result.newTitle, elementCount: result.elementCount },
    };
  },

  renderCall(_args, theme, _context) {
    return new Text(theme.fg("toolTitle", theme.bold("browser-back")), 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Go back failed"), 0, 0);
    const ec = d?.elementCount as number | undefined;
    return new Text(theme.fg("dim", `← ${(d?.newUrl as string) || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`), 0, 0);
  },
});

// ============================================================
// Tool: browser-press
// ============================================================
const browserPressTool = defineTool({
  name: "browser-press",
  label: "Press Key",
  description:
    'Press a keyboard key (e.g., "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"). ' +
    "Useful for submitting forms, dismissing dialogs, or navigating dropdowns.",
  parameters: Type.Object({
    key: Type.String({ description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp')" }),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { key, taskId: tid } = params as { key: string; taskId?: string };
    const result = await router.press(tid ?? taskId(ctx), key);
    updateFooterStatus(ctx);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Press failed: ${result.error ?? "unknown"}` }],
        details: { error: true },
      };
    }

    // Include auto-snapshot so the model sees updated page state
    let content = `Pressed "${key}"`;
    if (result.snapshot) {
      content += `\n\n${result.snapshot}`;
    }
    if (result.elementCount !== undefined) {
      content += `\n\nInteractive elements: ${result.elementCount}`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { key, elementCount: result.elementCount },
    };
  },

  renderCall(args, theme, _context) {
    return new Text(`${theme.fg("toolTitle", theme.bold("browser-press"))} ${theme.fg("accent", args.key)}`, 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Press failed"), 0, 0);
    const ec = d?.elementCount as number | undefined;
    return new Text(theme.fg("dim", `⌨ ${d?.key || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`), 0, 0);
  },
});

// ============================================================
// Tool: browser-console
// ============================================================
const browserConsoleTool = defineTool({
  name: "browser-console",
  label: "Browser Console",
  description:
    "Execute JavaScript in the current page context and see the result, " +
    "or read captured console output (log, warn, error, info). " +
    "Useful for inspecting page state, reading hidden content, or debugging.",
  parameters: Type.Object({
    expression: Type.Optional(Type.String({ description: "JavaScript expression to evaluate in the page context. If omitted, returns captured console messages." })),
    clear: Type.Optional(Type.Boolean({ description: "If true, clear the captured console log (no other action)" })),
    taskId: Type.Optional(Type.String({ description: "Session ID (auto-populated)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const p = params as { expression?: string; clear?: boolean; taskId?: string };
    const tid = p?.taskId ?? taskId(ctx);

    // Handle clear first (side-effect only)
    if (p?.clear) {
      await router.clearConsole(tid);
      return {
        content: [{ type: "text", text: "Console log cleared." }],
        details: { cleared: true },
      };
    }

    // If expression provided, evaluate it
    if (p?.expression) {
      const result = await router.evaluate(tid, p.expression);

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Evaluation failed: ${result.error ?? "unknown"}` }],
          details: { error: true },
        };
      }

      let formatted: string;
      if (typeof result.result === "string") {
        formatted = result.result;
      } else if (result.result === undefined || result.result === null) {
        formatted = String(result.result);
      } else {
        try {
          formatted = JSON.stringify(result.result, null, 2);
        } catch {
          formatted = String(result.result);
        }
      }
      const TRUNCATE_LIMIT = 10_000;
      if (formatted.length > TRUNCATE_LIMIT) {
        formatted = formatted.slice(0, TRUNCATE_LIMIT) + `\n… (truncated, ${formatted.length - TRUNCATE_LIMIT} more chars)`;
      }
      return {
        content: [{ type: "text", text: formatted || "undefined" }],
        details: { result: result.result },
      };
    }

    // No expression, no clear — read console messages
    const consoleResult = await router.getConsoleMessages(tid);
    if (!consoleResult.success) {
      return {
        content: [{ type: "text", text: `Failed to read console: ${consoleResult.error}` }],
        details: { error: true },
      };
    }

    if (consoleResult.messages.length === 0) {
      return {
        content: [{ type: "text", text: "No console messages captured." }],
        details: { count: 0 },
      };
    }

    const formatted = consoleResult.messages
      .map((m) => `[${m.type}] ${m.text}`)
      .join("\n");
    return {
      content: [{ type: "text", text: formatted }],
      details: { count: consoleResult.messages.length, messages: consoleResult.messages },
    };
  },

  renderCall(args, theme, _context) {
    if (args.clear) return new Text(theme.fg("toolTitle", theme.bold("browser-console clear")), 0, 0);
    if (args.expression) {
      return new Text(`${theme.fg("toolTitle", theme.bold("browser-console"))} ${theme.fg("dim", args.expression.slice(0, 60))}`, 0, 0);
    }
    return new Text(theme.fg("toolTitle", theme.bold("browser-console read")), 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const d = result.details as Record<string, unknown> | undefined;
    if (d?.error) return new Text(theme.fg("error", "Console operation failed"), 0, 0);
    if (d?.cleared) return new Text(theme.fg("dim", "Console cleared"), 0, 0);
    if (d?.result !== undefined) return new Text(theme.fg("dim", `JS → ${JSON.stringify(d.result)?.slice(0, 80) || "ok"}`), 0, 0);
    if (d?.count !== undefined) return new Text(theme.fg("dim", `📋 ${d.count} console messages`), 0, 0);
    return new Text(theme.fg("dim", "Console ok"), 0, 0);
  },
});

// ============================================================
// Command: /browser-status
// ============================================================
const browserStatusCommand = {
  description: "Show browser backend health and active sessions",
  handler: async (_args: string, ctx: any) => {
    const status = sessionManager.getStatus();
    const active = sessionManager.getActiveSessions();
    let msg = `🌐 ${status}`;

    // Backend availability
    const pw = sessionManager.getPlaywrightBrowser();
    const backends: string[] = ["fetch"];
    if (pw?.isConnected()) backends.push("chromium");
    else backends.push("chromium (offline)");
    // Check stealth availability
    try {
      accessSync("/opt/ipw-pyenv/bin/python", constants.X_OK);
      backends.push("stealth");
    } catch {
      backends.push("stealth (offline)");
    }
    msg += `\nBackends: ${backends.join(", ")}`;

    if (active.length > 0) {
      msg += `\nActive sessions: ${active.length}`;
      for (const s of active) {
        const levelEmoji = s.level === "stealth" ? "🦊" : s.level === "chromium" ? "🔧" : "📡";
        msg += `\n  ${levelEmoji} [${s.level}] ${s.currentUrl || "(pending)"}`;
        if (s.currentTitle) msg += ` — ${s.currentTitle}`;
      }
    }
    ctx.ui.notify(msg, "info");
  },
};

// ============================================================
// Extension entry point
// ============================================================
export default function (pi: ExtensionAPI) {
  // Register tools
  pi.registerTool(browserNavigateTool);
  pi.registerTool(browserSnapshotTool);
  pi.registerTool(browserClickTool);
  pi.registerTool(browserTypeTool);
  pi.registerTool(browserScrollTool);
  pi.registerTool(browserScreenshotTool);
  pi.registerTool(browserGetImagesTool);
  pi.registerTool(browserBackTool);
  pi.registerTool(browserPressTool);
  pi.registerTool(browserConsoleTool);

  // Register command
  pi.registerCommand("browser-status", browserStatusCommand);

  // --- Startup --------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("🌐 Browser extension loaded (fetch → chromium → stealth). Try: navigate to a URL or browse interactively.", "info");
    updateFooterStatus(ctx);
  });

  // --- Cleanup --------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    // Clean up the stable session key for this pi session
    const piSessionId = (ctx as any)?.sessionManager?.getSessionId?.();
    if (piSessionId) _sessionKeys.delete(piSessionId);

    await cleanupPlaywright().catch(() => {});
    await cleanupStealth().catch(() => {});
    await sessionManager.removeAll();
    cleanupFetchTempFiles();  // remove any spilled fetch temp files
    try {
      ctx?.ui?.setStatus?.("browser", "");
    } catch {
      // ctx.ui may not be available during shutdown
    }
  });
}
