/**
 * MiniWoB adapter — TypeScript wrapper around the Python driver
 * (`adapter/miniwob-driver.py`) that runs a MiniWoB++ task
 * end-to-end against a `BrowserPlugin`.
 *
 * Mode A (plugin-owns-browser): The plugin launches its own browser
 * and exposes an attach endpoint via `getAttachEndpoint()` (chromium:
 * `{kind:"cdp", endpoint}`, firefox: `{kind:"firefox-ws", endpoint}`);
 * the Python driver attaches and runs setup/validate on the shared page.
 *
 * Invariant: only the Node plugin drives actions (click/type/scroll).
 * The Python driver only runs `setup` and `validate` — it never
 * touches the DOM. This keeps the `@e`-ref accessibility model
 * authoritative.
 *
 * @module
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	BrowserPlugin,
	AttachEndpoint,
} from "../../pi-lean-portal/core/plugin-api.js";

// ─── Types ────────────────────────────────────────────────────────

/** Context handed to a {@link TrivialSolver}. */
export interface SolverCtx {
	plugin: BrowserPlugin;
	taskId: string;
	/** Task utterance / goal. */
	goal: string;
	/** Post-setup accessibility snapshot with `@e` refs. */
	snapshot: string;
	/** Helper to take a fresh snapshot. */
	snapshotNow(): Promise<string>;
}

/**
 * A trivial, task-specific solver.
 */
export type TrivialSolver = (ctx: SolverCtx) => Promise<void>;

/** Options for {@link runMiniwobTask}. */
export interface RunMiniwobTaskOptions {
	plugin: BrowserPlugin;
	taskName: string;
	seed: number;
	/** Base URL of the running MiniWoB server (the `miniwob/html/` root). */
	baseUrl: string;
	/**
	 * Actor strategy. Phase 1 supports `"trivial"` only — the caller
	 * supplies a {@link TrivialSolver}.
	 */
	actor: "trivial";
	/** Required when `actor === "trivial"`. */
	solver?: TrivialSolver;
	/** Hard safety cap on solver/validate round-trips (default 20). Wall-clock `donePollTimeoutMs` is the primary bail; this is a defensive upper bound. */
	maxSteps?: number;
	/** Episode max time in ms (default 30_000). */
	episodeMaxTimeMs?: number;
	/** Per-call navigate timeout in ms (default 15_000). */
	navigateTimeoutMs?: number;
	/** Poll interval for `validate` after the solver returns (default 200ms). */
	donePollIntervalMs?: number;
	/** How long to poll `done` after the solver returns (default 10_000ms). */
	donePollTimeoutMs?: number;
	/**
	 * Python interpreter path for the driver process.
	 * Defaults to the plugin's Python adapter path if not set.
	 */
	pythonPath?: string;
}

/** Result of {@link runMiniwobTask}. */
export interface MiniwobTaskResult {
	goal: string;
	/** `1` if `rawReward > 0`, else `0`. */
	reward: number;
	/** Raw reward float from `validate()`. */
	rawReward: number;
	done: boolean;
	reason: string;
	/** Number of solver/validate round-trips executed (reported count, not a bail condition). */
	steps: number;
	/** True if the done-poll bailed before `done` flipped. */
	timedOut: boolean;
	/** Why the poll loop bailed: `"wall-clock"` (exceeded `donePollTimeoutMs`), `"max-steps"` (hit the `maxSteps` safety cap), or `null` if `done` flipped naturally. */
	bailReason: "wall-clock" | "max-steps" | null;
	/** True if a setup step (navigate / connect / setup) failed. */
	setupFailed: boolean;
	error?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_EPISODE_MAX_MS = 30_000;
const DEFAULT_NAVIGATE_TIMEOUT_MS = 15_000;
const DEFAULT_DONE_POLL_INTERVAL_MS = 200;
const DEFAULT_DONE_POLL_TIMEOUT_MS = 10_000;
const BRIDGE_RPC_TIMEOUT_MS = 60_000;

// ─── Bridge path resolution ───────────────────────────────────────

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(ADAPTER_DIR, "miniwob-driver.py");

// ─── JSON-RPC client for the driver subprocess ────────────────────

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
	private _proc: ChildProcess | null = null;
	private _reqId = 0;
	private _pending = new Map<number, PendingRequest>();
	private _buffer = "";
	private _stderr = "";

	constructor(
		private readonly _pythonPath: string,
		private readonly _bridgeScript: string,
	) {
		if (!existsSync(_bridgeScript)) {
			throw new Error(`MiniWoB driver script not found: ${_bridgeScript}`);
		}
	}

