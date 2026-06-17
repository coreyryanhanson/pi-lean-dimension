/**
 * PythonPluginAdapter — TypeScript side of the Python bridge protocol.
 *
 * Implements `BrowserPlugin` by spawning a Python subprocess and
 * communicating via JSON-RPC 2.0 over stdin/stdout with newline-delimited
 * framing.
 *
 * Lifecycle
 * ---------
 * 1. Constructed with a plugin name and `PythonBridgeConfig`.
 * 2. `init()` validates paths — no spawn yet (lazy start).
 * 3. First operation triggers `ensureRunning()`, which spawns the Python
 *    process and waits for a `ping` handshake.
 * 4. Operations send JSON-RPC requests, the Python bridge handles them.
 * 5. `cleanupAll()` sends `shutdown`, waits for graceful exit, force-kills
 *    if unresponsive.
 * 6. Process crashes are detected and auto-restart on the next call.
 *
 * Thread safety: operations are serialised through the single stdin/stdout
 * channel.  The Python bridge processes one request at a time.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { sessionManager } from "../core/shared/session-manager.js";
import { saveStorageState } from "../core/shared/storage-state.js";

import type {
	BrowserPlugin,
	PluginCapabilities,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	ConsoleMessagesResult,
	EvaluateResult,
	Cookie,
	CookieResult,
	ClearCookiesOptions,
	StorageStateResult,
	ResultBase,
} from "../core/plugin-api.js";
import type { AriaCachedNode } from "../core/shared/accessibility-tree.js";

// ─── Constants ─────────────────────────────────────────────────────────

/** Default timeout for the JSON-RPC transport layer (milliseconds). */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 60_000;

/** Default timeout for the `ping` handshake on startup. */
const PING_TIMEOUT_MS = 10_000;

/** Default heartbeat interval in milliseconds (30s). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default max consecutive heartbeat misses before restart. */
const DEFAULT_HEARTBEAT_MISSES = 3;

/** Timeout for a single heartbeat ping. */
const HEARTBEAT_PING_TIMEOUT_MS = 5_000;

/** Grace period after sending `shutdown` before force-killing. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Standard JSON-RPC error codes that we recognise. */
const ERROR_CODES = {
	APPLICATION_ERROR: -32000,
	TIMEOUT_ERROR: -32001,
	SESSION_ERROR: -32002,
	HEARTBEAT_ERROR: -32003,
} as const;

// ─── Custom error ─────────────────────────────────────────────────────

/**
 * Error thrown when the Python bridge returns a JSON-RPC error response
 * or when a transport-level failure occurs.
 */
export class PythonBridgeError extends Error {
	/** JSON-RPC error code */
	readonly code: number;
	/** Python traceback string, if available */
	readonly traceback?: string;

	constructor(error: {
		code: number;
		message: string;
		data?: { traceback?: string };
	}) {
		super(error.message);
		this.name = "PythonBridgeError";
		this.code = error.code;

		if (error.data?.traceback) {
			this.traceback = error.data.traceback;
		}
	}
}

// ─── Configuration ────────────────────────────────────────────────────

/** Configuration for a PythonPluginAdapter instance. */
export interface PythonBridgeConfig {
	/** Absolute path to the Python bridge script (required). */
	bridgeScript: string;

	/** Python interpreter path (default: "python3"). */
	pythonPath?: string;

	/** Additional arguments to pass to the Python process. */
	pythonArgs?: string[];

	/**
	 * Advertised capabilities overrides.  Defaults to a Python-capable
	 * Chromium profile (everything except AbortSignal support).
	 */
	capabilities?: Partial<PluginCapabilities>;

	/**
	 * JSON-RPC transport timeout in milliseconds (default: 60 000).
	 * This is the wall-clock limit for waiting for a response from the
	 * bridge.  Operations that accept their own timeout (e.g. navigate)
	 * get `timeoutMs + 10s` as the transport timeout so the bridge has
	 * room to report the timeout itself.
	 */
	transportTimeoutMs?: number;

	/**
	 * Heartbeat interval in milliseconds (default: 30 000).
	 * Set to 0 to disable the heartbeat entirely.
	 * The adapter sends a `ping` at this interval and restarts the
	 * bridge process if `heartbeatMissesBeforeRestart` consecutive
	 * pings go unanswered.
	 */
	heartbeatIntervalMs?: number;

	/**
	 * Max consecutive heartbeat misses before restarting the bridge
	 * process (default: 3).  Ignored when heartbeat is disabled.
	 */
	heartbeatMissesBeforeRestart?: number;

