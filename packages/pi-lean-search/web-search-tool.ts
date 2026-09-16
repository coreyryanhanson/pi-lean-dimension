/**
 * web-search tool for pi-lean-search — SearXNG web search with graceful degradation.
 * Config read from Pi settings.json; health state managed in index.ts.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readSearxngUrl } from "./search-config.js";

// ─── Interfaces ───────────────────────────────────────────────────

interface SearXNGResult {
	title: string;
	url: string;
	content: string;
	engine: string;
	score?: number;
}

interface SearXNGAnswerLegacy {
	template: "answer/legacy.html";
	answer: string;
	url?: string;
	engine?: string;
}

interface SearXNGAnswerTranslationItem {
	text: string;
	synonyms?: string[];
}

interface SearXNGAnswerTranslations {
	template: "answer/translations.html";
	translations: SearXNGAnswerTranslationItem[];
	url?: string;
}

interface SearXNGWeatherQuantity {
	val: number | string;
	unit: string;
}

interface SearXNGWeatherItem {
	location?: { name: string };
	temperature?: SearXNGWeatherQuantity;
	condition?: string;
	summary?: string;
	feels_like?: SearXNGWeatherQuantity;
	humidity?: SearXNGWeatherQuantity;
	wind_speed?: SearXNGWeatherQuantity;
	wind_from?: string | { name?: string };
}

interface SearXNGAnswerWeather {
	template: "answer/weather.html";
	current: SearXNGWeatherItem;
	service?: string;
}

type SearXNGAnswer =
	| SearXNGAnswerLegacy
	| SearXNGAnswerTranslations
	| SearXNGAnswerWeather;

interface SearXNGResponse {
	results: SearXNGResult[];
	answers: SearXNGAnswer[];
	suggestions: string[];
}

// ─── Answer rendering ────────────────────────────────────────────

// Duck-types an unknown SearXNG answer template so it still renders.
function unknownAnswerFallback(a: SearXNGAnswer): {
	template: string;
	answer?: string;
} {
	// SAFETY: SearXNG can return answer templates not in the union above;
	// the payload is untyped JSON, so duck-type it as a generic record and
	// pick up a bare `answer` string if present.
	const f = a as unknown as Record<string, unknown>;
	return {
		template: String(f.template ?? "?"),
		...(typeof f.answer === "string" ? { answer: f.answer } : {}),
	};
}

// Box width (chars). Title row: `┌─ <title> ` + dashes to reach BOX_W.
const BOX_W = 40;

function box(title: string, lines: string[]): string {
	const top = `┌─ ${title} ${"─".repeat(Math.max(0, BOX_W - title.length - 4))}`;
	const bottom = `└${"─".repeat(BOX_W - 1)}`;
	return `${top}\n${lines.map((l) => `│ ${l}`).join("\n")}\n${bottom}`;
}

function trunc(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "[…]" : s;
}

function windLine(c: SearXNGWeatherItem): string {
	if (!c.wind_speed) return "";
	let dir = "";
	if (c.wind_from) {
		dir =
			typeof c.wind_from === "object" ? (c.wind_from?.name ?? "") : c.wind_from;
	}
	return `wind ${c.wind_speed.val}${c.wind_speed.unit}${dir ? ` ${dir}` : ""}`;
}

function renderAnswers(answers: SearXNGAnswer[]): string {
	const blocks: string[] = [];

	// Callers pre-slice to 3 — don't cap again here.
	for (const a of answers) {
		let title: string;
		let lines: string[];
		switch (a.template) {
			case "answer/legacy.html": {
				title = "Answer";
				lines = [trunc(a.answer, 500)];
				if (a.url) lines.push(`source: ${a.url}`);
				break;
			}
			case "answer/translations.html": {
				const t = a.translations[0];
				if (!t) continue;
				title = "Translation";
				lines = [t.text];
				if (t.synonyms?.length) {
					lines.push(
						`  synonyms: ${t.synonyms.slice(0, 2).join(", ")}${t.synonyms.length > 2 ? ", …" : ""}`,
					);
				}
				const more = a.translations.length - 1;
				if (more > 0) {
					lines.push(
						`  ${more} more translation${more > 1 ? "s" : ""}${a.url ? ` (source: ${a.url})` : ""}`,
					);
				} else if (a.url) {
					lines.push(`source: ${a.url}`);
				}
				break;
			}
			case "answer/weather.html": {
				const c = a.current;
				if (!c) continue;
				title = "Weather";
				const line1 =
					c.summary ??
					[
						c.location?.name,
						c.temperature ? `${c.temperature.val}${c.temperature.unit}` : "",
						c.condition,
					]
						.filter(Boolean)
						.join(": ");
				lines = [line1];
				const details: string[] = [];
				if (c.feels_like)
					details.push(`feels like ${c.feels_like.val}${c.feels_like.unit}`);
				if (c.humidity)
					details.push(`humidity ${c.humidity.val}${c.humidity.unit}`);
				if (c.wind_speed) details.push(windLine(c));

				if (details.length) lines.push(details.join(" · "));
				if (a.service) lines.push(`source: ${a.service}`);
				break;
			}
			default: {
				const fallback = unknownAnswerFallback(a);
				if (fallback.answer === undefined) {
					blocks.push(`[answer: ${fallback.template}]`);
					continue;
				}
				title = "Answer";
				lines = [trunc(fallback.answer, 500)];
			}
		}
		blocks.push(box(title, lines));
	}

	return blocks.join("\n\n");
}

function answerDetail(a: SearXNGAnswer): {
	template: string;
	text: string;
	url?: string;
} {
	switch (a.template) {
		case "answer/legacy.html":
			return {
				template: a.template,
				text: a.answer,
				...(a.url ? { url: a.url } : {}),
			};
		case "answer/translations.html":
			return {
				template: a.template,
				text: a.translations?.[0]?.text ?? "",
				...(a.url ? { url: a.url } : {}),
			};
		case "answer/weather.html":
			return { template: a.template, text: a.current?.summary ?? "" };
		default: {
			const fallback = unknownAnswerFallback(a);
			return { template: fallback.template, text: fallback.answer ?? "" };
		}
	}
}

// ─── URL building ─────────────────────────────────────────────────

/** Strip trailing slashes so `${base}/search` never double-slashes. */
export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

