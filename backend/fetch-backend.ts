/**
 * Level 1: HTTP Fetch Backend (Decoupled)
 *
 * Uses plain fetch() with configurable User-Agent, HTML parsing via
 * node-html-parser, and Markdown conversion via turndown.
 * No JavaScript execution — fastest path for static content.
 *
 * When called directly via the `webFetch()` entry point, this backend:
 * - Validates the URL (blocks localhost, private IPs, dangerous schemes)
 * - Fetches and converts HTML → Markdown
 * - Runs JS-shell detection inline
 * - Runs bot-detection heuristics inline
 * - Caps content for inline display + spills to temp files when large
 *
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import TurndownService from "turndown";
import { parse as parseHtml } from "node-html-parser";
import { validateUrl } from "../utils/url-safety";
import type { BotDetectionResult } from "../utils/bot-detection";

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (compatible; PiBrowser/1.0; +https://pi.ai)";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
});

/**
 * Detect whether a page is a JS-only shell (empty <div id="root">,
 * mostly <noscript> content, etc.)
 */
function detectNeedsJavaScript(root: ReturnType<typeof parseHtml>): boolean {
	// Check for common JS-app shell patterns
	const rootDiv = root.querySelector("#root, #__next, #app, #__nuxt");
	if (rootDiv) {
		const text = rootDiv.textContent?.trim() || "";
		// If the root div has little or no text content, JS likely hasn't rendered
		if (text.length < 100) return true;
	}

	// Check if most content is in <noscript> tags
	const noscripts = root.querySelectorAll("noscript");
	if (noscripts.length > 0) {
		const bodyText = root.textContent?.trim() || "";
		const noscriptText = noscripts
			.map((n) => n.textContent?.trim() || "")
			.join("");
		if (
			noscriptText.length > 0 &&
			noscriptText.length > bodyText.length * 0.5
		) {
			return true;
		}
	}

	// Check for SPA meta tags
	const metaApp = root.querySelector('meta[name="application-name"]');
	if (metaApp?.getAttribute("content")?.toLowerCase().includes("react")) {
		return true;
	}

	return false;
}

function extractTitle(root: ReturnType<typeof parseHtml>): string {
	const titleTag = root.querySelector("title");
	return titleTag?.textContent?.trim() || "";
}

/**
 * Perform the raw HTTP fetch, HTML parsing, and Markdown conversion.
 * Used internally by `webFetch()` to perform the raw HTTP request.
 */
async function performFetch(
	url: string,
	timeoutMs: number = 30_000,
	signal?: AbortSignal,
): Promise<{ html: string; title: string; needsJavaScript: boolean }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	// Wire up external signal
	if (signal) {
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": DEFAULT_USER_AGENT,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText ?? ""}`);
		}

		const html = await response.text();
		if (!html) {
			throw new Error("Empty body");
		}

		// Parse HTML to extract title and detect JS shells.
		// We need the root to check for these even though we'll parse again
		// below — this avoids a second DOM construction pass.
		const tempRoot = parseHtml(html);
		const title = extractTitle(tempRoot);
		const needsJavaScript = detectNeedsJavaScript(tempRoot);

		return { html, title, needsJavaScript };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Parse HTML → clean up DOM → convert to Markdown.
 */
function htmlToMarkdown(html: string): string {
	const root = parseHtml(html);

	// Remove script, style, noscript tags for cleaner markdown.
	root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
	// Convert SVGs to descriptive placeholders instead of stripping
	root.querySelectorAll("svg").forEach((el) => {
		const ariaLabel =
			el.getAttribute("aria-label") || el.getAttribute("title") || "";
		const role = el.getAttribute("role") || "";
		const img = el.querySelector("image") || el.querySelector("img");
		const alt =
			img?.getAttribute("aria-label") || img?.getAttribute("alt") || "";
		const label = ariaLabel || alt || role || "";
		if (label) {
			el.replaceWith(`[SVG: ${label.trim()}]`);
		} else {
			const textEls = el.querySelectorAll("text");
			const texts = textEls.map((t) => t.textContent?.trim()).filter(Boolean);
			if (texts.length > 0) {
				el.replaceWith(`[SVG with text: ${texts.join("; ").slice(0, 120)}]`);
			} else {
				el.replaceWith(`[SVG graphic]`);
			}
		}
	});

	// Compress data URI images (defense-in-depth)
	root.querySelectorAll("img").forEach((el) => {
		const src = el.getAttribute("src") || "";
		if (src.startsWith("data:")) {
			const alt = el.getAttribute("alt") || "image";
			el.replaceWith(`[Image: data URI - ${alt}]`);
		}
	});

	// Compress large code blocks (>500 chars of text content)
	root.querySelectorAll("pre").forEach((el) => {
		const rawText = el.textContent || "";
		if (rawText.length > 500) {
			let lang = "";
			const match = (el.innerHTML || "").match(
				/<code[^>]*class="[^"]*\blanguage-([a-zA-Z0-9_-]+)"/,
			);
			if (match) {
				lang = match[1] ?? "";
			}
			const lineCount = rawText.split("\n").length;
			el.replaceWith(
				`[${lang || "code"} code (${lineCount} lines, ~${rawText.length} chars)]`,
			);
		}
	});

	return turndown.turndown(root.innerHTML || root.textContent || "").trim();
}