	/**
	 * Override the verify-click occlusion fallback timeout in ms
	 * (default: 1500).  Passed to the bridge via environment variable.
	 */
	verifyClickTimeoutMs?: number;
}

// ─── Default capabilities ─────────────────────────────────────────────

/**
 * Default capabilities for a Python-based Chromium bridge.
 *
 * - Full-page screenshots: yes (Playwright supports it)
 * - Console capture: yes (page.on("console"))
 * - JavaScript evaluate: yes (page.evaluate)
 * - Bot detection: yes (heuristics via checkPage logic)
 * - Dialog auto-dismissal: yes (page.on("dialog"))
 * - AbortSignal: no (JSON-RPC transport doesn't support it natively)
 * - Engine: chromium
 */
const DEFAULT_PYTHON_CAPABILITIES: PluginCapabilities = {
	supportsFullPageScreenshot: true,
	supportsConsoleCapture: true,
	supportsJavaScriptEvaluate: true,
	supportsBotDetection: true,
	supportsDialogAutoDismissal: true,
	supportsAbortSignal: false,
	engine: "chromium",
};

// ─── Pending request type ─────────────────────────────────────────────

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ─── PythonPluginAdapter ──────────────────────────────────────────────

/**
 * Adapts a Python browser backend (running the `BrowserBridge` protocol)
 * to the TypeScript `BrowserPlugin` interface.
 */
export class PythonPluginAdapter implements BrowserPlugin {
	readonly name: string;
	readonly capabilities: PluginCapabilities;

	// ── Python subprocess ───────────────────────────────────────
	private _process: ChildProcess | null = null;
	private _exitCode: number | null = null; // null = still running

	// ── Config ─────────────────────────────────────────────────
	private readonly _pythonPath: string;
	private readonly _bridgeScript: string;
	private readonly _pythonArgs: readonly string[];
	private readonly _transportTimeoutMs: number;

	// ── Stderr capture ─────────────────────────────────────────
	private _stderrAccumulated = "";

	// ── Verify-click timeout (for occlusion fallback) ──────────
	private readonly _verifyClickTimeoutMs: number;

	// ── Heartbeat ───────────────────────────────────────────────
	private readonly _heartbeatIntervalMs: number;
	private readonly _maxHeartbeatMisses: number;
	private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private _heartbeatMisses = 0;

	// ── JSON-RPC state ─────────────────────────────────────────
	private _reqId = 0;
	private _pending = new Map<number, PendingRequest>();
	private _buffer = "";

	// ── Startup lock ───────────────────────────────────────────
	private _startupPromise: Promise<void> | null = null;
	private _started = false;

	/** Track whether we're inside a forced restart (to avoid infinite loops). */
	private _isRestarting = false;

	/**
	 * Local element caches per task, populated from bridge responses.
	 * Map: taskId → Map<ref, AriaCachedNode>
	 */
	private _elementCaches = new Map<string, Map<string, AriaCachedNode>>();

	/**
	 * Per-taskId page metadata.
	 * Used to track profile names for storage state save on cleanup.
	 */
	private _pages = new Map<
		string,
		{
			profileName?: string;
		}
	>();

	/**
	 * @param name  Unique plugin identifier (e.g. "chromium-py").
	 * @param config  Bridge configuration.
	 */
	constructor(name: string, config: PythonBridgeConfig) {
		this.name = name;

		// Validate bridge script exists
		if (!config.bridgeScript) {
			throw new Error(
				`PythonPluginAdapter('${name}'): bridgeScript is required`,
			);
		}
		if (!existsSync(config.bridgeScript)) {
			throw new Error(
				`PythonPluginAdapter('${name}'): bridge script not found: ${config.bridgeScript}`,
			);
		}

		this._bridgeScript = config.bridgeScript;
		this._pythonPath = config.pythonPath ?? "python3";
		this._pythonArgs = config.pythonArgs ?? [];
		this._transportTimeoutMs =
			config.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

		// Heartbeat config
		this._heartbeatIntervalMs =
			config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this._maxHeartbeatMisses =
			config.heartbeatMissesBeforeRestart ?? DEFAULT_HEARTBEAT_MISSES;

		// Verify-click timeout (passed to bridge via env var)
		this._verifyClickTimeoutMs = config.verifyClickTimeoutMs ?? 1500;

		// Merge capabilities
		this.capabilities = {
			...DEFAULT_PYTHON_CAPABILITIES,
			...config.capabilities,
		};
	}

	// ═════════════════════════════════════════════════════════════════
	//  Lifecycle hooks
	// ═════════════════════════════════════════════════════════════════

