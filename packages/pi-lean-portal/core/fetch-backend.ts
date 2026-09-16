/**
 * Level 1: HTTP Fetch Backend (Decoupled)
 *
 * Uses plain fetch() with configurable User-Agent, HTML parsing via
 * node-html-parser, and Markdown conversion via turndown.
 * No JavaScript execution — fastest path for static content.
 *
 * When called directly via the `webFetch()` entry point, this backend:
 * - Fetches and converts HTML → Markdown
 * - Runs JS-shell detection inline
 * - Runs bot-detection heuristics inline
 * - Caps content for inline display + spills to temp files when large
 *
 */

import { writeFileSync } from "node:fs";
import {
	BROWSER_TEMP_DIR,
	safeTaskId,
	ensureBrowserTempDir,
	formatBytes,
} from "./shared/paths.js";
import {
	sha256Prefix,
	cutAtNewline,
	trackTempFile,
	cleanupTrackedTempFiles,
} from "./shared/temp-files.js";
import TurndownService from "turndown";
import { parse as parseHtml } from "node-html-parser";
import { checkPage } from "./shared/bot-detection.js";

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
		if (noscriptText.length > 0 && noscriptText.length > bodyText.length * 0.5) {
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
 * Returns the parsed root alongside raw HTML so callers can avoid re-parsing.
 */
async function performFetch(
	url: string,
	timeoutMs: number = 30_000,
	signal?: AbortSignal,
): Promise<{
	title: string;
	needsJavaScript: boolean;
	root: ReturnType<typeof parseHtml>;
}> {
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
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			redirect: "follow",
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText ?? ""}`);
		}

		const html = await response.text();
		if (!html) {
			throw new Error("Empty body");
		}

		const root = parseHtml(html);
		const title = extractTitle(root);
		const needsJavaScript = detectNeedsJavaScript(root);

		return { title, needsJavaScript, root };
	} finally {
		// Timer stays armed through the body read, so `timeout` bounds the
		// whole request, not just the response headers.
		clearTimeout(timeoutId);
	}
}

/**
 * Parse HTML → clean up DOM → convert to Markdown.
 * Accepts a pre-parsed HTMLElement root to avoid re-parsing.
 */
function htmlToMarkdown(root: ReturnType<typeof parseHtml>): string {
	// Remove script, style, noscript tags for cleaner markdown.
	root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
	// Convert SVGs to descriptive placeholders instead of stripping
	root.querySelectorAll("svg").forEach((el) => {
		const ariaLabel =
			el.getAttribute("aria-label") || el.getAttribute("title") || "";
		const role = el.getAttribute("role") || "";
		const img = el.querySelector("image") || el.querySelector("img");
		const alt = img?.getAttribute("aria-label") || img?.getAttribute("alt") || "";
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

interface WebFetchOptions {
	url: string;
	timeout?: number; // seconds, default 30, max 120
	signal?: AbortSignal;
	/** Conversation-scoped taskId; defaults to "web-fetch-default" when not provided. */
	taskId?: string;
}

interface WebFetchResult {
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

/** Tracks active fetch temp files per task so stale ones can be cleaned up. */
const activeFetchFiles = new Map<string, string[]>();

// ─── Temp file management ──────────────────────────────────────────────

function writeFetchTempFile(content: string, taskId: string): string {
	ensureBrowserTempDir();

	const hash = sha256Prefix(content);
	const safe = safeTaskId(taskId);
	const filePath = `${BROWSER_TEMP_DIR}/fetch-${safe}-${hash}.md`;

	writeFileSync(filePath, content, "utf-8");
	return filePath;
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
	trackTempFile(activeFetchFiles, taskId, filePath);

	const cut = cutAtNewline(content, COMPACT_FETCH_LIMIT);

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
	cleanupTrackedTempFiles(activeFetchFiles, taskId);
}

/**
 * Decoupled web fetch entry point.
 *
 * Pipeline: fetch → JS detection → bot detection → content capping
 *
 * This function is the new recommended way to perform a stateless HTTP fetch.
 * It replaces the router-level fetch dispatch that used to live in `router.ts navigate()`.
 */
export async function webFetch(
	options: WebFetchOptions,
): Promise<WebFetchResult> {
	const timeout = (options.timeout ?? 30) * 1000;

	// Parse URL
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

	// Step 1: Perform fetch
	let result: {
		title: string;
		needsJavaScript: boolean;
		root: ReturnType<typeof parseHtml>;
	};
	let statusCode: number | undefined;

	try {
		result = await performFetch(url, timeout, options.signal);
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
				...(statusCode === undefined ? {} : { statusCode }),
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

	// Step 2: Bot detection via shared utility (uses un-mutated parsed root)
	let botDetected: boolean | undefined;
	try {
		const bodyText = result.root.textContent?.trim() || "";
		if (checkPage(result.title, bodyText)) botDetected = true;
	} catch {
		/* best-effort — don't fail on bot detection errors */
	}

	// Step 3: Convert to Markdown (uses pre-parsed root from performFetch)
	// NOTE: htmlToMarkdown mutates the tree — run after bot detection
	const markdown = htmlToMarkdown(result.root);

	// Step 4: Cap content
	const tid = options.taskId ?? "web-fetch-default";
	const { inline, filePath, totalChars } = capFetchContent(markdown, tid);

	// Header (Title/URL/warnings) is assembled by the web-fetch tool — content is Markdown only
	const content = filePath
		? `📄 Full content saved to ${filePath} (${formatBytes(totalChars)}). Use read with offset/limit to access specific sections — do not read the entire file at once.\n\n${inline}`
		: inline;

	return {
		success: true,
		url,
		title: result.title,
		content,
		backendUsed: "fetch",
		...(result.needsJavaScript ? { needsJavaScript: true } : {}),
		...(botDetected ? { botDetected: true } : {}),
		...(filePath ? { filePath } : {}),
		totalChars,
	};
}
