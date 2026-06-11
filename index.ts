import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as router from "./core/router.js";
import { webFetch, cleanupFetchTempFiles } from "./core/fetch-backend.js";
import { pluginRegistry } from "./core/plugin-registry.js";
import {
	loadPluginConfig,
	detectPluginType,
	DEFAULT_BACKENDS_ROOT,
} from "./core/plugin-config.js";
import { ChromiumPlugin } from "./backends/chromium/index.js";
import { PythonPluginAdapter } from "./backends/python-adapter.js";
import type { PythonBridgeConfig } from "./backends/python-adapter.js";
import { sessionManager } from "./core/shared/session-manager.js";
import initBrowserToggle, { getToggleState } from "./browser-toggle.js";

// ============================================================
// Status bar update helper
// ============================================================
function updateFooterStatus(ctx: {
	ui: { setStatus: (key: string, label: string) => void };
}): void {
	const toggleState = getToggleState();
	if (toggleState === false) {
		ctx.ui.setStatus("browser", "○ web off");
	} else {
		ctx.ui.setStatus("browser", sessionManager.getStatus());
	}
}

// ─── Helper to get a stable taskId from tool call context ──────
const _sessionKeys = new Map<string, string>();
let _sessionCounter = 0;

function taskId(ctx: {
	toolCallId?: string;
	sessionManager?: { getSessionId?: () => string };
}): string {
	const piSessionId = ctx?.sessionManager?.getSessionId?.();
	if (piSessionId) {
		if (!_sessionKeys.has(piSessionId)) {
			_sessionKeys.set(piSessionId, `browser-${++_sessionCounter}`);
		}
		return _sessionKeys.get(piSessionId)!;
	}
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
		"Uses the configured browser plugin (default: Chromium). For stateless HTTP fetches without interactive elements, use web-fetch instead.",
	promptSnippet: "Fetch and read web pages in text form",
	promptGuidelines: [
		"Use browser-navigate when you need to interact with a web page using @e1/@e2 element references (click, type, scroll, etc.).",
		"If you just need the page content as Markdown without interactive elements, use web-fetch instead.",
		"Use @e1, @e2 references from the accessibility tree with browser-click and browser-type to interact with page elements.",
		"If snapshot or interaction returns 'No active session', the previous navigation was in a different context. Use browser-navigate first to establish a session.",
		"After auto-launch, @e refs may have changed — a fresh accessibility tree is returned automatically. Use the new refs for interaction.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to navigate to" }),
		strategy: Type.Optional(
			Type.String({
				description:
					'Backend strategy: "auto" (default) uses the first available plugin; ' +
					'specify a registered plugin name (e.g. "chromium", "chromium-py") to use that backend. ' +
					"For stateless HTTP fetches, use web-fetch instead.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in seconds (default: 30, max: 120)",
				minimum: 1,
				maximum: 120,
			}),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const {
			url,
			strategy = "auto",
			timeout = 30,
		} = params as {
			url: string;
			strategy?: string;
			timeout?: number;
		};
		const tid = taskId(ctx);

		signal?.addEventListener(
			"abort",
			() => {
				sessionManager.removeSession(tid);
				updateFooterStatus(ctx);
			},
			{ once: true },
		);

		const navOptions: router.NavigateOptions = {
			strategy,
			timeout,
			taskId: tid,
		};
		if (signal) navOptions.signal = signal;

		const result = await router.navigate(url, navOptions);

		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to load page: ${result.error ?? "unknown error"}`,
					},
				],
				details: {
					error: true,
					backendUsed: result.backendUsed,
					url: result.url,
				},
			};
		}

		// Safety net: cap content to prevent unbounded context flooding
		let contentText = result.snapshot;
		if (result.elementCount !== undefined && contentText.length > 8000) {
			let cut = contentText.lastIndexOf("\n", 4000);
			if (cut < 2000) cut = 4000;
			contentText =
				contentText.slice(0, cut) +
				`\n… ${contentText.length - cut} more chars (auto-truncated)`;
		}

		const lines = [
			`Title: ${result.title || "(no title)"}`,
			`URL: ${result.url}`,
			`Backend: ${result.backendUsed}`,
			result.elementCount !== undefined
				? `Interactive elements: ${result.elementCount}`
				: "",
			result.botDetectionWarning
				? "⚠ BOT DETECTION WARNING: This page appears to be protected by " +
					"anti-automation. The content below may be incomplete or show " +
					"a challenge page instead of the actual content."
				: "",
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
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [
			theme.fg("toolTitle", theme.bold("browser-navigate ")),
		];
		parts.push(theme.fg("accent", `"${args.url}"`));
		if (args.strategy && args.strategy !== "auto")
			parts.push(theme.fg("dim", `via ${args.strategy}`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Navigating…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(
				theme.fg(
					"error",
					`Failed: ${(result.content?.[0] as any)?.text ?? "?"}`,
				),
				0,
				0,
			);

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
			if (content.length > 500)
				text += `\n${theme.fg("muted", `… ${content.length - 500} more chars`)}`;
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
		full: Type.Optional(
			Type.Boolean({
				description:
					"If true, return complete tree instead of compact view (default: false)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as { full?: boolean; taskId?: string };
		const tid = p?.taskId ?? taskId(ctx);
		const full = p?.full ?? false;
		const result = await router.snapshot(tid, full);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Snapshot failed: ${result.error ?? "unknown"}`,
					},
				],
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
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-snapshot"))} ${theme.fg("dim", label)}`,
			0,
			0,
		);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial)
			return new Text(theme.fg("warning", "Taking snapshot…"), 0, 0);
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
			if (content.length > 400)
				text += `\n${theme.fg("muted", `… ${content.length - 400} more chars`)}`;
			return new Text(text, 0, 0);
		}
		const label = isFull ? " (full)" : " (compact)";
		return new Text(
			theme.fg("accent", `📋 ${ec} elements${label} (expand)`),
			0,
			0,
		);
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
		ref: Type.String({
			description: "Element reference like @e5 (from the accessibility tree)",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { ref, taskId: tid } = params as { ref: string; taskId?: string };
		const result = await router.click(tid ?? taskId(ctx), ref);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Click failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

		const lines = [
			`Clicked ${ref}`,
			result.newUrl ? `URL: ${result.newUrl}` : "",
			result.newTitle ? `Title: ${result.newTitle}` : "",
		].filter(Boolean);

		let content = lines.join("\n");
		if (result.snapshot) {
			content += `\n\n${result.snapshot}`;
		}
		if (result.elementCount !== undefined) {
			content += `\n\nInteractive elements: ${result.elementCount}`;
		}

		return {
			content: [{ type: "text", text: content }],
			details: {
				newUrl: result.newUrl,
				newTitle: result.newTitle,
				elementCount: result.elementCount,
			},
		};
	},

	renderCall(args, theme, _context) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-click"))} ${theme.fg("accent", args.ref)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", `Click failed: ${d.error}`), 0, 0);
		const newUrl = d?.newUrl as string | undefined;
		const ec = d?.elementCount as number | undefined;
		if (newUrl) {
			let text = theme.fg("success", `✅ → ${newUrl}`);
			if (ec !== undefined) text += ` · ${ec} elements`;
			return new Text(text, 0, 0);
		}
		return new Text(
			theme.fg(
				"success",
				`✅ clicked${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
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
		ref: Type.String({
			description:
				"Element reference like @e5 (must be a textbox, searchbox, or combobox)",
		}),
		text: Type.String({ description: "Text to type into the element" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const {
			ref,
			text,
			taskId: tid,
		} = params as { ref: string; text: string; taskId?: string };
		const result = await router.type(tid ?? taskId(ctx), ref, text);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Type failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

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
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-type"))} ${theme.fg("accent", args.ref)} "${args.text}"`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", `Type failed: ${d.error}`), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"success",
				`📝 typed "${d?.text || "?"}"${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
	},
});

// ============================================================
// Tool: browser-scroll
// ============================================================
const browserScrollTool = defineTool({
	name: "browser-scroll",
	label: "Scroll Page",
	description:
		"Scroll the page up or down by approximately one viewport height.",
	parameters: Type.Object({
		direction: StringEnum(["up", "down"] as const, {
			description: "Scroll direction",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { direction, taskId: tid } = params as {
			direction: "up" | "down";
			taskId?: string;
		};
		const result = await router.scroll(tid ?? taskId(ctx), direction);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Scroll failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

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
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-scroll"))} ${theme.fg("dim", args.direction)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Scroll failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`↕ ${d?.direction || "?"}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
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
		question: Type.Optional(
			Type.String({
				description:
					"Optional — if provided and the model has vision, it will answer questions about the screenshot",
			}),
		),
		fullPage: Type.Optional(
			Type.Boolean({
				description:
					"If true, capture full-page screenshot (default: viewport only)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as {
			question?: string;
			fullPage?: boolean;
			taskId?: string;
		};
		const tid = p?.taskId ?? taskId(ctx);
		const fullPage = p?.fullPage ?? false;
		const result = await router.screenshot(tid, fullPage);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Screenshot failed: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		const textContent = p?.question
			? `Screenshot captured. Question: ${p.question}`
			: "Screenshot captured:";

		const mediaType = result.dataUri.startsWith("data:image/jpeg")
			? "image/jpeg"
			: "image/png";
		const base64Data = result.dataUri.replace(/^data:image\/\w+;base64,/, "");

		return {
			content: [
				{ type: "text", text: textContent },
				{ type: "image", data: base64Data, mimeType: mediaType },
			],
			details: { screenshot: true, question: p?.question },
		};
	},

	renderCall(args, theme, _context) {
		if (args.question) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("browser-screenshot"))} ${theme.fg("dim", `"${args.question.slice(0, 60)}"`)}`,
				0,
				0,
			);
		}
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-screenshot")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.question) {
			return new Text(
				`${theme.fg("accent", "📸 Screenshot")} ${theme.fg("dim", `"${(d.question as string).slice(0, 60)}"`)}`,
				0,
				0,
			);
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
	parameters: Type.Object({}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { taskId: tid } = params as { taskId?: string };
		const result = await router.getImages(tid ?? taskId(ctx));

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to get images: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		if (result.images.length === 0) {
			return {
				content: [{ type: "text", text: "No images found on this page." }],
				details: { count: 0 },
			};
		}

		const lines = [`Found ${result.images.length} image(s):`, ""];
		for (const img of result.images) {
			lines.push(
				`- ${img.alt ? `"${img.alt}" ` : ""}${img.src} (${img.width}x${img.height})`,
			);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { count: result.images.length, images: result.images },
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-get-images")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", "Failed to get images"), 0, 0);
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
	parameters: Type.Object({}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { taskId: tid } = params as { taskId?: string };
		const result = await router.goBack(tid ?? taskId(ctx));
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Go back failed: ${result.error ?? "unknown"}`,
					},
				],
				details: { error: true },
			};
		}

		let content = `Went back to: ${result.newUrl || "?"}`;
		if (result.snapshot) {
			content += `\n\n${result.snapshot}`;
		}
		if (result.elementCount !== undefined) {
			content += `\n\nInteractive elements: ${result.elementCount}`;
		}

		return {
			content: [{ type: "text", text: content }],
			details: {
				newUrl: result.newUrl,
				newTitle: result.newTitle,
				elementCount: result.elementCount,
			},
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("browser-back")), 0, 0);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Go back failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`← ${(d?.newUrl as string) || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
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
		key: Type.String({
			description:
				"Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp')",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const { key, taskId: tid } = params as { key: string; taskId?: string };
		const result = await router.press(tid ?? taskId(ctx), key);
		updateFooterStatus(ctx);

		if (!result.success) {
			return {
				content: [
					{ type: "text", text: `Press failed: ${result.error ?? "unknown"}` },
				],
				details: { error: true },
			};
		}

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
		return new Text(
			`${theme.fg("toolTitle", theme.bold("browser-press"))} ${theme.fg("accent", args.key)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) return new Text(theme.fg("error", "Press failed"), 0, 0);
		const ec = d?.elementCount as number | undefined;
		return new Text(
			theme.fg(
				"dim",
				`⌨ ${d?.key || ""}${ec !== undefined ? ` · ${ec} elements` : ""}`,
			),
			0,
			0,
		);
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
		expression: Type.Optional(
			Type.String({
				description:
					"JavaScript expression to evaluate in the page context. If omitted, returns captured console messages.",
			}),
		),
		clear: Type.Optional(
			Type.Boolean({
				description:
					"If true, clear the captured console log (no other action)",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const p = params as {
			expression?: string;
			clear?: boolean;
			taskId?: string;
		};
		const tid = p?.taskId ?? taskId(ctx);

		if (p?.clear) {
			await router.clearConsole(tid);
			return {
				content: [{ type: "text", text: "Console log cleared." }],
				details: { cleared: true },
			};
		}

		if (p?.expression) {
			const result = await router.evaluate(tid, p.expression);

			if (!result.success) {
				return {
					content: [
						{
							type: "text",
							text: `Evaluation failed: ${result.error ?? "unknown"}`,
						},
					],
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
				formatted =
					formatted.slice(0, TRUNCATE_LIMIT) +
					`\n… (truncated, ${formatted.length - TRUNCATE_LIMIT} more chars)`;
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
				content: [
					{
						type: "text",
						text: `Failed to read console: ${consoleResult.error}`,
					},
				],
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
			details: {
				count: consoleResult.messages.length,
				messages: consoleResult.messages,
			},
		};
	},

	renderCall(args, theme, _context) {
		if (args.clear)
			return new Text(
				theme.fg("toolTitle", theme.bold("browser-console clear")),
				0,
				0,
			);
		if (args.expression) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("browser-console"))} ${theme.fg("dim", args.expression.slice(0, 60))}`,
				0,
				0,
			);
		}
		return new Text(
			theme.fg("toolTitle", theme.bold("browser-console read")),
			0,
			0,
		);
	},

	renderResult(result, _options, theme, _context) {
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(theme.fg("error", "Console operation failed"), 0, 0);
		if (d?.cleared) return new Text(theme.fg("dim", "Console cleared"), 0, 0);
		if (d?.result !== undefined)
			return new Text(
				theme.fg(
					"dim",
					`JS → ${JSON.stringify(d.result)?.slice(0, 80) || "ok"}`,
				),
				0,
				0,
			);
		if (d?.count !== undefined)
			return new Text(theme.fg("dim", `📋 ${d.count} console messages`), 0, 0);
		return new Text(theme.fg("dim", "Console ok"), 0, 0);
	},
});

// ============================================================
// Tool: web-fetch
// ============================================================
const webFetchTool = defineTool({
	name: "web-fetch",
	label: "Web Fetch",
	description:
		"Perform a stateless HTTP fetch of a URL and return its content as Markdown. " +
		"Auto-detects JS-only shells and bot challenge pages. " +
		"For interactive browsing with @e1/@e2 element references, use browser-navigate instead.",
	promptSnippet: "Fetch a URL via stateless HTTP and get Markdown content",
	promptGuidelines: [
		"Use web-fetch for quick, stateless page retrieval when you don't need JavaScript or interactive elements.",
		"The tool returns page content as Markdown, truncated to ~4K chars inline.",
		"If the result mentions a temp file with full content, use the read tool with offset/limit to access specific sections.",
		"If the result indicates the page needs JavaScript, switch to browser-navigate with strategy='chromium'.",
		"If bot detection is triggered, the page may be blocked — try browser-navigate instead.",
		"This tool does NOT create a browser session — it's a simple HTTP fetch.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to fetch" }),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in seconds (default: 30, max: 120)",
				minimum: 1,
				maximum: 120,
			}),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const { url, timeout = 30 } = params as {
			url: string;
			timeout?: number;
		};

		const fetchOptions: { url: string; timeout: number; signal?: AbortSignal } =
			{
				url,
				timeout,
			};
		if (signal) fetchOptions.signal = signal;

		const result = await webFetch(fetchOptions);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Fetch failed: ${result.error ?? "unknown error"}`,
					},
				],
				details: {
					error: true,
					url: result.url,
					statusCode: result.statusCode,
				},
			};
		}

		const lines = [
			result.title ? `Title: ${result.title}` : "",
			`URL: ${result.url}`,
			`Backend: ${result.backendUsed}`,
			result.statusCode ? `HTTP ${result.statusCode}` : "",
			result.needsJavaScript
				? "⚠ This page appears to need JavaScript for full rendering."
				: "",
			result.botDetected
				? "⚠ Bot detection triggered — may need stealth backend."
				: "",
			"",
			result.content,
		];

		return {
			content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
			details: {
				title: result.title,
				url: result.url,
				backendUsed: result.backendUsed,
				statusCode: result.statusCode,
				needsJavaScript: result.needsJavaScript,
				botDetected: result.botDetected,
				...(result.filePath ? { filePath: result.filePath } : {}),
				...(result.totalChars ? { totalChars: result.totalChars } : {}),
			},
		};
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("web-fetch "))];
		parts.push(theme.fg("accent", `"${args.url}"`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error)
			return new Text(
				theme.fg(
					"error",
					`Fetch failed: ${(result.content?.[0] as any)?.text ?? "?"}`,
				),
				0,
				0,
			);

		const title = (d?.title as string) || "(no title)";
		const url = (d?.url as string) || "";
		const statusCode = d?.statusCode as number | undefined;
		const needsJS = d?.needsJavaScript as boolean | undefined;
		const botDetected = d?.botDetected as boolean | undefined;

		let text = theme.fg("accent", theme.bold(`📡 ${title}`));
		text += `\n${theme.fg("dim", url)}`;
		if (statusCode) text += ` · HTTP ${statusCode}`;
		if (needsJS) text += ` ${theme.fg("warning", "⚠ needs JS")}`;
		if (botDetected) text += ` ${theme.fg("warning", "⚠ bot detected")}`;

		const content = (result.content?.[0] as any)?.text ?? "";
		if (expanded) {
			const preview = content.replace(/\n{3,}/g, "\n\n").slice(0, 500);
			text += `\n\n${theme.fg("dim", preview)}`;
			if (content.length > 500)
				text += `\n${theme.fg("muted", `… ${content.length - 500} more chars`)}`;
		} else {
			text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
		}
		return new Text(text, 0, 0);
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

		// List available plugins
		const allPlugins = pluginRegistry.availableAll();
		const backendLines: string[] = [];
		for (const p of allPlugins) {
			if (p.enabled) {
				backendLines.push(p.name);
			} else {
				backendLines.push(`${p.name} (disabled)`);
			}
		}
		msg += `\nPlugins: ${backendLines.join(", ")}`;
		msg += `\nUse web-fetch for stateless HTTP fetches.`;

		if (active.length > 0) {
			msg += `\nActive sessions: ${active.length}`;
			for (const s of active) {
				const sym = sessionManager.pluginSymbol(s.pluginName);
				msg += `\n  ${sym} [${s.pluginName}] ${s.currentUrl || "(pending)"}`;
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
	// --- Plugin registration ----------------------------------------
	const { plugins: pluginConfigs, errors: configErrors } = loadPluginConfig();

	// Log config errors
	for (const err of configErrors) {
		console.warn(`[pi-browser] Plugin config error: ${err}`);
	}

	// Register each configured plugin
	for (const config of pluginConfigs) {
		let detection;
		try {
			detection = detectPluginType(config.dir, DEFAULT_BACKENDS_ROOT);
		} catch (err) {
			console.error(
				`[pi-browser] Plugin '${config.name}' (dir: '${config.dir}'): ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}

		if (detection.type === "node") {
			// Node-based backend — currently only ChromiumPlugin
			if (config.dir === "chromium") {
				const plugin = new ChromiumPlugin();
				pluginRegistry.register(plugin, config);
				plugin.init(config.config).catch((err: unknown) => {
					console.error(
						`[pi-browser] Failed to init plugin '${config.name}':`,
						err,
					);
				});
			} else {
				console.warn(
					`[pi-browser] Node plugin '${config.name}' (dir: '${config.dir}') is not yet supported. Only 'chromium' is available as a Node plugin.`,
				);
			}
		} else if (detection.type === "python") {
			// Python-based backend via JSON-RPC bridge
			const bridgeConfig: PythonBridgeConfig = {
				bridgeScript: detection.entryPoint,
			};
			// Merge any user-provided config overrides
			if (config.config) {
				const userConfig = config.config as Partial<PythonBridgeConfig>;
				if (userConfig.pythonPath)
					bridgeConfig.pythonPath = userConfig.pythonPath;
				if (userConfig.pythonArgs)
					bridgeConfig.pythonArgs = userConfig.pythonArgs;
				if (userConfig.capabilities)
					bridgeConfig.capabilities = userConfig.capabilities;
				if (userConfig.transportTimeoutMs)
					bridgeConfig.transportTimeoutMs = userConfig.transportTimeoutMs;
			}
			const adapter = new PythonPluginAdapter(config.name, bridgeConfig);
			pluginRegistry.register(adapter, config);
			adapter.init(config.config).catch((err: unknown) => {
				console.error(
					`[pi-browser] Failed to init Python plugin '${config.name}':`,
					err,
				);
			});
		} else {
			// Exhaustiveness guard — PluginType is currently "node" | "python"
			const _exhaustive: never = detection.type;
			console.warn(
				`[pi-browser] Plugin '${config.name}' has unknown type '${_exhaustive as string}'.`,
			);
		}
	}

	// Fallback: if no plugins were registered, register Chromium as default
	if (pluginRegistry.size === 0) {
		const plugin = new ChromiumPlugin();
		pluginRegistry.register(plugin, {
			name: "chromium",
			dir: "chromium",
			enabled: true,
			config: {},
		});
		plugin.init({}).catch((err: unknown) => {
			console.error(
				"[pi-browser] Failed to init default Chromium plugin:",
				err,
			);
		});
	}

	// --- Register tools ---------------------------------------------
	pi.registerTool(webFetchTool);
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

	// --- Register commands ------------------------------------------
	pi.registerCommand("browser-status", browserStatusCommand);
	initBrowserToggle(pi);

	// --- Startup ----------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const pluginNames = pluginRegistry.available().join(", ");
		ctx.ui.notify(
			`🌐 Browser extension loaded (plugins: ${pluginNames}). Try: web-fetch for static pages or browser-navigate for interactive browsing.`,
			"info",
		);
		updateFooterStatus(ctx);
	});

	// --- Cleanup ----------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		const piSessionId = (ctx as any)?.sessionManager?.getSessionId?.();
		if (piSessionId) _sessionKeys.delete(piSessionId);

		// Clean up all registered plugins
		const ordered = pluginRegistry.getOrdered();
		for (const { plugin } of ordered) {
			await plugin.cleanupAll().catch(() => {});
		}

		await sessionManager.removeAll();
		cleanupFetchTempFiles();
		try {
			ctx?.ui?.setStatus?.("browser", "");
		} catch {
			// ctx.ui may not be available during shutdown
		}
	});
}