	/**
	 * Initialise the adapter.  Validates that the Python path and bridge
	 * script are available, but does NOT spawn the subprocess yet.
	 */
	async init(_config?: Record<string, unknown>): Promise<void> {
		// Validate pythonPath exists
		const pythonOk = this._checkPythonExists();
		if (!pythonOk) {
			console.warn(
				`[pi-browser] PythonPluginAdapter('${this.name}'): ` +
					`Python interpreter '${this._pythonPath}' not found in PATH. ` +
					`Will retry on first use.`,
			);
		}
	}

	/**
	 * Clean up ALL resources.  Closes all pages, then sends ``shutdown`` to the bridge.
	 */
	async cleanupAll(): Promise<void> {
		for (const taskId of [...this._pages.keys()]) {
			await this.cleanup(taskId).catch(() => {});
		}
		await this._stopProcess();
	}

	// ═════════════════════════════════════════════════════════════════
	//  Process management
	// ═════════════════════════════════════════════════════════════════

	/**
	 * Ensure the Python subprocess is running.
	 *
	 * If the process has exited or was never started, spawn a new one
	 * and perform a `ping` handshake.  Uses a lock to prevent concurrent
	 * starts.
	 */
	private async ensureRunning(): Promise<void> {
		// Fast path: process is alive
		if (this._process && this._exitCode === null) return;

		// Wait for an in-progress startup
		if (this._startupPromise) {
			await this._startupPromise;
			return;
		}

		this._startupPromise = this._startProcess();
		try {
			await this._startupPromise;
		} finally {
			this._startupPromise = null;
		}
	}

	/**
	 * Spawn the Python subprocess and perform a ping handshake.
	 */
	private _startProcess(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this._buffer = "";
			this._exitCode = null;
			this._pending.clear();
			this._started = false;
			this._stderrAccumulated = "";
			this._heartbeatMisses = 0;

			const proc = spawn(
				this._pythonPath,
				[this._bridgeScript, ...this._pythonArgs],
				{
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...process.env,
						PYTHONUNBUFFERED: "1",
						PY_BRIDGE_VERIFY_CLICK_TIMEOUT_MS: String(
							this._verifyClickTimeoutMs,
						),
					},
				},
			);

			this._process = proc;

			// ── stdout reader ────────────────────────────────
			const stdout = proc.stdout;
			if (stdout) {
				stdout.on("data", (chunk: Buffer) => {
					this._buffer += chunk.toString();
					this._flushBuffer();
				});

				stdout.on("end", () => {
					// Flush any remaining data in the buffer
					if (this._buffer.trim()) {
						this._flushBuffer();
					}
				});
			}

			// ── stderr capture (member variable for inclusion in all errors) ─
			const stderr = proc.stderr;
			if (stderr) {
				stderr.on("data", (chunk: Buffer) => {
					this._stderrAccumulated += chunk.toString();
				});
			}

			// ── process events ───────────────────────────────
			const onError = (err: Error) => {
				if (!this._started) {
					reject(
						new Error(
							`PythonPluginAdapter('${this.name}'): Failed to spawn process: ${err.message}`,
						),
					);
				}
			};

			const onExit = (code: number | null, _signal: string | null) => {
				this._exitCode = code;
				this._process = null;
				this._stopHeartbeat();

				// Mark all our sessions as crashed
				this._markSessionsCrashed();

				// Build stderr guidance for error messages
				const stderrSuffix = this._stderrAccumulated
					? `\nstderr:\n${this._stderrAccumulated}` +
						this._importErrorGuidance()
					: "";

				// Reject all pending requests
				const pendingSnapshot = new Map(this._pending);
				this._pending.clear();

				for (const [, pending] of pendingSnapshot) {
					clearTimeout(pending.timer);
					const reason = new PythonBridgeError({
						code: ERROR_CODES.APPLICATION_ERROR,
						message:
							`Python bridge exited unexpectedly ` +
							`(code: ${code}, signal: ${_signal}). ` +
							`Use browser-navigate to start a fresh session.` +
							stderrSuffix,
					});
					pending.reject(reason);
				}

				if (!this._started) {
					reject(
						new Error(
							`PythonPluginAdapter('${this.name}'): Process exited before handshake ` +
								`(code: ${code}, signal: ${_signal})` +
								stderrSuffix,
						),
					);
				}
			};

			proc.on("error", onError);
			proc.on("exit", onExit);