export function buildSearchUrl(
	baseUrl: string,
	query: string,
	options: {
		pageno: number;
		language: string;
		safesearch: string;
		time_range: string;
		category: string;
		engines: string;
	},
): string {
	const normalized = normalizeBaseUrl(baseUrl);
	const params = new URLSearchParams({
		format: "json",
		q: query,
	});

	if (options.language) params.set("language", options.language);
	if (options.safesearch) params.set("safesearch", options.safesearch);
	if (options.time_range) params.set("time_range", options.time_range);
	if (options.category) params.set("categories", options.category);
	if (options.pageno > 1) params.set("pageno", String(options.pageno));
	if (options.engines) params.set("engines", options.engines);

	return `${normalized}/search?${params.toString()}`;
}

// ─── Tool definition ──────────────────────────────────────────────

/** Uniform failure return: a text block plus tool details. */
function fail<T extends object>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export const webSearchTool = defineTool({
	name: "web-search",
	label: "Web Search",
	description:
		"Search the web using the local SearXNG instance. " +
		"Use for finding current information, research, news, and fact-checking.",
	promptSnippet:
		"Search the web via a local SearXNG instance — use for up-to-date facts, verification, or research.",
	promptGuidelines: [
		'Use when you need recent/current information not already known. Increase `count` for broad research; keep it small for quick lookups. Filter by time_range="day" for breaking news, category="news" for journalism. Set language to match the query (e.g. "de" for German, "es" for Spanish).',
		"Use `pageno` (1-indexed) to fetch deeper pages when `count` results are not enough.",
		"Instant answers (calculator, unit convert, random uuid, hashes, weather, translations) appear above results \u2014 phrase queries like `avg 1 2 3` or `weather berlin` to trigger them.",
		'Target results precisely: prefix the query with a bang to route to a specific source \u2014 `!wp <term>` (Wikipedia), `!images <term>`, `!map <term>`, or `:<lang> !<bang> <term>` (e.g. `:fr !wp paris`). Use the `engines` param to restrict upstreams (e.g. engines="google,bing"). For site-scoped queries put the operator inside `query` \u2014 `site:github.com foo`, `inurl:`, `intitle:`, `filetype:pdf` \u2014 but note these only work with engines that support them (Google, Bing, DuckDuckGo) and are silently ignored by others.',
	],

	parameters: Type.Object({
		query: Type.String({ description: "The search query" }),
		count: Type.Optional(
			Type.Number({
				description: "Number of results to return (default: 5). Max is 100.",
				minimum: 1,
				maximum: 100,
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Request timeout in seconds (default: 15, max configurable: 30)",
				minimum: 1,
				maximum: 30,
			}),
		),
		language: Type.Optional(
			Type.String({
				description:
					'Language code for results (e.g. "en", "de", "es"). Empty string or omit for any language.',
			}),
		),
		safesearch: Type.Optional(
			StringEnum(["0", "1", "2"], {
				description: "Filtering: off=0, moderate=1, strict=2",
			}),
		),
		time_range: Type.Optional(
			StringEnum(["day", "week", "month", "year"], {
				description: "Recency filter: day, week, month, or year",
			}),
		),
		category: Type.Optional(
			StringEnum(
				[
					"general",
					"news",
					"science",
					"images",
					"videos",
					"files",
					"it",
					"social media",
				],
				{
					description: "Result category (e.g. news, science, images)",
				},
			),
		),
		pageno: Type.Optional(
			Type.Number({
				description:
					"Page number, 1-indexed (default: 1). Combine with count to page through results.",
				minimum: 1,
			}),
		),
		engines: Type.Optional(
			Type.String({
				description: 'Comma-separated upstream search engines (e.g. "google,bing")',
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const {
			query,
			count = 5,
			pageno = 1,
			timeout: userTimeout,
			language = "",
			safesearch = "0",
			time_range = "",
			category = "",
			engines = "",
		} = params;

		// ── Config check: graceful degradation when unconfigured ──
		const searxngUrl = readSearxngUrl();
		if (!searxngUrl) {
			return fail(
				"Web search is not configured. " +
					"Set `searxng.url` in `~/.pi/agent/settings.json` " +
					"or `.pi/settings.json` to your SearXNG instance URL. " +
					"For example:\n" +
					'  ```json\n  { "searxng": { "url": "http://localhost:8888" } }\n  ```\n' +
					"See the pi-lean-search README for self-host vs public instance options.",
				{ unconfigured: true },
			);
		}

		// ── Timeout ──
		const timeoutSeconds = Math.min(Math.max(userTimeout ?? 15, 1), 30);

		// ── Build URL ──
		const url = buildSearchUrl(searxngUrl, query, {
			pageno,
			language,
			safesearch,
			time_range,
			category,
			engines,
		});

		// ── AbortController for timeout + cancellation ──
		const controller = new AbortController();
		let timedOut = false;

		if (_signal) {
			_signal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}
		if (_signal?.aborted) {
			return fail("Web search cancelled.", { cancelled: true });
		}

		const timeoutId = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutSeconds * 1000);

		// Abort can surface in either fetch or the body read; label it correctly.
		const abortFail = () => {
			if (timedOut) {
				return fail(
					`Web search timed out after ${timeoutSeconds}s. ` +
						`The SearXNG instance at \`${searxngUrl}\` may be slow ` +
						"or unresponsive.",
					{ timedOut: true, timeout: timeoutSeconds },
				);
			}
			return fail("Web search was cancelled.", { cancelled: true });
		};

		try {
			// ── Layer 1: Connection-level error handling ──
			let response: Response;
			try {
				response = await fetch(url, {
					signal: controller.signal as AbortSignal,
					headers: { Accept: "application/json" },
				});
			} catch (connectionErr) {
				if (
					connectionErr instanceof DOMException &&
					connectionErr.name === "AbortError"
				) {
					return abortFail();
				}
				return fail(
					"Web search connection failed: " +
						(connectionErr instanceof Error
							? connectionErr.message
							: String(connectionErr)),
					{ connectionError: true },
				);
			}

			// ── Layer 2: HTTP error handling ──
			if (!response.ok) {
				return fail(
					`SearXNG error: HTTP ${response.status} ${response.statusText}`,
					{ status: response.status },
				);
			}

			// ── Layer 3: JSON parse error handling ──
			let data: SearXNGResponse;
			try {
				const text = await response.text();
				data = text
					? (JSON.parse(text) as SearXNGResponse)
					: { results: [], answers: [], suggestions: [] };
			} catch (parseErr) {
				// Abort can surface here if the body read stalls past the timeout.
				if (parseErr instanceof DOMException && parseErr.name === "AbortError") {
					return abortFail();
				}
				return fail(
					"Web search returned unexpected response format. " +
						"SearXNG may be misconfigured. Error: " +
						(parseErr instanceof Error ? parseErr.message : String(parseErr)),
					{ parseError: true },
				);
			}

			// ── Deduplicate results by URL ──
			const seenUrls = new Set<string>();
			const uniqueResults = (data.results || []).filter((r) => {
				if (seenUrls.has(r.url)) return false;
				seenUrls.add(r.url);
				return true;
			});

			// Sort by relevance score (descending), missing scores as 0
			const sortedResults = uniqueResults.sort(
				(a, b) => (b.score ?? 0) - (a.score ?? 0),
			);

			// Slice to requested count (schema caps `count` at 100, enforced by runtime validation)
			const results = sortedResults.slice(0, count);

			// Render answer blocks (before empty-results check so answers show even with zero web results)
			const renderedAnswers = (data.answers ?? []).slice(0, 3);
			const answerBlocks = renderAnswers(renderedAnswers);

			if (results.length === 0) {
				if (answerBlocks) {
					return {
						content: [
							{
								type: "text" as const,
								text: answerBlocks + `\n\nNo web results for "${query}".`,
							},
						],
						details: {
							results: [],
							query,
							answers: renderedAnswers.map(answerDetail),
							answerCount: renderedAnswers.length,
						},
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `No web search results found for "${query}".`,
						},
					],
					details: { results: [] },
				};
			}

			// Adaptive output formatting
			const maxSnippetLen = count <= 3 ? 300 : 150;
			let output = answerBlocks ? answerBlocks + "\n\n" : "";
			for (const [i, r] of results.entries()) {
				output += `${i + 1}. ${r.title}\n`;
				output += `   ${r.url}\n`;
				const snippet = (r.content || "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, maxSnippetLen);
				if (snippet) {
					output += `   ${snippet}\n`;
				}
				if (count > 1 && r.engine) {
					output += `   [${r.engine}]`;
				}
				if (Number.isFinite(r.score)) {
					output += ` | score: ${r.score!.toFixed(2)}`;
				}
				output += "\n\n";
			}

			// Suggestions section
			if (data.suggestions?.length) {
				output += `Suggestions: ${data.suggestions.slice(0, 3).join(", ")}`;
			}

			return {
				content: [{ type: "text" as const, text: output.trim() }],
				details: {
					resultCount: results.length,
					query,
					pageno,
					timeout: timeoutSeconds,
					results: results.map((r) => ({
						title: r.title,
						url: r.url,
						engine: r.engine,
						score: r.score,
					})),
					answers: renderedAnswers.map(answerDetail),
					answerCount: renderedAnswers.length,
				},
			};
		} catch (unexpectedErr) {
			return fail(
				"An unexpected error occurred during web search: " +
					(unexpectedErr instanceof Error
						? unexpectedErr.message
						: String(unexpectedErr)),
				{ unexpectedError: true },
			);
		} finally {
			// Timer stays armed through the body read, so `timeout` bounds the
			// whole request, not just the response headers.
			clearTimeout(timeoutId);
		}
	},

	// ── TUI rendering ──────────────────────────────────────────

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("web-search "))];
		parts.push(theme.fg("accent", `"${args.query}"`));
		if (args.count) parts.push(theme.fg("dim", `count=${args.count}`));
		if (args.pageno && args.pageno > 1)
			parts.push(theme.fg("dim", `p${args.pageno}`));
		if (args.category) parts.push(theme.fg("dim", `cat:${args.category}`));
		if (args.time_range) parts.push(theme.fg("dim", `time:${args.time_range}`));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) {
			return new Text(theme.fg("warning", "Searching…"), 0, 0);
		}

		const details = result.details as Record<string, unknown> | undefined;

		if (details?.cancelled) {
			return new Text(theme.fg("warning", "Cancelled"), 0, 0);
		}
		if (details?.timedOut) {
			return new Text(
				theme.fg("error", `Timed out (${details.timeout ?? "?"}s)`),
				0,
				0,
			);
		}
		if (details?.connectionError) {
			return new Text(theme.fg("error", "Connection failed"), 0, 0);
		}
		if (details?.unconfigured) {
			return new Text(theme.fg("warning", "Not configured"), 0, 0);
		}
		if (details?.parseError) {
			return new Text(theme.fg("error", "Bad response"), 0, 0);
		}
		if (details?.status) {
			return new Text(theme.fg("error", `HTTP ${details.status}`), 0, 0);
		}

		const results = details?.results as
			| Array<{ title: string; url: string; engine?: string; score?: number }>
			| undefined;
		const resultCount = details?.resultCount as number | undefined;
		const query = details?.query as string | undefined;
		const answerCount = details?.answerCount as number | undefined;
		const answers = details?.answers as
			| Array<{ template: string; text: string; url?: string }>
			| undefined;

		const answerTexts =
			expanded && answers?.length
				? answers.map((a) => theme.fg("accent", a.text)).join("\n")
				: "";

		if (answerCount && (!results || results.length === 0)) {
			let msg = `${theme.fg("muted", `💡 ${answerCount} answer(s) for `)}${theme.fg("accent", `"${query ?? "?"}"`)}`;
			if (answerTexts) msg += `\n${answerTexts}`;
			return new Text(msg, 0, 0);
		}

		if (!results || results.length === 0) {
			const msg = query ? `No results for "${query}"` : "No results";
			return new Text(theme.fg("dim", msg), 0, 0);
		}

		const answerBadge = answerCount
			? theme.fg("muted", `💡 ${answerCount} answer(s) · `)
			: "";
		let text =
			answerBadge +
			theme.fg("muted", `🔍 ${resultCount ?? results.length} result(s) for `) +
			theme.fg("accent", `"${query ?? "?"}"`);

		if (answerTexts) text += `\n${answerTexts}`;

		const display = expanded ? results : results.slice(0, 5);

		for (const r of display) {
			const score =
				typeof r.score === "number"
					? ` ${theme.fg("dim", `⭐ ${r.score.toFixed(2)}`)}`
					: "";
			text += `\n${theme.fg("toolTitle", r.title)}${score}`;
			text += `\n${theme.fg("dim", r.url)}`;
		}

		if (!expanded && results.length > 5) {
			text += `\n${theme.fg("muted", `… ${results.length - 5} more (expand)`)}`;
		}

		return new Text(text, 0, 0);
	},
});