// ─── Decoupled entry point: webFetch() ────────────────────────────────

export interface WebFetchOptions {
	url: string;
	timeout?: number; // seconds, default 30, max 120
	signal?: AbortSignal;
}

export interface WebFetchResult {
	success: boolean;
	url: string;
	title: string;
	content: string; // Truncated inline Markdown
	backendUsed: "fetch"; // Always "fetch"
	needsJavaScript?: boolean; // True if page appears to need JS
	botDetected?: boolean; // True if bot-detection signals found in content
	statusCode?: number;
	error?: string;
	/** Path to temp file with full content (only when content > spill threshold) */
	filePath?: string;
	/** Total character count before truncation */
	totalChars?: number;
}

// ─── Fetch truncation constants ────────────────────────────────────────

/** Maximum inline content length for fetch result Markdown. */
const COMPACT_FETCH_LIMIT = 4000;

/** Only spill fetch content to a temp file when it exceeds this threshold. */
const FETCH_SPILL_THRESHOLD = 5000;

/** Directory for fetch temp files under /tmp. */
const FETCH_TEMP_DIR = `${tmpdir()}/pi-browser`;

/** Tracks active fetch temp files per task so stale ones can be cleaned up. */
const activeFetchFiles = new Map<string, string[]>();

// ─── Temp file management ──────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function writeFetchTempFile(content: string, taskId: string): string {
	try {
		mkdirSync(FETCH_TEMP_DIR, { recursive: true });
	} catch {
		/* best-effort */
	}

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
	const safeTaskId = taskId.replace(/[^a-zA-Z0-9-]/g, "_");
	const filePath = `${FETCH_TEMP_DIR}/fetch-${safeTaskId}-${hash}.md`;

	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function trackFetchFile(taskId: string, filePath: string): void {
	const existing = activeFetchFiles.get(taskId) ?? [];
	for (const oldPath of existing) {
		try {
			rmSync(oldPath, { force: true });
		} catch {
			/* best-effort */
		}
	}
	activeFetchFiles.set(taskId, [filePath]);
}

interface CappedFetchContent {
	inline: string;
	filePath: string | undefined;
	totalChars: number;
}

function capFetchContent(content: string, taskId: string): CappedFetchContent {
	const totalChars = content.length;

	if (totalChars <= FETCH_SPILL_THRESHOLD) {
		return { inline: content, filePath: undefined, totalChars };
	}

	const filePath = writeFetchTempFile(content, taskId);
	trackFetchFile(taskId, filePath);

	let cut = content.lastIndexOf("\n", COMPACT_FETCH_LIMIT);
	if (cut < COMPACT_FETCH_LIMIT / 2) cut = COMPACT_FETCH_LIMIT;

	const inline =
		content.slice(0, cut) +
		`\n\n… ${totalChars - cut} more chars. Full content in ${filePath}`;

	return { inline, filePath, totalChars };
}

/**
 * Remove all fetch temp files.
 * If taskId is provided, only removes files for that task.
 */
