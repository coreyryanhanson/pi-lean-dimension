/**
 * dialog-gate.ts — Side-by-Side Browser Plugin Comparison Runner
 *
 * Runs identical action sequences against multiple backends (ChromiumPlugin +
 * PythonPluginAdapter) and produces a structured comparison table.
 *
 * Usage:
 *   npx tsx scripts/dialog-gate.ts --preset basic-close --repeat 20
 *   npx tsx scripts/dialog-gate.ts --url https://example.com --actions '["navigate","snapshot"]'
 *
 * See phase3-plan.md for full design.
 *
 * @module
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserPlugin } from "../core/plugin-api.js";
import { ChromiumPlugin } from "../backends/chromium/index.js";
import { PythonPluginAdapter } from "../backends/python-adapter.js";
import {
	startTestServer,
	type TestServer,
} from "../__tests__/helpers/test-server.js";
import {
	REDDIT_DIALOG_HTML,
	REDDIT_STACKED_HTML,
	REDDIT_ASYNC_HTML,
	REDDIT_FEED_ONLY_HTML,
	findRef,
} from "../__tests__/helpers/reddit-fixture.js";

// ═══════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════

interface GateOptions {
	/** Target URL (optional when --serve or --preset provides one). */
	url?: string;
	/** Action sequence as parsed JSON array. */
	actions?: string[];
	/** Backend names as parsed JSON array (default: ["chromium"]). */
	backends?: string[];
	/** Iterations per backend (default: 1). */
	repeat: number;
	/** Print per-iteration details to stderr (default: false). */
	verbose: boolean;
	/** File path to write the markdown comparison table. */
	output?: string;
	/** Serve the Reddit fixture at the given route. */
	serve?: string;
	/** Named preset: "basic-close" | "stacked" | "async" | "occlusion". */
	preset?: string;
	/** Baseline file for regression comparison (Task D). */
	compare?: string;
	/** Override auto-detected Python venv path. */
	pythonPath?: string;
	/** Experiment number (Phase 4): 1-5. */
	experiment?: number;
	/** Verify-click occlusion fallback timeout in ms (default: 1500). */
	verifyClickTimeoutMs?: number;
	/** Force a fresh snapshot before every click/type — Experiment 4. */
	autoRefresh: boolean;
}

interface ParsedAction {
	command: string;
	/** For click/type: the ref string (e.g. "@e5" or "[[Reject All]]"). */
	ref?: string;
	/** For type: the text to type. */
	text?: string;
	/** For scroll: direction ("up" | "down"). */
	direction?: string;
	/** For press: key name. */
	key?: string;
	/** For navigate: URL override. */
	url?: string;
	/** For evaluate: JS expression. */
	expression?: string;
	/** For wait: delay in ms. */
	waitMs?: number;
	/** For screenshot: fullPage flag. */
	fullPage?: boolean;
}

interface ActionRecord {
	action: string;
	success: boolean;
	timeMs: number;
	error?: string;
	elementCount?: number;
	/** Captured evaluate result (set when action is evaluate && verbose) */
	evaluateResult?: unknown;
	/** Action-specific extra data for experiment diagnostics */
	diagnostics?: Record<string, unknown>;
	/** Time (ms) since the last snapshot was taken — Experiment 3 */
	snapshotAgeMs?: number;
	/** Whether an auto-refresh snapshot was taken before this action — Experiment 4 */
	autoRefreshed?: boolean;
}

/** Spread-helper: omit undefined optional fields to satisfy exactOptionalPropertyTypes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compact<T extends Record<string, any>>(obj: T): T {
	const out = { ...obj };
	for (const key of Object.keys(out)) {
		if (out[key] === undefined) delete out[key];
	}
	return out;
}

interface IterationResult {
	backend: string;
	iteration: number;
	actions: ActionRecord[];
	overallSuccess: boolean;
	totalTimeMs: number;
}

interface ActionSummary {
	successCount: number;
	totalCount: number;
	times: number[];
	errorFrequencies: Record<string, number>;
	/** Snapshot ages at click/type time — Experiment 3. */
	snapshotAges: number[];
}

interface BackendSummary {
	backend: string;
	totalRuns: number;
	successCount: number;
	successRate: number;
	times: number[];
	avgTimeMs: number;
	minTimeMs: number;
	maxTimeMs: number;
	p50TimeMs: number;
	p95TimeMs: number;
	actionBreakdown: Record<string, ActionSummary>;
}

interface CompareThreshold {
	successRateDrop: number; // e.g. 0.10 means 10% drop allowed
}

// ═══════════════════════════════════════════════════════════════════════
//  Presets — each encodes route + action sequence
// ═══════════════════════════════════════════════════════════════════════

interface SnapshotCache {
	/** The last known snapshot text. */
	snapshot: string | null;
	/** True if the DOM may have changed since the snapshot was taken. */
	stale: boolean;
	/** Timestamp (performance.now) of when the snapshot was taken — Experiment 3. */
	lastSnapshotTime: number;
}

interface Preset {
	route: string;
	actions: string[];
}

const PRESETS: Record<string, Preset> = {
	"basic-close": {
		route: "/reddit-dialog",
		actions: ["navigate", "snapshot", "click [[Reject All]]", "snapshot"],
	},
	stacked: {
		route: "/reddit-stacked",
		actions: [
			"navigate",
			"snapshot",
			"click [[Reject All]]",
			"snapshot",
			"click [[Dismiss]]",
			"snapshot",
		],
	},
	async: {
		route: "/reddit-async",
		actions: [
			"navigate",
			"snapshot",
			"wait 1200",
			"snapshot",
			"click [[Reject All]]",
			"snapshot",
		],
	},
	occlusion: {
		route: "/reddit-dialog",
		actions: ["navigate", "snapshot", "click [[Post Title]]"],
	},
};

// ═══════════════════════════════════════════════════════════════════════
//  HTML fixtures for --serve mode
// ═══════════════════════════════════════════════════════════════════════

/** Map of route → HTML for the self-contained test server. */
// ═══════════════════════════════════════════════════════════════════════
//  Experiment definitions (Phase 4)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Overlay detection JS — finds fixed/sticky elements covering ≥50% viewport width
 * and ≥30% viewport height, reporting tag, role, aria-label, z-index, and
 * visibility. Used by Experiment 1 to compare DOM-based overlay detection vs
 * ariaSnapshot() dialog detection.
 */