			// ── Ping handshake ─────────────────────────────
			// Wait a short tick for the process to initialise, then send ping.
			// The bridge must respond within PING_TIMEOUT_MS.
			// NOTE: uses _directRpcCall to avoid re-entering ensureRunning().
			setImmediate(async () => {
				try {
					await this._directRpcCall("ping", {}, PING_TIMEOUT_MS);
					this._started = true;
					this._startHeartbeat();
					resolve();
				} catch (err: unknown) {
					// If the process already exited, the exit handler will reject.
					// Only reject here if the process is still alive but ping failed.
					if (this._process && this._exitCode === null) {
						// Ping failed — kill and reject
						this._killProcess();
						reject(
							new Error(
								`PythonPluginAdapter('${this.name}'): Ping handshake failed: ` +
									(err instanceof Error ? err.message : String(err)),
							),
						);
					}
				}
			});
		});
	}

	/**
	 * Stop the Python subprocess gracefully, then force-kill if needed.
	 */
	private async _stopProcess(): Promise<void> {
		this._stopHeartbeat();

		const proc = this._process;
		if (!proc || proc.killed || this._exitCode !== null) {
			this._process = null;
			return;
		}

		// Try graceful shutdown via direct RPC (no ensureRunning —
		// we know the process is alive, and starting a new process
		// just to shut it down would be wasteful).
		try {
			await this._directRpcCall("shutdown", {}, SHUTDOWN_GRACE_MS);
		} catch {
			// Shutdown command failed — kill anyway
		}

		this._killProcess();
	}

	/**
	 * Force-kill the subprocess and clean up state.
	 */
	private _killProcess(): void {
		this._stopHeartbeat();

		// Clear all per-task tracking — the bridge
		// process is dead, so all Python-side state is lost.
		this._elementCaches.clear();
		this._pages.clear();

		const proc = this._process;
		if (!proc) return;

		try {
			// Remove listeners to prevent double-callbacks
			proc.removeAllListeners("exit");
			proc.removeAllListeners("error");

			if (!proc.killed && this._exitCode === null) {
				proc.kill("SIGTERM");
				// Give it a moment, then SIGKILL
				setTimeout(() => {
					try {
						if (!proc.killed && this._exitCode === null) {
							proc.kill("SIGKILL");
						}
					} catch {
						// Process may have already exited
					}
				}, 500).unref();
			}
		} catch {
			// May already have exited
		}

		// Reject any remaining pending requests
		const pendingSnapshot = new Map(this._pending);
		this._pending.clear();
		for (const [, pending] of pendingSnapshot) {
			clearTimeout(pending.timer);
			pending.reject(
				new PythonBridgeError({
					code: ERROR_CODES.APPLICATION_ERROR,
					message: "Python bridge was shut down",
				}),
			);
		}

		this._process = null;
		this._exitCode = 0; // Mark as dead
		this._buffer = "";
	}

	// ═════════════════════════════════════════════════════════════════
	//  Heartbeat
	// ═════════════════════════════════════════════════════════════════

	/**
	 * Start the heartbeat interval timer.
	 *
	 * Sends `ping` at the configured interval.  If a ping times out or
	 * returns an error, increments the miss counter.  If the miss counter
	 * reaches the threshold, the process is killed and restarted.
	 *
	 * Heartbeats are skipped if there are pending user requests (the bridge
	 * is busy), avoiding false-positive kills during long operations.
	 */
	private _startHeartbeat(): void {
		if (this._heartbeatIntervalMs <= 0) return; // Heartbeat disabled

		this._heartbeatMisses = 0;
		this._heartbeatTimer = setInterval(() => {
			void this._heartbeatTick();
		}, this._heartbeatIntervalMs);
		this._heartbeatTimer.unref();
	}

	/**
	 * Stop the heartbeat interval timer.
	 */
	private _stopHeartbeat(): void {
		if (this._heartbeatTimer !== null) {
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
		}
		this._heartbeatMisses = 0;
	}

	/**
	 * Execute a single heartbeat tick: send ping, check response.
	 */
	private async _heartbeatTick(): Promise<void> {
		// Skip if process is dead or already being restarted
		if (!this._process || this._exitCode !== null || this._isRestarting) {
			return;
		}

		// Skip if there's an in-flight user request (bridge is busy)
		if (this._pending.size > 0) {
			return;
		}

		try {
			await this._directRpcCall("ping", {}, HEARTBEAT_PING_TIMEOUT_MS);
			// Success — reset miss counter
			this._heartbeatMisses = 0;
		} catch {
			this._heartbeatMisses++;

			if (this._heartbeatMisses >= this._maxHeartbeatMisses) {
				this._isRestarting = true;
				const msg =
					`Python bridge heartbeat failed after ${this._heartbeatMisses} consecutive misses. ` +
					`Restarting the bridge process.`;
				console.warn(
					`[pi-browser] PythonPluginAdapter('${this.name}'): ${msg}`,
				);

				// Kill the stuck process — next call will auto-restart
				this._markSessionsCrashed();
				this._killProcess();

				// Reject any pending requests with heartbeat error
				const pendingSnapshot = new Map(this._pending);
				this._pending.clear();
				for (const [, pending] of pendingSnapshot) {
					clearTimeout(pending.timer);
					pending.reject(
						new PythonBridgeError({
							code: ERROR_CODES.HEARTBEAT_ERROR,
							message: msg,
						}),
					);
				}

				this._isRestarting = false;
			}
		}
	}

	/**
	 * No-op: the router handles session recovery via `lastNav`
	 * (bridge crashes → pending requests rejected → next adapter call
	 * restarts the bridge → next router call re-creates the session).
	 */
	private _markSessionsCrashed(): void {
		// Intentionally empty — see JSDoc above.
	}

	/**
	 * Generate pip install guidance if stderr contains import errors.
	 */
	private _importErrorGuidance(): string {
		const stderr = this._stderrAccumulated;
		if (!stderr) return "";

		const hints: string[] = [];

		if (/module\s*not\s*found|importerror|no\s*module\s*named/i.test(stderr)) {
			hints.push(
				"\n\nHint: A Python import failed. " +
					"Try installing dependencies:" +
					"\n  pip install playwright" +
					"\n  playwright install chromium",
			);
		}

		if (/playwright/i.test(stderr) && !/pip/.test(stderr)) {
			hints.push(
				"\n\nHint: Playwright may not be installed or configured. " +
					"Run:" +
					"\n  pip install playwright" +
					"\n  playwright install chromium",
			);
		}

		return hints.join("");
	}

	// ═════════════════════════════════════════════════════════════════
	//  JSON-RPC communication
	// ═════════════════════════════════════════════════════════════════

	/**
	 * Send a JSON-RPC request to the bridge and wait for the response.
	 *
	 * Ensures the bridge process is running before sending.
	 *
	 * @param method  JSON-RPC method name (e.g. "browser.navigate").
	 * @param params  Parameters object.
	 * @param timeoutMs  Transport-level timeout (milliseconds).  Defaults
	 *                   to `this._transportTimeoutMs`.
	 * @returns  The `result` field of the JSON-RPC response.
	 * @throws {PythonBridgeError}  On bridge error, timeout, or infrastructure failure.
	 */
	private async _rpcCall(
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<unknown> {
		await this.ensureRunning();
		return this._directRpcCall(method, params, timeoutMs);
	}

	/**
	 * Direct JSON-RPC call — does NOT call ensureRunning.
	 *
	 * Used internally for startup ping and shutdown, where the process
	 * lifecycle is managed by the caller and calling ensureRunning would
	 * create a circular dependency or wasteful re-spawn.
	 */
	private _directRpcCall(
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			const id = ++this._reqId;
			const request = {
				jsonrpc: "2.0" as const,
				method,
				params,
				id,
			};

			const transportTimeout = timeoutMs ?? this._transportTimeoutMs;

			const timer = setTimeout(() => {
				this._pending.delete(id);
				// The process is stuck — kill and restart
				this._killProcess();
				const stderrSuffix = this._stderrAccumulated
					? `\nstderr:\n${this._stderrAccumulated}` +
						this._importErrorGuidance()
					: "";
				reject(
					new PythonBridgeError({
						code: ERROR_CODES.TIMEOUT_ERROR,
						message:
							`Request timed out after ${transportTimeout}ms: ${method}` +
							stderrSuffix,
					}),
				);
			}, transportTimeout);

			this._pending.set(id, { resolve, reject, timer });

			try {
				const line = JSON.stringify(request) + "\n";
				const stdin = this._process?.stdin;
				if (!stdin || stdin.destroyed) {
					clearTimeout(timer);
					this._pending.delete(id);
					reject(
						new PythonBridgeError({
							code: ERROR_CODES.APPLICATION_ERROR,
							message: "Python bridge stdin is closed or unavailable",
						}),
					);
					return;
				}
				stdin.write(line);
			} catch (err: unknown) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(
					new PythonBridgeError({
						code: ERROR_CODES.APPLICATION_ERROR,
						message: `Failed to write to Python bridge stdin: ${err instanceof Error ? err.message : String(err)}`,
					}),
				);
			}
		});
	}

	/**
	 * Flush buffered stdout data and process complete lines.
	 */
	private _flushBuffer(): void {
		const lines = this._buffer.split("\n");
		// Keep the last (possibly incomplete) segment in the buffer
		this._buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue; // Skip empty lines (heartbeats)
			this._handleResponseLine(trimmed);
		}
	}

	/**
	 * Handle a single complete JSON-RPC response line from stdout.
	 */
	private _handleResponseLine(line: string): void {
		let response: {
			id?: unknown;
			result?: unknown;
			error?: { code: number; message: string; data?: { traceback?: string } };
		};

		try {
			response = JSON.parse(line);
		} catch {
			// Invalid JSON on the wire — this is a protocol violation.
			// Log and skip; if it's critical the transport timeout will fire.
			console.error(
				`[pi-browser] PythonPluginAdapter('${this.name}'): Invalid JSON from bridge: ${line.slice(0, 200)}`,
			);
			return;
		}

		// Notification (no id) — ignore
		if (response.id === undefined || response.id === null) return;

		const id =
			typeof response.id === "number" ? response.id : Number(response.id);
		const pending = this._pending.get(id);
		if (!pending) {
			// Response for an already-resolved/rejected request — stale
			return;
		}

		clearTimeout(pending.timer);
		this._pending.delete(id);

		if (response.error) {
			pending.reject(new PythonBridgeError(response.error));
		} else {
			pending.resolve(response.result);
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Navigation & state
	// ═════════════════════════════════════════════════════════════════

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number = 30_000,
		options?: {
			signal?: AbortSignal;
			storageState?: unknown;
			profileName?: string;
			profileMode?: "none" | "session" | "named";
		},
	): Promise<NavigateResult> {
		// We don't use the AbortSignal directly (supportsAbortSignal: false),
		// but we accept it for interface compatibility.

		try {
			// Build RPC params — include storageState and profileName if provided
			const rpcParams: Record<string, unknown> = { url, taskId, timeoutMs };
			if (options?.storageState !== undefined) {
				rpcParams.storageState = options.storageState;
			}
			if (options?.profileName !== undefined) {
				rpcParams.profileName = options.profileName;
				rpcParams.profileMode = options.profileMode ?? "named";
			}

			// Give the bridge slightly more time so navigation timeouts
			// are reported by the bridge, not the transport layer.
			const transportTimeout = timeoutMs + 10_000;
			const raw = await this._rpcCall(
				"browser.navigate",
				rpcParams,
				transportTimeout,
			);

			const result = raw as Record<string, unknown>;
			const success = !!result.success;

			// Track this task for cleanup
			const pageMeta: { profileName?: string } = {};
			if (options?.profileName) {
				pageMeta.profileName = options.profileName;
			}
			this._pages.set(taskId, pageMeta);

			// Update session manager
			if (success) {
				sessionManager.updateSession(taskId, {
					currentUrl: (result.url as string) ?? url,
					currentTitle: (result.title as string) ?? "",
					pluginName: this.name,
				});

				// Populate local element cache from bridge response
				this._populateElementCache(taskId, result.elements);
			}

			const navResult: NavigateResult = {
				success,
				url: (result.url as string) ?? url,
				title: (result.title as string) ?? "",
				snapshot: (result.snapshot as string) ?? "",
				elementCount: (result.elementCount as number) ?? 0,
			};
			if (result.botDetected) navResult.botDetected = true;
			if (result.error !== undefined) navResult.error = result.error as string;
			return navResult;
		} catch (err: unknown) {
			return {
				success: false,
				url,
				title: "",
				snapshot: "",
				elementCount: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async snapshot(taskId: string): Promise<SnapshotResult> {
		try {
			const raw = await this._rpcCall("browser.snapshot", { taskId });
			const result = raw as Record<string, unknown>;

			// Populate local element cache from bridge response
			this._populateElementCache(taskId, result.elements);

			const snapResult: SnapshotResult = {
				success: !!result.success,
				snapshot: (result.snapshot as string) ?? "",
				elementCount: (result.elementCount as number) ?? 0,
			};
			if (result.error !== undefined) snapResult.error = result.error as string;
			return snapResult;
		} catch (err: unknown) {
			return {
				success: false,
				snapshot: "",
				elementCount: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Interaction
	// ═════════════════════════════════════════════════════════════════

	async click(taskId: string, ref: string): Promise<InteractionResult> {
		try {
			const raw = await this._rpcCall("browser.click", { taskId, ref });
			return this._toInteractionResult(raw);
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async type(
		taskId: string,
		ref: string,
		text: string,
	): Promise<InteractionResult> {
		try {
			const raw = await this._rpcCall("browser.type", { taskId, ref, text });
			return this._toInteractionResult(raw);
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async scroll(
		taskId: string,
		direction: "up" | "down",
	): Promise<InteractionResult> {
		try {
			const raw = await this._rpcCall("browser.scroll", { taskId, direction });
			return this._toInteractionResult(raw);
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		try {
			const raw = await this._rpcCall("browser.goBack", { taskId });
			return this._toInteractionResult(raw);
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		try {
			const raw = await this._rpcCall("browser.press", { taskId, key });
			return this._toInteractionResult(raw);
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Media
	// ═════════════════════════════════════════════════════════════════

	async screenshot(
		taskId: string,
		options?: { fullPage?: boolean },
	): Promise<ScreenshotResult> {
		try {
			// If capabilities don't support fullPage, never pass it
			const fullPage =
				this.capabilities.supportsFullPageScreenshot &&
				options?.fullPage === true;

			const raw = await this._rpcCall("browser.screenshot", {
				taskId,
				fullPage,
			});
			const result = raw as Record<string, unknown>;

			const screenshotResult: ScreenshotResult = {
				success: !!result.success,
				dataUri: (result.dataUri as string) ?? "",
			};
			if (result.error !== undefined)
				screenshotResult.error = result.error as string;
			return screenshotResult;
		} catch (err: unknown) {
			return {
				success: false,
				dataUri: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Console & eval
	// ═════════════════════════════════════════════════════════════════

	async getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult> {
		try {
			const raw = await this._rpcCall("browser.getConsoleMessages", { taskId });
			const result = raw as Record<string, unknown>;

			const consoleResult: ConsoleMessagesResult = {
				success: !!result.success,
				messages: (result.messages as ConsoleMessagesResult["messages"]) ?? [],
			};
			if (result.error !== undefined)
				consoleResult.error = result.error as string;
			return consoleResult;
		} catch (err: unknown) {
			return {
				success: false,
				messages: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async clearConsole(taskId: string): Promise<void> {
		try {
			await this._rpcCall("browser.clearConsole", { taskId });
		} catch (err: unknown) {
			// clearConsole is best-effort; swallow the error
			console.error(
				`[pi-browser] PythonPluginAdapter('${this.name}'): clearConsole failed:`,
				err,
			);
		}
	}

	async evaluate(taskId: string, expression: string): Promise<EvaluateResult> {
		try {
			const raw = await this._rpcCall("browser.evaluate", {
				taskId,
				expression,
			});
			const result = raw as Record<string, unknown>;

			const evalResult: EvaluateResult = {
				success: !!result.success,
				result: result.result,
			};
			if (result.error !== undefined) evalResult.error = result.error as string;
			return evalResult;
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Cookies & storage state
	// ═════════════════════════════════════════════════════════════════

	async getCookies(taskId: string, urls?: string[]): Promise<CookieResult> {
		try {
			const raw = await this._rpcCall("browser.getCookies", {
				taskId,
				...(urls ? { urls } : {}),
			});
			const result = raw as Record<string, unknown>;
			return {
				success: !!result.success,
				cookies: (result.cookies as Cookie[]) ?? [],
				...(result.error !== undefined
					? { error: result.error as string }
					: {}),
			};
		} catch (err: unknown) {
			return {
				success: false,
				cookies: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async addCookies(taskId: string, cookies: Cookie[]): Promise<ResultBase> {
		try {
			const raw = await this._rpcCall("browser.addCookies", {
				taskId,
				cookies,
			});
			const result = raw as Record<string, unknown>;
			return {
				success: !!result.success,
				...(result.error !== undefined
					? { error: result.error as string }
					: {}),
			};
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async clearCookies(
		taskId: string,
		options?: ClearCookiesOptions,
	): Promise<ResultBase> {
		try {
			const raw = await this._rpcCall("browser.clearCookies", {
				taskId,
				...(options?.name ? { name: options.name } : {}),
				...(options?.domain ? { domain: options.domain } : {}),
				...(options?.path ? { path: options.path } : {}),
			});
			const result = raw as Record<string, unknown>;
			return {
				success: !!result.success,
				...(result.error !== undefined
					? { error: result.error as string }
					: {}),
			};
		} catch (err: unknown) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async getStorageState(taskId: string): Promise<StorageStateResult> {
		try {
			const raw = await this._rpcCall("browser.getStorageState", {
				taskId,
			});
			const result = raw as Record<string, unknown>;
			return {
				success: !!result.success,
				cookies: (result.cookies as StorageStateResult["cookies"]) ?? [],
				origins: (result.origins as StorageStateResult["origins"]) ?? [],
				...(result.error !== undefined
					? { error: result.error as string }
					: {}),
			};
		} catch (err: unknown) {
			return {
				success: false,
				cookies: [],
				origins: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Per-task cleanup
	// ═════════════════════════════════════════════════════════════════

	async cleanup(taskId: string): Promise<void> {
		const pageEntry = this._pages.get(taskId);
		if (!pageEntry) {
			this._elementCaches.delete(taskId);
			return;
		}

		// Auto-save storage state if session is persistent
		const session = sessionManager.getSession(taskId);
		if (session?.persistState) {
			try {
				const raw = await this._rpcCall("browser.getStorageState", {
					taskId,
				});
				const result = raw as Record<string, unknown>;
				if (result.success) {
					const name = session.profileName ?? "default";
					saveStorageState(name, {
						cookies: (result.cookies ?? []) as Record<string, unknown>[],
						origins: (result.origins ?? []) as Record<string, unknown>[],
					});
				}
			} catch (err) {
				console.warn(
					`[pi-browser] Failed to auto-save storage state for profile ` +
						`'${session.profileName ?? "default"}' via Python bridge: ` +
						`${err instanceof Error ? err.message : String(err)}. ` +
						"Session state may be lost.",
				);
			}
		}

		// Clean up local state and tell the bridge to close the context
		this._elementCaches.delete(taskId);
		this._pages.delete(taskId);

		try {
			await this._rpcCall("browser.cleanup", { taskId });
		} catch (err: unknown) {
			console.error(
				`[pi-browser] PythonPluginAdapter('${this.name}'): cleanup failed for task '${taskId}':`,
				err,
			);
		}
	}

	// ═════════════════════════════════════════════════════════════════
	//  Internal helpers
	// ═════════════════════════════════════════════════════════════════

	// ═════════════════════════════════════════════════════════════════
	//  BrowserPlugin: Element cache access
	// ═════════════════════════════════════════════════════════════════

	/**
	 * Return the local element cache for the given task.
	 * Returns null if no cache has been populated yet (navigate/snapshot
	 * has not been called, or the bridge doesn't support element caching).
	 */
	getElementCache(taskId: string): Map<string, AriaCachedNode> | null {
		return this._elementCaches.get(taskId) ?? null;
	}

	/**
	 * Populate the local element cache from a bridge response's `elements` dict.
	 * The dict format is { "e1": { role, name, props, depth, raw, occurrenceIndex, parentRef }, ... }
	 * If `elements` is not present (older bridge), the cache stays empty.
	 */
	private _populateElementCache(taskId: string, elements: unknown): void {
		if (!elements || typeof elements !== "object") return;

		const cache = new Map<string, AriaCachedNode>();

		for (const [ref, raw] of Object.entries(
			elements as Record<string, unknown>,
		)) {
			const node = raw as Record<string, unknown>;
			if (!node.role) continue;

			const cachedNode: AriaCachedNode = {
				ref,
				role: node.role as string,
				name: (node.name as string) ?? "",
				props: (node.props as string[]) ?? [],
				depth: (node.depth as number) ?? 0,
				raw: (node.raw as string) ?? "",
				occurrenceIndex: (node.occurrenceIndex as number) ?? 0,
				...(node.parentRef ? { parentRef: node.parentRef as string } : {}),
			};
			cache.set(ref, cachedNode);
		}

		if (cache.size > 0) {
			this._elementCaches.set(taskId, cache);
		} else {
			this._elementCaches.delete(taskId);
		}
	}

	// ═════════════════════════════════════════════════════════════════

	/**
	 * Check whether the configured Python interpreter exists in PATH.
	 */
	private _checkPythonExists(): boolean {
		try {
			const result = spawnSync(this._pythonPath, ["--version"], {
				stdio: "ignore",
				timeout: 5_000,
			});
			return result.status === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Convert a raw RPC result to an InteractionResult.
	 */
	private _toInteractionResult(raw: unknown): InteractionResult {
		const r = raw as Record<string, unknown>;
		const result: InteractionResult = {
			success: !!r.success,
		};
		if (r.newUrl != null) result.newUrl = r.newUrl as string;
		if (r.newTitle != null) result.newTitle = r.newTitle as string;
		if (r.snapshot != null) result.snapshot = r.snapshot as string;
		if (r.elementCount != null) result.elementCount = r.elementCount as number;
		if (r.error != null) result.error = r.error as string;
		return result;
	}
}