	async start(): Promise<void> {
		await new Promise<void>((resolveStart, rejectStart) => {
			const proc = spawn(this._pythonPath, [this._bridgeScript], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PYTHONUNBUFFERED: "1" },
			});
			this._proc = proc;

			proc.stdout?.on("data", (chunk: Buffer) => {
				this._buffer += chunk.toString();
				this._flush();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				this._stderr += chunk.toString();
			});
			proc.on("error", rejectStart);
			proc.on("exit", (code) => {
				this._proc = null;
				const pending = new Map(this._pending);
				this._pending.clear();
				for (const [, p] of pending) {
					clearTimeout(p.timer);
					p.reject(
						new Error(
							`MiniWoB driver exited (code=${code})${
								this._stderr ? `\nstderr:\n${this._stderr}` : ""
							}`,
						),
					);
				}
			});

			// Ping handshake.
			setImmediate(async () => {
				try {
					await this.call("ping", {}, 10_000);
					resolveStart();
				} catch (err) {
					if (this._proc) this._kill();
					rejectStart(
						new Error(
							`MiniWoB driver ping failed: ${
								err instanceof Error ? err.message : String(err)
							}${this._stderr ? `\nstderr:\n${this._stderr}` : ""}`,
						),
					);
				}
			});
		});
	}

	call<T = unknown>(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number = BRIDGE_RPC_TIMEOUT_MS,
	): Promise<T> {
		if (!this._proc || this._proc.killed) {
			throw new Error("MiniWoB driver is not running");
		}
		return new Promise<T>((resolveCall, rejectCall) => {
			const id = ++this._reqId;
			const timer = setTimeout(() => {
				this._pending.delete(id);
				this._kill();
				rejectCall(
					new Error(
						`MiniWoB driver RPC timed out after ${timeoutMs}ms: ${method}`,
					),
				);
			}, timeoutMs);
			this._pending.set(id, {
				resolve: resolveCall as (v: unknown) => void,
				reject: rejectCall,
				timer,
			});
			const line =
				JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
			const stdin = this._proc?.stdin;
			if (!stdin || stdin.destroyed) {
				clearTimeout(timer);
				this._pending.delete(id);
				rejectCall(new Error("MiniWoB driver stdin closed"));
				return;
			}
			stdin.write(line);
		});
	}

	async stop(): Promise<void> {
		if (!this._proc) return;
		this._kill();
	}

	private _flush(): void {
		const lines = this._buffer.split("\n");
		this._buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let resp: {
				id?: unknown;
				result?: unknown;
				error?: {
					code: number;
					message: string;
					data?: { traceback?: string };
				};
			};
			try {
				resp = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const id = typeof resp.id === "number" ? resp.id : Number(resp.id);
			const pending = this._pending.get(id);
			if (!pending) continue;
			clearTimeout(pending.timer);
			this._pending.delete(id);
			if (resp.error) {
				// The MiniWoB driver sends errors as
				//   { error: "<message string>", traceback: "<tb string>" }
				// (top-level fields — see miniwob-driver.py). Some callers
				// may use the JSON-RPC object shape
				//   { error: { code, message, data: { traceback } } }.
				// Handle both so a driver-side failure always surfaces a real
				// message instead of being swallowed into `undefined`.
				const errObj = resp.error as unknown;
				const message =
					typeof errObj === "string"
						? errObj
						: (errObj as { message?: string }).message ??
							  String(errObj);
				const tb =
					typeof errObj === "string"
						? (resp as { traceback?: string }).traceback
						: (errObj as { data?: { traceback?: string } }).data?.traceback;
				const e = new Error(
					`${message}${tb ? `\n${tb}` : ""}`,
				);
				pending.reject(e);
			} else {
				pending.resolve(resp.result);
			}
		}
	}

	private _kill(): void {
		const proc = this._proc;
		if (!proc) return;
		try {
			proc.removeAllListeners("exit");
			if (!proc.killed) proc.kill("SIGTERM");
			setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}, 500).unref();
		} catch {
			/* already dead */
		}
		this._proc = null;
	}
}

// ─── sleep helper ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Run a single MiniWoB++ task end-to-end against `plugin`.
 *
 * Steps:
 *   1. Navigate the plugin to `${baseUrl}/miniwob/${taskName}.html`.
 *      (Launches the browser, populates the CDP endpoint.)
 *   2. Spawn the MiniWoB Python driver, connect over CDP.
 *   3. `setup({ subdomain, seed, base_url, episode_max_time_ms })` → goal.
 *   4. Take an `@e`-ref snapshot; hand it to the solver.
 *   5. Poll `validate()` until `done` or `donePollTimeoutMs`.
 *   6. Teardown, stop the driver, return the result bag.
 *
 * Attach endpoint: reads `plugin.getAttachEndpoint()` (chromium →
 * `{kind:"cdp", endpoint}`, firefox → `{kind:"firefox-ws", endpoint}`).
 * The caller must ensure the plugin has launched and the endpoint is
 * populated (e.g. via `navigate`).
 *
 * The caller owns the plugin lifecycle (`init` / `cleanupAll`); this
 * function calls `plugin.navigate` and (on success) `plugin.cleanup`
 * for the per-task session.
 */
