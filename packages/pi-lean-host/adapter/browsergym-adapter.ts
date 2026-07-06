/**
 * BrowserGym adapter — TypeScript wrapper around the Python bridge
 * (`adapter/browsergym-bridge.py`) that runs a MiniWoB++ task
 * end-to-end against a `BrowserPlugin`.
 *
 * Phase 1 (`browsergym-migration-plan-v2.md` §1.3): Mode A only
 * (plugin-owns-browser). The plugin launches its own Chromium with
 * `--remote-debugging-port=0` and exposes `getCdpEndpoint()`; the
 * Python bridge attaches via `connect_over_cdp` and runs
 * `task.setup(page)` / `task.validate(page)` on the shared page.
 * Mode B (host-owns-browser, `connectOverCDP`) is wired by
 * `bench.ts`'s mode negotiation, not here.
 *
 * Invariant: only the Node plugin drives actions (click/type/scroll).
 * The Python bridge only runs `setup` and `validate` — it never
 * touches the DOM beyond BrowserGym's own setup injection. This keeps
 * the `@e`-ref accessibility model authoritative and avoids any
 * collision with BrowserGym's `bid` stamping.
 *
 * @module
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserPlugin } from "../../pi-lean-portal/core/plugin-api.js";

// ─── Types ────────────────────────────────────────────────────────

/** Context handed to a {@link TrivialSolver} — mirrors the portal's old `MiniwobSolverCtx`. */
export interface SolverCtx {
	plugin: BrowserPlugin;
	taskId: string;
	/** Task utterance / goal (from BrowserGym's `task_info["goal"]`). */
	goal: string;
	/** Post-setup accessibility snapshot with `@e` refs. */
	snapshot: string;
	/** Helper to take a fresh snapshot. */
	snapshotNow(): Promise<string>;
}

/**
 * A trivial, task-specific solver. Batch C moves the 13 shipped
 * solvers from the portal into `pi-lean-host/solvers/`; for Batch B's
 * smoke test an inline solver is sufficient.
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
	 * supplies a {@link TrivialSolver}. Phase 2 widens this to a union
	 * that adds a Pi-agent actor.
	 */
	actor: "trivial";
	/** Required when `actor === "trivial"`. */
	solver?: TrivialSolver;
	/** Max solver/validate round-trips before bailing (default 20). */
	maxSteps?: number;
	/** Episode max time in ms, forwarded to BrowserGym setup (default 30_000). */
	episodeMaxTimeMs?: number;
	/** Per-call navigate timeout in ms (default 15_000). */
	navigateTimeoutMs?: number;
	/** Poll interval for `validate` after the solver returns (default 200ms). */
	donePollIntervalMs?: number;
	/** How long to poll `done` after the solver returns (default 10_000ms). */
	donePollTimeoutMs?: number;

	/**
	 * CDP endpoint override for Mode B (host-owns-browser). When set,
	 * the bridge uses this endpoint directly instead of calling
	 * `plugin.getCdpEndpoint()`. The host launched the reference
	 * browser and owns the endpoint.
	 *
	 * Prefixed with `_` to indicate this is an internal detail of the
	 * host-plugin interaction; external callers should use
	 * `benchPlugin` with `mode: "host-owns-browser"` instead.
	 */
	_cdpEndpointOverride?: string;
}