const OVERLAY_DETECTION_JS = `
(() => {
  const overlays = [];
  const all = document.querySelectorAll('*');
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const el of all) {
    const style = window.getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    const vis = style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
    if (rect.width >= w * 0.5 && rect.height >= h * 0.3) {
      overlays.push({
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        id: el.id,
        zIndex: parseInt(style.zIndex, 10) || 0,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        cx: Math.round(rect.left + rect.width / 2),
        cy: Math.round(rect.top + rect.height / 2),
        visible: vis
      });
    }
  }
  return overlays.length ? JSON.stringify(overlays) : '[]';
})()
`;

/**
 * Detect dialogs in the DOM by checking for role="dialog" or role="alertdialog"
 * elements directly (independent of ariaSnapshot).
 */
const DIALOG_DOM_CHECK_JS = `
(() => {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  return JSON.stringify(Array.from(dialogs).map(d => ({
    tag: d.tagName,
    role: d.getAttribute('role'),
    ariaLabel: d.getAttribute('aria-label'),
    hidden: d.getAttribute('aria-hidden'),
    visible: d.offsetParent !== null,
    id: d.id
  })));
})()
`;

/**
 * Snapshot-age checker JS — returns the timestamp of when the page was loaded
 * (used in Experiment 3 to estimate snapshot staleness).
 */
const PAGE_TIMESTAMP_JS =
	"Date.now() - (performance.timing?.navigationStart ?? 0)";

/** Diagnostic evaluate expressions keyed by name. */
const DIAG_EVALS: Record<string, string> = {
	"overlay-detection": OVERLAY_DETECTION_JS,
	"dialog-dom-check": DIALOG_DOM_CHECK_JS,
	"page-timestamp": PAGE_TIMESTAMP_JS,
};

interface ExperimentDef {
	name: string;
	description: string;
	/** Extra evaluate actions to inject (inserted after first snapshot). */
	diagnosticActions: string[];
}

const EXPERIMENTS: Record<number, ExperimentDef> = {
	1: {
		name: "Dialog Detection Reliability",
		description:
			"Compare DOM-based overlay detection vs ariaSnapshot() dialog detection. " +
			"Adds overlay-detection and dialog-dom-check evaluate steps after first snapshot.",
		diagnosticActions: [
			"evaluate DIAG:dialog-dom-check",
			"evaluate DIAG:overlay-detection",
		],
	},
	3: {
		name: "Snapshot Timing Window",
		description:
			"Measure time between snapshot and click — no code changes needed, " +
			"snapshot age is automatically tracked for click/type actions. " +
			"Results show snapshotAgeMs per click to check if failures correlate with stale snapshots.",
		diagnosticActions: [],
	},
	4: {
		name: "Auto-Fresh Element Cache",
		description:
			"Force a fresh snapshot before every click, regardless of staleness. " +
			"Compare success rate with vs without forced re-snapshot.",
		diagnosticActions: [],
	},
	5: {
		name: "Side-by-Side Backend Comparison",
		description:
			"Run all 4 presets × 20 against both backends. " +
			"Produces comprehensive comparison table.",
		diagnosticActions: [],
	},
};

// ═══════════════════════════════════════════════════════════════════════
//  HTML fixtures for --serve mode
// ═══════════════════════════════════════════════════════════════════════

const FIXTURE_PAGES: Record<string, string> = {
	"/reddit-dialog": REDDIT_DIALOG_HTML,
	"/reddit-stacked": REDDIT_STACKED_HTML,
	"/reddit-async": REDDIT_ASYNC_HTML,
	"/reddit-feed": REDDIT_FEED_ONLY_HTML,
};

/**
 * Build an HTTP handler that serves fixture pages.
 */
function fixtureHandler(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? "/", "http://localhost");

	// Health-check endpoint for the Python bridge
	if (url.pathname === "/_health") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
		return;
	}

	const html = FIXTURE_PAGES[url.pathname];
	if (html) {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
		return;
	}

	if (url.pathname === "/") {
		res.writeHead(302, { Location: "/reddit-dialog" });
		res.end();
		return;
	}

	res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
	res.end("<html><body><h1>404</h1></body></html>");
}

// ═══════════════════════════════════════════════════════════════════════
//  CLI parsing
// ═══════════════════════════════════════════════════════════════════════

function parseCliArgs(): GateOptions {
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			actions: { type: "string" },
			backends: { type: "string" },
			repeat: { type: "string" },
			verbose: { type: "boolean", default: false },
			output: { type: "string" },
			serve: { type: "string" },
			preset: { type: "string" },
			compare: { type: "string" },
			pythonPath: { type: "string" },
			experiment: { type: "string" },
			verifyClickTimeoutMs: { type: "string" },
			autoRefresh: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	// Parse --experiment (if provided)
	let experiment: number | undefined;
	if (values.experiment) {
		experiment = parseInt(values.experiment, 10);
		if (!EXPERIMENTS[experiment]) {
			console.error(
				`ERROR: Unknown experiment "${values.experiment}". ` +
					`Valid experiments: ${Object.keys(EXPERIMENTS).join(", ")}`,
			);
			process.exit(1);
		}
	}

	// Validate: --preset and --actions are mutually exclusive
	if (values.preset && values.actions) {
		console.error("ERROR: --preset and --actions are mutually exclusive.");
		process.exit(1);
	}

	// Validate: --preset must be known
	if (values.preset && !PRESETS[values.preset]) {
		console.error(
			`ERROR: Unknown preset "${values.preset}". ` +
				`Valid presets: ${Object.keys(PRESETS).join(", ")}`,
		);
		process.exit(1);
	}

	// Parse JSON array strings
	let actions: string[] | undefined;
	if (values.actions) {
		try {
			const parsed = JSON.parse(values.actions);
			if (!Array.isArray(parsed)) {
				throw new Error("actions must be a JSON array");
			}
			actions = parsed as string[];
		} catch (e) {
			console.error(
				`ERROR: --actions must be a JSON array string: ${(e as Error).message}`,
			);
			process.exit(1);
		}
	}

	let backends: string[] | undefined;
	if (values.backends) {
		try {
			const parsed = JSON.parse(values.backends);
			if (!Array.isArray(parsed)) {
				throw new Error("backends must be a JSON array");
			}
			backends = parsed as string[];
		} catch (e) {
			console.error(
				`ERROR: --backends must be a JSON array string: ${(e as Error).message}`,
			);
			process.exit(1);
		}
	}

	const repeat = values.repeat ? parseInt(values.repeat, 10) : 1;
	if (repeat < 1 || !isFinite(repeat)) {
		console.error("ERROR: --repeat must be a positive integer.");
		process.exit(1);
	}

	return {
		url: values.url,
		actions,
		backends,
		repeat,
		verbose: values.verbose ?? false,
		output: values.output,
		serve: values.serve,
		preset: values.preset,
		compare: values.compare,
		pythonPath: values.pythonPath,
		experiment,
		verifyClickTimeoutMs: values.verifyClickTimeoutMs
			? parseInt(values.verifyClickTimeoutMs, 10)
			: undefined,
		autoRefresh: values.autoRefresh ?? false,
	} as GateOptions;
}