export function cleanupFetchTempFiles(taskId?: string): void {
	if (taskId) {
		const paths = activeFetchFiles.get(taskId) ?? [];
		for (const p of paths) {
			try {
				rmSync(p, { force: true });
			} catch {
				/* best-effort */
			}
		}
		activeFetchFiles.delete(taskId);
	} else {
		for (const [, paths] of activeFetchFiles) {
			for (const p of paths) {
				try {
					rmSync(p, { force: true });
				} catch {
					/* best-effort */
				}
			}
		}
		activeFetchFiles.clear();
		try {
			rmSync(FETCH_TEMP_DIR, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

/**
 * Decoupled web fetch entry point.
 *
 * Pipeline: URL safety → fetch → JS detection → bot detection → content capping
 *
 * This function is the new recommended way to perform a stateless HTTP fetch.
 * It replaces the router-level fetch dispatch that used to live in `router.ts navigate()`.
 */
export async function webFetch(
	options: WebFetchOptions,
): Promise<WebFetchResult> {
	const timeout = (options.timeout ?? 30) * 1000;

	// Step 1: URL safety validation
	let url: string;
	try {
		url = new URL(options.url).href;
	} catch {
		return {
			success: false,
			url: options.url,
			title: "",
			content: `Invalid URL: ${options.url}`,
			backendUsed: "fetch",
			error: "Invalid URL",
		};
	}

	const safety = validateUrl(url);
	if (!safety.safe) {
		return {
			success: false,
			url,
			title: "",
			content: safety.reason || "URL blocked",
			backendUsed: "fetch",
			error: `URL blocked: ${safety.reason}`,
		};
	}

	// Step 2: Perform fetch
	let result: { html: string; title: string; needsJavaScript: boolean };
	let statusCode: number | undefined;

	try {
		const fetchResult = await performFetch(url, timeout, options.signal);
		result = fetchResult;
		statusCode = 200;
	} catch (err: unknown) {
		if (err instanceof DOMException && err.name === "AbortError") {
			return {
				success: false,
				url,
				title: "",
				content: "Request timed out or was cancelled",
				backendUsed: "fetch",
				error: "timeout",
			};
		}

		const msg = err instanceof Error ? err.message : String(err);
		const isHttpError = typeof msg === "string" && /^HTTP \d+/.test(msg);

		if (isHttpError) {
			const match = msg.match(/HTTP (\d+)/);
			statusCode = match ? parseInt(match[1]!, 10) : undefined;
			return {
				success: false,
				url,
				title: "",
				content: msg,
				backendUsed: "fetch",
				error: msg,
				...(statusCode !== undefined ? { statusCode } : {}),
			};
		}

		return {
			success: false,
			url,
			title: "",
			content: `Fetch error: ${msg}`,
			backendUsed: "fetch",
			error: msg,
		};
	}

	// Step 3: Convert to Markdown
	const markdown = htmlToMarkdown(result.html);

	// Step 4: Bot detection (inline on fetched content)
	let botDetected: boolean | undefined;
	try {
		const tempRoot = parseHtml(result.html);
		const bodyText = tempRoot.textContent?.trim() || "";
		const botResult: BotDetectionResult = {
			isBlocked: /cloudflare|captcha|verify you are human/i.test(bodyText),
			confidence: 0,
		};
		if (botResult.isBlocked) {
			botDetected = true;
		}
	} catch {
		/* best-effort — don't fail on bot detection errors */
	}

	// Step 5: Cap content
	const taskId = "web-fetch-default"; // No session concept — single shared task key
	const { inline, filePath, totalChars } = capFetchContent(markdown, taskId);

	// Assemble result
	const lines: string[] = [];
	if (result.title) lines.push(`Title: ${result.title}`);
	lines.push(`URL: ${url}`);
	lines.push(
		result.needsJavaScript
			? "⚠ This page appears to need JavaScript for full rendering."
			: "",
	);
	if (botDetected)
		lines.push("⚠ Bot detection triggered — may need stealth backend.");
	lines.push(statusCode ? `HTTP ${statusCode}` : "");
	lines.push("");

	const headerLines = lines.filter(Boolean).join("\n");
	const content = filePath
		? `📄 Full content saved to ${filePath} (${formatBytes(totalChars)}). Use read with offset/limit to access specific sections — do not read the entire file at once.\n\n${headerLines}\n\n${inline}`
		: `${headerLines}\n\n${inline}`;

	return {
		success: true,
		url,
		title: result.title,
		content,
		backendUsed: "fetch",
		...(result.needsJavaScript ? { needsJavaScript: true } : {}),
		...(botDetected ? { botDetected: true } : {}),
		...(statusCode !== undefined ? { statusCode } : {}),
		...(filePath ? { filePath } : {}),
		totalChars,
	};
}