/** Result of {@link runMiniwobTask}. */
export interface MiniwobTaskResult {
	goal: string;
	/** `1` if `reward > 0`, else `0` — matches BrowserGym's `validate` convention. */
	reward: number;
	/** Raw reward float from `task.validate(page)`. */
	rawReward: number;
	done: boolean;
	reason: string;
	/** Number of solver/validate round-trips executed. */
	steps: number;
	/** True if the done-poll timed out before `done` flipped. */
	timedOut: boolean;
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
const HOST_PKG_DIR = resolve(ADAPTER_DIR, "..");
const BRIDGE_SCRIPT = join(ADAPTER_DIR, "browsergym-bridge.py");

/** Default dedicated-venv Python interpreter path. */
const DEFAULT_VENV_PYTHON = join(HOST_PKG_DIR, "venv", "bin", "python3");

/**
 * Resolve the Python interpreter for the bridge subprocess.
 * Precedence: `PI_LEAN_HOST_VENV_PYTHON` env →
 * `packages/pi-lean-host/venv/bin/python3` default.
 */
function resolveVenvPython(): string {
	const p = process.env.PI_LEAN_HOST_VENV_PYTHON ?? DEFAULT_VENV_PYTHON;
	if (!existsSync(p)) {
		throw new Error(
			`BrowserGym venv Python not found at ${p}. ` +
				`Run: npm run setup:venv -w pi-lean-host`,
		);
	}
	return p;
}

// ─── JSON-RPC client for the bridge subprocess ────────────────────

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
			throw new Error(`BrowserGym bridge script not found: ${_bridgeScript}`);
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
							`BrowserGym bridge exited (code=${code})${
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
							`BrowserGym bridge ping failed: ${
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
			throw new Error("BrowserGym bridge is not running");
		}
		return new Promise<T>((resolveCall, rejectCall) => {
			const id = ++this._reqId;
			const timer = setTimeout(() => {
				this._pending.delete(id);
				this._kill();
				rejectCall(
					new Error(
						`BrowserGym bridge RPC timed out after ${timeoutMs}ms: ${method}`,
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
				rejectCall(new Error("BrowserGym bridge stdin closed"));
				return;
			}
			stdin.write(line);
		});
	}

	async stop(): Promise<void> {
		if (!this._proc) return;
		try {
			await this.call("shutdown", {}, 5_000).catch(() => {});
		} finally {
			this._kill();
		}
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
				const e = new Error(
					`${resp.error.message}${resp.error.data?.traceback ? `\n${resp.error.data.traceback}` : ""}`,
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
 *      (Launches the browser, populates `getCdpEndpoint()`.)
 *   2. Spawn the BrowserGym bridge, `miniwob.connect(cdpEndpoint)`.
 *   3. `miniwob.setup({ taskName, seed, baseUrl })` → goal.
 *   4. Take an `@e`-ref snapshot; hand it to the solver.
 *   5. Poll `miniwob.validate()` until `done` or `donePollTimeoutMs`.
 *   6. `miniwob.teardown()`, stop the bridge, return the result bag.
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

	// 2. Resolve CDP endpoint.
	//    Mode B override takes priority (set by benchPlugin's host-owns-browser path).
	//    Fall back to Mode A: plugin-owns-browser via getCdpEndpoint().
	let cdpEndpoint: string | null = opts._cdpEndpointOverride ?? null;
	if (!cdpEndpoint) {
		const getCdp = plugin.getCdpEndpoint;
		if (typeof getCdp !== "function") {
			await plugin.cleanup(taskId).catch(() => {});
			return fail(
				"plugin does not expose getCdpEndpoint() — Mode A unavailable. " +
					"Implement getCdpEndpoint on the plugin or use benchPlugin (Mode B).",
			);
		}
		cdpEndpoint = getCdp.call(plugin);
		if (!cdpEndpoint) {
			await plugin.cleanup(taskId).catch(() => {});
			return fail(
				"plugin.getCdpEndpoint() returned null — browser may not have launched " +
					"with a debug port, or port discovery failed (set CDP_PORT env as a fallback).",
			);
		}
	}

	// 3. Spawn the bridge + connect.
	let bridge: BridgeClient;
	try {
		bridge = new BridgeClient(resolveVenvPython(), BRIDGE_SCRIPT);
		await bridge.start();
	} catch (err) {
		await plugin.cleanup(taskId).catch(() => {});
		return fail(
			`bridge spawn failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		await bridge.call("miniwob.connect", { cdpEndpoint });

		// 4. Setup → goal.
		const setupRes = (await bridge.call("miniwob.setup", {
			taskName,
			seed,
			baseUrl,
			episodeMaxTimeMs,
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
				setupFailed: false,
				error: `solver raised: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// 6. Poll validate until done.
		const pollStart = Date.now();
		let steps = 0;
		let last = { reward: 0, done: false, reason: "" } as {
			reward: number;
			done: boolean;
			reason: string;
		};
		let timedOut = false;
		while (steps < maxSteps) {
			last = (await bridge.call("miniwob.validate", {})) as typeof last;
			steps++;
			if (last.done) break;
			if (Date.now() - pollStart > donePollTimeoutMs) {
				timedOut = true;
				break;
			}
			await sleep(donePollIntervalMs);
		}

		await bridge.call("miniwob.teardown", {}).catch(() => {});

		return {
			goal,
			reward: last.reward > 0 ? 1 : 0,
			rawReward: last.reward,
			done: last.done,
			reason: last.reason,
			steps,
			timedOut,
			setupFailed: false,
		};
	} catch (err) {
		return fail(
			`bridge RPC failed: ${err instanceof Error ? err.message : String(err)}`,
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
		setupFailed: true,
		error,
	};
}