// ═══════════════════════════════════════════════════════════════════════
//  Action parser
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse a single action string into a structured action command.
 *
 * Supports:
 *   "navigate"                          — uses injected URL
 *   "snapshot"                          — no args
 *   "click @e5"                         — ref-based
 *   "click [[Reject All]]"              — name-based
 *   "type @e5 hello world"              — ref + text
 *   "type [[Name]] hello world"         — name + text
 *   "scroll down"                       — direction: up|down
 *   "goBack"                            — no args
 *   "press Enter"                       — key
 *   "screenshot"                        — no args
 *   "getImages"                         — no args
 *   "getConsoleMessages"                — no args
 *   "clearConsole"                      — no args
 *   "evaluate document.title"           — expression
 *   "wait 1000"                         — delay in ms
 *   "cleanup"                           — no args
 */
function parseAction(raw: string): ParsedAction {
	const idx = raw.indexOf(" ");
	const command = idx === -1 ? raw : raw.slice(0, idx);
	const rest = idx === -1 ? "" : raw.slice(idx + 1).trim();

	switch (command) {
		case "navigate":
			return { command };
		case "snapshot":
			return { command };
		case "cleanup":
			return { command };
		case "goBack":
			return { command };
		case "screenshot":
			return { command };
		case "getImages":
			return { command };
		case "getConsoleMessages":
			return { command };
		case "clearConsole":
			return { command };

		case "click": {
			if (!rest) throw new Error("click requires a ref (e.g. @e5 or [[text]])");
			return { command, ref: rest };
		}

		case "type": {
			// rest = <ref> <text...>
			if (!rest) throw new Error("type requires a ref and text");
			const spaceIdx = rest.indexOf(" ");
			if (spaceIdx === -1) {
				throw new Error("type requires both a ref and text to type");
			}
			return {
				command,
				ref: rest.slice(0, spaceIdx),
				text: rest.slice(spaceIdx + 1),
			};
		}

		case "scroll": {
			if (rest !== "up" && rest !== "down") {
				throw new Error('scroll requires direction: "up" or "down"');
			}
			return { command, direction: rest };
		}

		case "press":
			if (!rest) throw new Error("press requires a key name");
			return { command, key: rest };

		case "evaluate": {
			if (!rest) throw new Error("evaluate requires a JavaScript expression");
			// Expand DIAG: prefix to full diagnostic expression
			const diagName = rest.startsWith("DIAG:") ? rest.slice(5) : null;
			const expression = diagName ? (DIAG_EVALS[diagName] ?? rest) : rest;
			return { command, expression };
		}

		case "wait": {
			const ms = parseInt(rest, 10);
			if (isNaN(ms) || ms < 0) {
				throw new Error("wait requires a positive integer millisecond delay");
			}
			return { command, waitMs: ms };
		}

		default:
			throw new Error(`Unknown action: "${command}"`);
	}
}

// ═══════════════════════════════════════════════════════════════════════
//  Plugin factory
// ═══════════════════════════════════════════════════════════════════════

/**
 * Auto-detect the Python interpreter path.
 *
 * Checks the project-local venv first, then falls back to `python3` in PATH.
 */
function autoDetectPythonPath(givenPath?: string): string {
	if (givenPath) return givenPath;

	const venvPath = resolve(
		__dirname,
		"..",
		"backends",
		"python-base",
		".venv",
		"bin",
		"python3",
	);
	if (existsSync(venvPath)) return venvPath;

	return "python3";
}

/**
 * Check whether the Python bridge is usable.
 */