export async function runMiniwobTask(
	opts: RunMiniwobTaskOptions,
): Promise<MiniwobTaskResult> {
	const {
		plugin,
		taskName,
		seed,
		baseUrl,
		solver,
		maxSteps = DEFAULT_MAX_STEPS,
		episodeMaxTimeMs = DEFAULT_EPISODE_MAX_MS,
		navigateTimeoutMs = DEFAULT_NAVIGATE_TIMEOUT_MS,
		donePollIntervalMs = DEFAULT_DONE_POLL_INTERVAL_MS,
		donePollTimeoutMs = DEFAULT_DONE_POLL_TIMEOUT_MS,
		pythonPath,
	} = opts;

	if (!solver) {
		return fail("actor: 'trivial' requires a solver.");
	}

	const taskId = `miniwob-${taskName}-${seed}`;
	const taskUrl = `${baseUrl.replace(/\/$/, "")}/miniwob/${taskName}.html`;

	// 1. Navigate — launches the browser + populates the CDP endpoint.
	const nav = await plugin.navigate(taskUrl, taskId, navigateTimeoutMs);
	if (!nav.success) {
		return fail(`navigate failed: ${nav.error ?? "unknown"}`);
	}

	// 2. Resolve attach endpoint (plugin-owns-browser).
	//    The plugin exposes `getAttachEndpoint()` returning a typed
	//    descriptor ({kind, endpoint}) — "cdp" for chromium family,
	//    "firefox-ws" for firefox family. The driver dispatches on
	//    `kind` to use the right Playwright client.
	const attachFn = plugin.getAttachEndpoint;
	if (typeof attachFn !== "function") {
		await plugin.cleanup(taskId).catch(() => {});
		return fail(
			"plugin does not expose getAttachEndpoint() — external attach unavailable.",
		);
	}
	const attachEp: AttachEndpoint | null = attachFn.call(plugin);
	if (!attachEp) {
		await plugin.cleanup(taskId).catch(() => {});
		return fail(
			"plugin.getAttachEndpoint() returned null — browser may not have launched " +
				"with an attach port (set CDP_PORT env for chromium as fallback, " +
				"or ensure firefox launch_server path is active).",
		);
	}

	// 3. Spawn the driver + connect.
	const resolvedPython = pythonPath ?? "python3";
	let bridge: BridgeClient;
	try {
		bridge = new BridgeClient(resolvedPython, BRIDGE_SCRIPT);
		await bridge.start();
	} catch (err) {
		await plugin.cleanup(taskId).catch(() => {});
		return fail(
			`driver spawn failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		await bridge.call("connect", {
			endpoint: attachEp.endpoint,
			kind: attachEp.kind,
		});

		// 4. Setup → goal.
		const setupRes = (await bridge.call("setup", {
			subdomain: taskName,
			base_url: baseUrl,
			seed,
			episode_max_time_ms: episodeMaxTimeMs,
		})) as { goal?: string };
		const goal = setupRes.goal ?? "";

		// 5. Snapshot + solver.
		const snap = await plugin.snapshot(taskId);
		const snapshotText = snap.success ? snap.snapshot : "";
		const ctx: SolverCtx = {
			plugin,
			taskId,
			goal,
			snapshot: snapshotText,
			snapshotNow: async (): Promise<string> => {
				const s = await plugin.snapshot(taskId);
				return s.success ? s.snapshot : "";
			},
		};
		try {
			await solver(ctx);
		} catch (err) {
			return {
				goal,
				reward: 0,
				rawReward: 0,
				done: false,
				reason: "",
				steps: 0,
				timedOut: false,
				bailReason: null,
				setupFailed: false,
				error: `solver raised: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 6. Poll validate until done. Wall-clock (`donePollTimeoutMs`) is the
		// primary bail; `maxSteps` is a hard safety cap. `steps` is a reported
		// count, not a bail condition — both bails set `timedOut=true` and
		// record a `bailReason` so callers can distinguish them.
		const pollStart = Date.now();
		let steps = 0;
		let last = { reward: 0, raw_reward: 0, done: false, reason: "" } as {
			reward: number;
			raw_reward: number;
			done: boolean;
			reason: string;
		};
		let timedOut = false;
		let bailReason: "wall-clock" | "max-steps" | null = null;
		while (true) {
			last = (await bridge.call("validate", {})) as typeof last;
			steps++;
			if (last.done) {
				bailReason = null;
				break;
			}
			if (Date.now() - pollStart > donePollTimeoutMs) {
				timedOut = true;
				bailReason = "wall-clock";
				break;
			}
			if (steps >= maxSteps) {
				timedOut = true;
				bailReason = "max-steps";
				break;
			}
			await sleep(donePollIntervalMs);
		}

		return {
			goal,
			reward: last.reward > 0 ? 1 : 0,
			rawReward: last.raw_reward,
			done: last.done,
			reason: last.reason,
			steps,
			timedOut,
			bailReason,
			setupFailed: false,
		};
	} catch (err) {
		return fail(
			`driver RPC failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		await bridge.stop().catch(() => {});
		await plugin.cleanup(taskId).catch(() => {});
	}
}

function fail(error: string): MiniwobTaskResult {
	return {
		goal: "",
		reward: 0,
		rawReward: 0,
		done: false,
		reason: "",
		steps: 0,
		timedOut: false,
		bailReason: null,
		setupFailed: true,
		error,
	};
}