function checkPythonAvailable(): boolean {
	const pythonPath = autoDetectPythonPath();
	try {
		const { execSync } = require("node:child_process");
		execSync(`"${pythonPath}" --version`, { stdio: "pipe", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a BrowserPlugin instance by name.
 *
 * @param name  "chromium" or "chromium-py"
 * @param pythonPath  Optional override for Python interpreter path
 * @param verifyClickTimeoutMs  Optional verify-click timeout (default: 1500)
 */
async function createPlugin(
	name: string,
	pythonPath?: string,
	verifyClickTimeoutMs?: number,
): Promise<BrowserPlugin> {
	if (name === "chromium") {
		const plugin = new ChromiumPlugin();
		await plugin.init(
			verifyClickTimeoutMs != null ? compact({ verifyClickTimeoutMs }) : {},
		);
		return plugin;
	}

	if (name === "chromium-py") {
		const scriptPath = resolve(
			__dirname,
			"..",
			"backends",
			"chromium-py",
			"bridge.py",
		);
		if (!existsSync(scriptPath)) {
			throw new Error(`Bridge script not found: ${scriptPath}`);
		}
		const plugin = new PythonPluginAdapter(name, {
			bridgeScript: scriptPath,
			pythonPath: autoDetectPythonPath(pythonPath),
			...(verifyClickTimeoutMs != null ? { verifyClickTimeoutMs } : {}),
		});
		return plugin;
	}

	throw new Error(`Unknown backend: "${name}". Valid: chromium, chromium-py`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Name-based ref resolution (with staleness tracking)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if a ref string is a name-based bracket reference.
 */
function isBracketRef(ref: string): boolean {
	return ref.startsWith("[[") && ref.endsWith("]]");
}

/**
 * Extract the text from a bracket reference "[[Reject All]]" → "Reject All".
 */
function extractBracketText(ref: string): string {
	return ref.slice(2, -2).trim();
}

// ═══════════════════════════════════════════════════════════════════════
//  Comparison helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
}

/**
 * Format a comparison delta string.
 */
function formatDelta(
	chromiumVal: number,
	chromPyVal: number,
	higherIsBetter: boolean,
): string {
	if (chromiumVal === chromPyVal) return "tie";
	const diff = chromiumVal - chromPyVal;
	const pct = chromPyVal === 0 ? 0 : Math.round((diff / chromPyVal) * 100);
	const absPct = Math.abs(pct);
	const better = higherIsBetter
		? diff > 0
			? "chromium"
			: "chrom-py"
		: diff < 0
			? "chromium"
			: "chrom-py";
	const arrow = "+";
	return `${better} ${arrow}${absPct}%`;
}

/**
 * Format a millisecond value for display.
 */
function fmtMs(ms: number): string {
	return `${Math.round(ms).toLocaleString()} ms`;
}

// ═══════════════════════════════════════════════════════════════════════
//  Metric aggregation
// ═══════════════════════════════════════════════════════════════════════

function aggregateResults(results: IterationResult[]): BackendSummary {
	if (results.length === 0) {
		return {
			backend: "unknown",
			totalRuns: 0,
			successCount: 0,
			successRate: 0,
			times: [],
			avgTimeMs: 0,
			minTimeMs: 0,
			maxTimeMs: 0,
			p50TimeMs: 0,
			p95TimeMs: 0,
			actionBreakdown: {},
		};
	}

	const backend = results[0]!.backend;
	const times = results.map((r) => r.totalTimeMs).sort((a, b) => a - b);
	const successCount = results.filter((r) => r.overallSuccess).length;

	// Aggregate per-action breakdown
	const actionBreakdown: Record<string, ActionSummary> = {};
	for (const iter of results) {
		for (const ar of iter.actions) {
			if (!actionBreakdown[ar.action]) {
				actionBreakdown[ar.action] = {
					successCount: 0,
					totalCount: 0,
					times: [],
					errorFrequencies: {},
					snapshotAges: [],
				};
			}
			const abs = actionBreakdown[ar.action]!;
			abs.totalCount++;
			if (ar.success) abs.successCount++;
			abs.times.push(ar.timeMs);
			if (ar.error) {
				abs.errorFrequencies[ar.error] =
					(abs.errorFrequencies[ar.error] ?? 0) + 1;
			}
			if (ar.snapshotAgeMs != null && ar.snapshotAgeMs >= 0) {
				abs.snapshotAges.push(ar.snapshotAgeMs);
			}
		}
	}

	return {
		backend,
		totalRuns: results.length,
		successCount,
		successRate: results.length > 0 ? successCount / results.length : 0,
		times,
		avgTimeMs:
			times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
		minTimeMs: times[0] ?? 0,
		maxTimeMs: times[times.length - 1] ?? 0,
		p50TimeMs: percentile(times, 50),
		p95TimeMs: percentile(times, 95),
		actionBreakdown,
	};
}

// ═══════════════════════════════════════════════════════════════════════
//  Markdown output formatting
// ═══════════════════════════════════════════════════════════════════════

function formatMarkdown(
	summaries: BackendSummary[],
	_options: GateOptions,
): string {
	const lines: string[] = [];

	// Header
	const backends = summaries.map((s) => s.backend);
	const nValues = summaries.map((s) => s.totalRuns);
	const header = backends.map((b, i) => `${b} (n=${nValues[i]})`).join(" | ");
	const sep = backends.map(() => "---").join(" | ");

	lines.push(`# Comparison: ${backends.join(" vs ")}`);
	lines.push("");
	lines.push(`| Metric | ${header} | Δ |`);
	lines.push(`|--------| ${sep} |:-:|`);

	// Compute metrics side-by-side
	const getVal = (
		key:
			| "successRate"
			| "avgTimeMs"
			| "minTimeMs"
			| "maxTimeMs"
			| "p50TimeMs"
			| "p95TimeMs",
	) =>
		summaries.map((s) => {
			if (key === "successRate") {
				return `${s.successCount}/${s.totalRuns} (${(s.successRate * 100).toFixed(1)}%)`;
			}
			return fmtMs(s[key]);
		});

	const successVals = getVal("successRate");
	const avgVals = getVal("avgTimeMs");
	const minVals = getVal("minTimeMs");
	const maxVals = getVal("maxTimeMs");
	const p50Vals = getVal("p50TimeMs");
	const p95Vals = getVal("p95TimeMs");

	// Success rate delta
	const sr1 = summaries[0]?.successRate ?? 0;
	const sr2 = summaries[1]?.successRate ?? 0;
	const srHigherBetter = true;
	const srDelta =
		summaries.length >= 2
			? formatDelta(sr1 * 100, sr2 * 100, srHigherBetter)
			: "—";

	// Time deltas (lower is better)
	const t1 = summaries[0]?.avgTimeMs ?? 0;
	const t2 = summaries[1]?.avgTimeMs ?? 0;
	const tDelta = summaries.length >= 2 ? formatDelta(t1, t2, false) : "—";

	lines.push(`| Success rate | ${successVals.join(" | ")} | ${srDelta} |`);
	lines.push(`| Avg total time | ${avgVals.join(" | ")} | ${tDelta} |`);
	lines.push(`| Min time | ${minVals.join(" | ")} | — |`);
	lines.push(`| Max time | ${maxVals.join(" | ")} | — |`);
	lines.push(`| P50 time | ${p50Vals.join(" | ")} | — |`);
	lines.push(`| P95 time | ${p95Vals.join(" | ")} | — |`);

	// Action Breakdown
	lines.push("");
	lines.push("### Action Breakdown");
	lines.push("");
	const actionHeader = backends
		.map((b) => `${b} success | ${b} avg ms`)
		.join(" | ");
	const actionSep = backends.map(() => "--- | ---").join(" | ");
	lines.push(`| Action | ${actionHeader} |`);
	lines.push(`|--------| ${actionSep} |`);

	// Collect all action names across all summaries
	const allActions = new Set<string>();
	for (const s of summaries) {
		for (const actionName of Object.keys(s.actionBreakdown)) {
			allActions.add(actionName);
		}
	}

	for (const actionName of Array.from(allActions).sort()) {
		const vals = summaries.map((s) => {
			const abs = s.actionBreakdown[actionName];
			if (!abs) return "— | —";
			const success = `${abs.successCount}/${abs.totalCount}`;
			const avg =
				abs.times.length > 0
					? fmtMs(abs.times.reduce((a, b) => a + b, 0) / abs.times.length)
					: "—";
			return `${success} | ${avg}`;
		});
		lines.push(`| ${actionName} | ${vals.join(" | ")} |`);
	}

	// Errors per action
	lines.push("");
	lines.push("### Errors");

	for (const s of summaries) {
		let hasErrors = false;
		for (const [actionName, abs] of Object.entries(s.actionBreakdown)) {
			const errKeys = Object.keys(abs.errorFrequencies);
			if (errKeys.length === 0) continue;
			if (!hasErrors) {
				lines.push("");
				lines.push(`**${s.backend}:**`);
				hasErrors = true;
			}
			for (const [errMsg, count] of Object.entries(abs.errorFrequencies)) {
				lines.push(`- ${actionName}: ${count}× "${errMsg}"`);
			}
		}
		if (!hasErrors) {
			lines.push("");
			lines.push(`**${s.backend}:** no errors`);
		}
	}

	// Snapshot Age Analysis (Experiment 3) — only if any action has snapshot age data
	const hasSnapshotAgeData = summaries.some((s) =>
		Object.values(s.actionBreakdown).some((ab) => ab.snapshotAges.length > 0),
	);
	if (hasSnapshotAgeData) {
		lines.push("");
		lines.push("### Snapshot Age at Click/Type");
		lines.push("");
		const snapAgeHeader = backends
			.map((b) => `${b} avg ms | ${b} max ms | ${b} count`)
			.join(" | ");
		const snapAgeSep = backends.map(() => "--- | --- | ---").join(" | ");
		lines.push(`| Action | ${snapAgeHeader} |`);
		lines.push(`|--------| ${snapAgeSep} |`);

		// Collect actions that have snapshot age data
		const ageActions = new Set<string>();
		for (const s of summaries) {
			for (const [name, ab] of Object.entries(s.actionBreakdown)) {
				if (ab.snapshotAges.length > 0) ageActions.add(name);
			}
		}

		for (const actionName of Array.from(ageActions).sort()) {
			const vals = summaries.map((s) => {
				const abs = s.actionBreakdown[actionName];
				if (!abs || abs.snapshotAges.length === 0) return "— | — | —";
				const avgMs =
					abs.snapshotAges.reduce((a, b) => a + b, 0) / abs.snapshotAges.length;
				const maxMs = Math.max(...abs.snapshotAges);
				return `${fmtMs(avgMs)} | ${fmtMs(maxMs)} | ${abs.snapshotAges.length}`;
			});
			lines.push(`| ${actionName} | ${vals.join(" | ")} |`);
		}
	}

	// Auto-refresh stats (Experiment 4)
	if (_options.autoRefresh) {
		lines.push("");
		lines.push("### Auto-Refresh Stats");
		lines.push("");
		lines.push(
			"_Auto-refresh was enabled: a fresh snapshot was taken before every click/type action._",
		);
	}

	lines.push("");
	lines.push(`_Generated: ${new Date().toISOString()}_`);

	return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
//  Core runner loop
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a single action against a plugin, returning an ActionRecord.
 */
async function runAction(
	plugin: BrowserPlugin,
	action: ParsedAction,
	taskId: string,
	navigateUrl: string,
	// Mutable state for name-based ref resolution
	snapshotCache: SnapshotCache,
	autoRefresh: boolean,
): Promise<ActionRecord> {
	const start = performance.now();

	try {
		switch (action.command) {
			case "navigate": {
				const targetUrl = action.url ?? navigateUrl;
				if (!targetUrl) {
					return failure("navigate", "No URL available for navigation", start);
				}
				const result = await plugin.navigate(targetUrl, taskId, 30_000);
				if (result.success && result.snapshot != null) {
					snapshotCache.snapshot = result.snapshot;
					snapshotCache.stale = false;
					snapshotCache.lastSnapshotTime = performance.now();
				} else {
					snapshotCache.stale = true;
				}
				return record("navigate", result.success, start, {
					elementCount: result.elementCount,
					error: result.error,
				});
			}

			case "snapshot": {
				const result = await plugin.snapshot(taskId);
				if (result.success && result.snapshot != null) {
					snapshotCache.snapshot = result.snapshot;
					snapshotCache.stale = false;
					snapshotCache.lastSnapshotTime = performance.now();
				}
				return record("snapshot", result.success, start, {
					elementCount: result.elementCount,
					error: result.error,
				});
			}

			case "click": {
				if (!action.ref) {
					return failure("click", "No ref specified", start);
				}

				// Experiment 3: track snapshot age before click
				const snapshotAgeMs =
					snapshotCache.lastSnapshotTime > 0
						? performance.now() - snapshotCache.lastSnapshotTime
						: -1;

				// Experiment 4: force fresh snapshot before click if enabled
				let autoRefreshed = false;
				if (autoRefresh) {
					try {
						const snapResult = await plugin.snapshot(taskId);
						if (snapResult.success && snapResult.snapshot != null) {
							snapshotCache.snapshot = snapResult.snapshot;
							snapshotCache.stale = false;
							snapshotCache.lastSnapshotTime = performance.now();
							autoRefreshed = true;
						}
					} catch {
						// ignore
					}
				}

				// Resolve name-based ref
				const resolvedRef = await resolveRef(
					plugin,
					action.ref,
					taskId,
					snapshotCache,
				);
				if (!resolvedRef) {
					return failure(
						"click",
						`Could not find element matching "${action.ref}" in snapshot`,
						start,
					);
				}

				const result = await plugin.click(taskId, resolvedRef);
				snapshotCache.stale = true;
				return record("click", result.success, start, {
					elementCount: result.elementCount,
					error: result.error,
					snapshotAgeMs,
					autoRefreshed,
				});
			}

			case "type": {
				if (!action.ref || action.text === undefined) {
					return failure("type", "Ref and text are required", start);
				}

				// Experiment 3: track snapshot age before type
				const snapshotAgeMsType =
					snapshotCache.lastSnapshotTime > 0
						? performance.now() - snapshotCache.lastSnapshotTime
						: -1;

				// Experiment 4: force fresh snapshot before type if enabled
				let autoRefreshedType = false;
				if (autoRefresh) {
					try {
						const snapResult = await plugin.snapshot(taskId);
						if (snapResult.success && snapResult.snapshot != null) {
							snapshotCache.snapshot = snapResult.snapshot;
							snapshotCache.stale = false;
							snapshotCache.lastSnapshotTime = performance.now();
							autoRefreshedType = true;
						}
					} catch {
						// ignore
					}
				}

				const resolvedRef = await resolveRef(
					plugin,
					action.ref,
					taskId,
					snapshotCache,
				);
				if (!resolvedRef) {
					return failure(
						"type",
						`Could not find element matching "${action.ref}" in snapshot`,
						start,
					);
				}

				const result = await plugin.type(taskId, resolvedRef, action.text);
				snapshotCache.stale = true;
				return record("type", result.success, start, {
					error: result.error,
					snapshotAgeMs: snapshotAgeMsType,
					autoRefreshed: autoRefreshedType,
				});
			}

			case "scroll": {
				const dir = (action.direction ?? "down") as "up" | "down";
				const result = await plugin.scroll(taskId, dir);
				snapshotCache.stale = true;
				return record("scroll", result.success, start, {
					error: result.error,
				});
			}

			case "goBack": {
				const result = await plugin.goBack(taskId);
				snapshotCache.stale = true;
				if (result.success && result.snapshot != null) {
					snapshotCache.snapshot = result.snapshot;
					snapshotCache.stale = false;
					snapshotCache.lastSnapshotTime = performance.now();
				}
				return record("goBack", result.success, start, {
					error: result.error,
				});
			}

			case "press": {
				const key = action.key ?? "Enter";
				const result = await plugin.press(taskId, key);
				snapshotCache.stale = true;
				return record("press", result.success, start, {
					error: result.error,
				});
			}

			case "screenshot": {
				const result = await plugin.screenshot(taskId);
				return record("screenshot", result.success, start, {
					error: result.error,
				});
			}

			case "getImages": {
				const result = await plugin.getImages(taskId);
				return record("getImages", result.success, start, {
					error: result.error,
				});
			}

			case "getConsoleMessages": {
				const result = await plugin.getConsoleMessages(taskId);
				return record("getConsoleMessages", result.success, start, {
					error: result.error,
				});
			}

			case "clearConsole": {
				await plugin.clearConsole(taskId);
				return record("clearConsole", true, start);
			}

			case "evaluate": {
				if (!action.expression) {
					return failure("evaluate", "No expression provided", start);
				}
				// Skip if plugin doesn't support evaluate
				if (!plugin.capabilities.supportsJavaScriptEvaluate) {
					return record("evaluate", true, start);
				}
				const result = await plugin.evaluate(taskId, action.expression);
				return record("evaluate", result.success, start, {
					error: result.error,
					evaluateResult: result.result,
				});
			}

			case "wait": {
				const ms = action.waitMs ?? 1000;
				await new Promise((resolve) => setTimeout(resolve, ms));
				snapshotCache.stale = true;
				return record("wait", true, start);
			}

			case "cleanup": {
				await plugin.cleanup(taskId);
				return record("cleanup", true, start);
			}

			default:
				return failure(action.command, `Unknown command`, start);
		}
	} catch (err) {
		return failure(
			action.command,
			err instanceof Error ? err.message : String(err),
			start,
		);
	}
}

/** Helper: build a successful ActionRecord. */
function record(
	action: string,
	success: boolean,
	start: number,
	extra?: Record<string, unknown>,
): ActionRecord {
	return compact({
		action,
		success,
		timeMs: performance.now() - start,
		...extra,
	}) as ActionRecord;
}

/** Helper: build a failed ActionRecord. */
function failure(action: string, error: string, start: number): ActionRecord {
	return {
		action,
		success: false,
		timeMs: performance.now() - start,
		error,
	};
}

/**
 * Resolve a ref string to an @e reference.
 *
 * If `ref` is already an @e ref (e.g. "@e5"), return it as-is.
 * If `ref` is a bracket reference (e.g. "[[Reject All]]"), resolve it
 * via findRef() against the current snapshot, auto-snapshotting if stale.
 */
async function resolveRef(
	plugin: BrowserPlugin,
	ref: string,
	taskId: string,
	snapshotCache: { snapshot: string | null; stale: boolean },
): Promise<string | null> {
	if (!isBracketRef(ref)) {
		return ref; // Already an @e ref
	}

	const text = extractBracketText(ref);

	// Auto-snapshot if stale
	if (snapshotCache.stale || !snapshotCache.snapshot) {
		try {
			const result = await plugin.snapshot(taskId);
			if (result.success && result.snapshot != null) {
				snapshotCache.snapshot = result.snapshot;
				snapshotCache.stale = false;
			}
		} catch {
			// If snapshot fails, try with whatever we have
		}
	}

	if (!snapshotCache.snapshot) return null;

	const info = findRef(snapshotCache.snapshot, text);
	return info?.ref ?? null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	const options = parseCliArgs();

	// ── Resolve presets ─────────────────────────────────────────
	const resolvedUrl = options.url;
	let resolvedActions: string[];
	let fixtureServer: TestServer | null = null;

	if (options.preset) {
		const preset = PRESETS[options.preset]!;
		resolvedActions = preset.actions;

		// Start fixture server
		fixtureServer = await startTestServer(fixtureHandler);
		const injectedUrl = `${fixtureServer.url}${preset.route}`;

		if (options.verbose) {
			console.error(
				`[gate] Serving fixture at ${fixtureServer.url} (preset: ${options.preset})`,
			);
		}

		// Run
		await runGate(options, resolvedActions, injectedUrl, fixtureServer);
	} else if (options.serve) {
		resolvedActions = options.actions ?? ["navigate", "snapshot"];

		// Validate route
		if (!FIXTURE_PAGES[options.serve]) {
			console.error(
				`ERROR: Unknown route "${options.serve}". ` +
					`Valid: ${Object.keys(FIXTURE_PAGES).join(", ")}`,
			);
			process.exit(1);
		}

		fixtureServer = await startTestServer(fixtureHandler);
		const injectedUrl = `${fixtureServer.url}${options.serve}`;

		if (options.verbose) {
			console.error(
				`[gate] Serving fixture at ${fixtureServer.url} (route: ${options.serve})`,
			);
		}

		await runGate(options, resolvedActions, injectedUrl, fixtureServer);
	} else if (resolvedUrl) {
		resolvedActions = options.actions ?? ["navigate", "snapshot"];
		await runGate(options, resolvedActions, resolvedUrl, null);
	} else {
		console.error(
			"ERROR: Provide one of: --url URL, --preset NAME, or --serve ROUTE.",
		);
		process.exit(1);
	}
}

async function runGate(
	options: GateOptions,
	actions: string[],
	url: string,
	fixtureServer: TestServer | null,
): Promise<void> {
	const backendsToRun = options.backends ?? ["chromium"];
	const repeat = options.repeat;

	// Parse all actions once
	const parsedActions: ParsedAction[] = [];
	for (const raw of actions) {
		try {
			parsedActions.push(parseAction(raw));
		} catch (e) {
			console.error(
				`ERROR: Failed to parse action "${raw}": ${(e as Error).message}`,
			);
			if (fixtureServer) await fixtureServer.stop();
			process.exit(1);
		}
	}

	// Inject experiment diagnostic actions after the first snapshot
	if (options.experiment) {
		const exp = EXPERIMENTS[options.experiment];
		if (exp && exp.diagnosticActions.length > 0) {
			const firstSnapshotIdx = parsedActions.findIndex(
				(pa) => pa.command === "snapshot",
			);
			const insertAt =
				firstSnapshotIdx >= 0 ? firstSnapshotIdx + 1 : parsedActions.length;
			const diagParsed = exp.diagnosticActions.map((raw) => {
				try {
					return parseAction(raw);
				} catch (e) {
					console.error(
						`ERROR: Failed to parse experiment action "${raw}": ${(e as Error).message}`,
					);
					process.exit(1);
				}
			});
			parsedActions.splice(insertAt, 0, ...diagParsed);
			if (options.verbose) {
				console.error(
					`[gate] Injected ${exp.diagnosticActions.length} diagnostic actions for experiment ${options.experiment} (${exp.name})`,
				);
			}
		}
	}

	// Check Python availability if requested
	const wantsPython = backendsToRun.includes("chromium-py");
	const pythonOk = wantsPython && checkPythonAvailable();
	if (wantsPython && !pythonOk) {
		console.error(
			"WARNING: chromium-py requested but Python is unavailable. " +
				"Skipping Python backend.",
		);
	}

	const availableBackends = backendsToRun.filter((b) => {
		if (b === "chromium-py" && !pythonOk) return false;
		return true;
	});

	if (availableBackends.length === 0) {
		console.error("ERROR: No backends available to run.");
		if (fixtureServer) await fixtureServer.stop();
		process.exit(1);
	}

	// Run iterations sequentially per backend
	const allResults: IterationResult[] = [];

	for (const backendName of availableBackends) {
		if (options.verbose) {
			console.error(
				`[gate] Creating backend: ${backendName} (${repeat} iteration(s))`,
			);
		}

		let plugin: BrowserPlugin;
		try {
			plugin = await createPlugin(
				backendName,
				options.pythonPath,
				options.verifyClickTimeoutMs,
			);
		} catch (e) {
			console.error(
				`ERROR: Failed to create plugin "${backendName}": ${(e as Error).message}`,
			);
			if (fixtureServer) await fixtureServer.stop();
			// If this was the only backend, exit 1
			if (availableBackends.length === 1) process.exit(1);
			continue;
		}

		for (let i = 0; i < repeat; i++) {
			const taskId = `${backendName}-iter-${i}-${Date.now()}`;
			const iterStart = performance.now();

			// Per-iteration snapshot cache (fresh each iteration)
			const snapshotCache: SnapshotCache = {
				snapshot: null,
				stale: true,
				lastSnapshotTime: 0,
			};

			const actionResults: ActionRecord[] = [];

			for (const pa of parsedActions) {
				const ar = await runAction(
					plugin,
					pa,
					taskId,
					url,
					snapshotCache,
					options.autoRefresh,
				);
				actionResults.push(ar);
			}

			// Cleanup after iteration
			try {
				await plugin.cleanup(taskId);
			} catch {
				// Best-effort cleanup
			}

			const totalTimeMs = performance.now() - iterStart;
			const overallSuccess = actionResults.every((ar) => ar.success);

			const iterResult: IterationResult = {
				backend: backendName,
				iteration: i,
				actions: actionResults,
				overallSuccess,
				totalTimeMs,
			};

			allResults.push(iterResult);

			if (options.verbose) {
				console.error(
					`[gate] ${backendName} iter ${i}: ${
						overallSuccess ? "OK" : "FAIL"
					} ${Math.round(totalTimeMs)}ms`,
				);

				// Print evaluate results for experiment diagnostics
				for (const ar of actionResults) {
					if (ar.action === "evaluate" && ar.evaluateResult !== undefined) {
						try {
							const val =
								typeof ar.evaluateResult === "string"
									? ar.evaluateResult
									: JSON.stringify(ar.evaluateResult);
							if (val.length > 0) {
								const label = val === "[]" ? "(none found)" : val.slice(0, 500);
								console.error(`[gate]   evaluate result: ${label}`);
							}
						} catch {
							// ignore formatting errors
						}
					}
				}
			}
		}

		// Full cleanup for this backend
		try {
			await plugin.cleanupAll();
		} catch {
			// Best-effort
		}
	}

	// Stop fixture server
	if (fixtureServer) {
		await fixtureServer.stop().catch(() => {});
	}

	// ── Aggregate ──────────────────────────────────────────────
	const summaries = aggregateByBackend(allResults);

	// ── Markdown output ────────────────────────────────────────
	const markdown = formatMarkdown(summaries, options);

	// Write to file if --output specified
	if (options.output) {
		try {
			writeFileSync(options.output, markdown, "utf-8");
			console.error(`[gate] Results written to: ${options.output}`);
		} catch (e) {
			console.error(
				`ERROR: Failed to write output file "${options.output}": ${(e as Error).message}`,
			);
		}
	}

	// Print to stdout
	console.log(markdown);

	// ── Compare mode (Task D) ──────────────────────────────────
	if (options.compare) {
		runCompare(summaries, options);
	}

	// Exit code: 0 = completed, 1 = script error only
	process.exit(0);
}

/**
 * Group all IterationResults by backend and aggregate each group.
 */
function aggregateByBackend(results: IterationResult[]): BackendSummary[] {
	const byBackend = new Map<string, IterationResult[]>();
	for (const r of results) {
		const list = byBackend.get(r.backend);
		if (list) {
			list.push(r);
		} else {
			byBackend.set(r.backend, [r]);
		}
	}

	const summaries: BackendSummary[] = [];
	for (const [, group] of byBackend) {
		summaries.push(compact(aggregateResults(group)) as BackendSummary);
	}

	return summaries;
}

// ═══════════════════════════════════════════════════════════════════════
//  Compare mode (Task D — bonus)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a comparison against a stored baseline file.
 *
 * Splits the baseline markdown into sections (one per `# Comparison:` header),
 * finds the section whose action breakdown matches the current run's action
 * types, parses the success rates by column-position, and checks for
 * regression.
 *
 * @param summaries  Current run results.
 * @param options    Gate options (for baseline file path).
 */
function runCompare(summaries: BackendSummary[], options: GateOptions): void {
	if (!options.compare) return;

	if (!existsSync(options.compare)) {
		console.error(
			`WARNING: Baseline file not found: ${options.compare}. Skipping comparison.`,
		);
		return;
	}

	const baselineContent = readFileSync(options.compare, "utf-8");
	const thresholds: CompareThreshold = {
		successRateDrop: 0.1,
	};

	// Split into sections by comparison header
	const sections = baselineContent.split(/(?=^# Comparison:)/m);

	// Build an action-type + per-iteration-count signature for the current run.
	// Using "actionName:perIterCount" pairs to disambiguate presets with the
	// same action names but different action counts per iteration
	// (e.g. basic-close: snapshot×2 vs occlusion: snapshot×1).
	type SectionEntry = { name: string; perIterCount: number };
	const currentEntries: SectionEntry[] = [];
	for (const s of summaries) {
		for (const [name, ab] of Object.entries(s.actionBreakdown)) {
			if (!currentEntries.find((e) => e.name === name)) {
				currentEntries.push({
					name,
					perIterCount: ab.totalCount / options.repeat,
				});
			}
		}
	}
	currentEntries.sort((a, b) => a.name.localeCompare(b.name));
	const currentSignature = currentEntries
		.map((e) => `${e.name}:${e.perIterCount}`)
		.join(",");

	// Find the section whose action breakdown matches name + per-iteration count
	let matchedSection: string | null = null;
	for (const section of sections) {
		const breakdownStart = section.indexOf("### Action Breakdown");
		if (breakdownStart === -1) continue;

		// Extract the baseline's iteration count n from the header row
		const nMatch = section.match(/\(n=(\d+)\)/);
		const sectionN = nMatch ? parseInt(nMatch[1]!, 10) : 1;

		const afterBreakdown = section.slice(breakdownStart);
		const actionLines = afterBreakdown.split("\n");
		const sectionEntries: SectionEntry[] = [];
		for (const line of actionLines) {
			const trimmed = line.trim();
			if (
				trimmed.startsWith("|") &&
				!trimmed.includes("Action") &&
				!trimmed.includes("---")
			) {
				const cells = trimmed
					.split("|")
					.map((c: string) => c.trim())
					.filter(Boolean);
				if (cells.length >= 1 && cells[0] !== "Action") {
					// cells[0] = action name, cells[1] = "X/Y" (first backend)
					const countMatch = cells[1]?.match(/(\d+)/g);
					if (countMatch && countMatch.length >= 2) {
						const y = parseInt(countMatch[countMatch.length - 1]!, 10);
						sectionEntries.push({
							name: cells[0]!,
							perIterCount: y / sectionN,
						});
					} else {
						sectionEntries.push({ name: cells[0]!, perIterCount: 0 });
					}
				}
			}
		}

		sectionEntries.sort((a, b) => a.name.localeCompare(b.name));
		const sectionSignature = sectionEntries
			.map((e) => `${e.name}:${e.perIterCount}`)
			.join(",");

		if (sectionSignature === currentSignature) {
			matchedSection = section;
			break;
		}
	}

	if (!matchedSection) {
		console.error(
			`WARNING: Could not find baseline section matching signature "${currentSignature}" ` +
				`in ${options.compare}. Comparison skipped.`,
		);
		return;
	}

	// Parse the header row to get backend names in column order
	const headerMatch = matchedSection.match(
		/^\|\s*Metric\s*((?:\|\s*[^|]+\s+\(n=\d+\)\s*)+)\|/m,
	);
	if (!headerMatch) {
		console.error(
			`WARNING: Could not parse baseline header row. Skipping comparison.`,
		);
		return;
	}

	// Extract the backend column positions
	const columnHeaders = headerMatch[1]!
		.split("|")
		.map((h: string) => h.trim())
		.filter(Boolean);

	// Parse the "Success rate" row
	const successRateMatch = matchedSection.match(
		/^\|\s*Success rate\s*((?:\|\s*[^|]+\s*)+)\|/m,
	);
	if (!successRateMatch) {
		console.error(
			`WARNING: Could not parse success rate row from baseline. Skipping comparison.`,
		);
		return;
	}

	const rateCells = successRateMatch[1]!
		.split("|")
		.map((c: string) => c.trim())
		.filter(Boolean);

	// Map each backend to its baseline success rate by column position
	const backendToBaseline: Record<string, number> = {};
	let hasRegression = false;

	for (const s of summaries) {
		// Find this backend's column index in the header
		const colIdx = columnHeaders.findIndex((h: string) =>
			h.startsWith(s.backend),
		);
		if (colIdx === -1 || colIdx >= rateCells.length) {
			console.error(
				`WARNING: Could not find baseline column for "${s.backend}". Skipping.`,
			);
			continue;
		}

		// Parse "X/Y (Z.Z%)"
		const rateCell = rateCells[colIdx]!;
		const pctMatch = rateCell.match(/\(([\d.]+)%\)/);
		if (!pctMatch) {
			console.error(
				`WARNING: Could not parse success rate value "${rateCell}" for ${s.backend}. Skipping.`,
			);
			continue;
		}

		const baselineRate = parseFloat(pctMatch[1]!) / 100;
		backendToBaseline[s.backend] = baselineRate;

		const currentRate = s.successRate;
		const drop = baselineRate - currentRate;

		if (drop > thresholds.successRateDrop) {
			console.error(
				`REGRESSION: "${s.backend}" success rate dropped from ` +
					`${(baselineRate * 100).toFixed(1)}% to ` +
					`${(currentRate * 100).toFixed(1)}% ` +
					`(drop: ${(drop * 100).toFixed(1)}%, threshold: ${(thresholds.successRateDrop * 100).toFixed(0)}%)`,
			);
			hasRegression = true;
		} else {
			const direction =
				drop >= 0
					? `worse by ${(drop * 100).toFixed(1)}%`
					: `improved by ${(Math.abs(drop) * 100).toFixed(1)}%`;
			console.error(
				`[compare] "${s.backend}" success rate: ` +
					`baseline=${(baselineRate * 100).toFixed(1)}%, ` +
					`current=${(currentRate * 100).toFixed(1)}% (${direction})`,
			);
		}
	}

	if (hasRegression) {
		console.error("REGRESSION DETECTED: See above for details.");
		process.exit(1);
	} else {
		console.error("[compare] No regressions detected.");
	}
}

// ── Run ──────────────────────────────────────────────────────────────

main().catch((err) => {
	console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
