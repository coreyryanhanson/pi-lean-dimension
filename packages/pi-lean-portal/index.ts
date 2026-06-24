import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as router from "./core/router.js";

import { cleanupFetchTempFiles } from "./core/fetch-backend.js";
import { pluginRegistry } from "./core/plugin-registry.js";
import {
	loadPluginConfig,
	detectPluginType,
	DEFAULT_BACKENDS_ROOT,
	invalidateConfigCache,
} from "./core/plugin-config.js";
import { ChromiumPlugin } from "./backends/chromium/index.js";
import { PythonPluginAdapter } from "./backends/python-adapter.js";
import type { PythonBridgeConfig } from "./backends/python-adapter.js";

import { sessionManager } from "./core/shared/session-manager.js";
import { removeAllSnapshotFiles } from "./core/shared/snapshot-cache.js";
import initBrowserToggle from "./browser-toggle.js";
import { updateFooterStatus, getLastCtx, setLastCtx } from "./tools/utils.js";
import { deleteSessionKey, resetTaskIds } from "./core/shared/task-id.js";
import { resetToggleModuleState } from "./browser-toggle.js";

// ─── Tool definitions ────────────────────────────────────────────

import {
	browserNavigateTool,
	browserSnapshotTool,
	browserClickTool,
	browserTypeTool,
	browserScrollTool,
	browserBackTool,
	browserPressTool,
	browserConsoleTool,
	browserInspectTool,
	webFetchTool,
	webGuideTool,
	webLearnTool,
} from "./tools/index.js";

// ============================================================
// Extension entry point
// ============================================================
export default function (pi: ExtensionAPI) {
	// --- Ensure idempotent re-invocation ----------------------------
	// pi reuses the cached extension factory on /resume (same cwd),
	// which re-invokes this function with the same module-level
	// singletons. Reset them here so the second load is safe.
	pluginRegistry.clear();
	invalidateConfigCache();
	resetTaskIds();
	resetToggleModuleState();

	// --- Plugin registration ----------------------------------------
	const { plugins: pluginConfigs, errors: configErrors } = loadPluginConfig();

	// Log config errors
	for (const err of configErrors) {
		console.warn(`[pi-lean-portal] Plugin config error: ${err}`);
	}

	// ── First pass: collect and validate all configs ──────────────
	// (synchronous — ensures config array order is captured before any async work)
	const validConfigs: Array<{
		config: (typeof pluginConfigs)[number];
		detection: import("./core/plugin-config.js").PluginDetection;
	}> = [];

	for (const config of pluginConfigs) {
		let detection;
		try {
			detection = detectPluginType(config.dir, DEFAULT_BACKENDS_ROOT);
		} catch (err) {
			console.error(
				`[pi-lean-portal] Plugin '${config.name}' (dir: '${config.dir}'): ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		validConfigs.push({ config, detection });
	}

	// ── Seed registry with config array order ────────────────────
	// This preserves the user's declared priority even when some
	// plugins load asynchronously (Node via dynamic import) while
	// others register synchronously (Python adapter).
	if (validConfigs.length > 0) {
		pluginRegistry.seedOrder(validConfigs.map(({ config }) => config.name));
	} else {
		// Fallback: no valid configs → register default Chromium plugin
		const plugin = new ChromiumPlugin();
		try {
			pluginRegistry.register(plugin, {
				name: "chromium",
				dir: "chromium",
				enabled: true,
				config: {},
			});
		} catch (err) {
			console.error(
				"[pi-lean-portal] Failed to register default Chromium plugin:",
				err,
			);
		}
		plugin.init({}).catch((err: unknown) => {
			console.error(
				"[pi-lean-portal] Failed to init default Chromium plugin:",
				err,
			);
		});
	}

	// ── Second pass: load and register plugins ───────────────────
	// Node plugins register asynchronously (after dynamic import resolves).
	// Python plugins register synchronously here.
	// The pre-seeded ordering ensures all plugins get the correct priority level
	// regardless of when register() is called.
	for (const { config, detection } of validConfigs) {
		if (detection.type === "node") {
			// Node-based backend — dynamically import the detected plugin
			(async () => {
				try {
					const mod: any = await import(detection.entryPoint);
					const PluginClass: new () => import("./core/plugin-api.js").BrowserPlugin =
						mod.default;
					if (!PluginClass || typeof PluginClass !== "function") {
						throw new Error(
							`Plugin '${config.name}' (${detection.entryPoint}) must export a default class implementing BrowserPlugin`,
						);
					}
					const plugin = new PluginClass();
					pluginRegistry.register(plugin, config);
					plugin.init?.(config.config).catch((err: unknown) => {
						console.error(
							`[pi-lean-portal] Failed to init plugin '${config.name}':`,
							err,
						);
					});
				} catch (err: unknown) {
					console.error(
						`[pi-lean-portal] Failed to load Node plugin '${config.name}' (dir: '${config.dir}'): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			})();
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
			try {
				pluginRegistry.register(adapter, config);
			} catch (err) {
				console.error(
					`[pi-lean-portal] Failed to register Python plugin '${config.name}':`,
					err,
				);
			}
			adapter.init(config.config).catch((err: unknown) => {
				console.error(
					`[pi-lean-portal] Failed to init Python plugin '${config.name}':`,
					err,
				);
			});
		} else {
			// Exhaustiveness guard — PluginType is currently "node" | "python"
			const _exhaustive: never = detection.type;
			console.warn(
				`[pi-lean-portal] Plugin '${config.name}' has unknown type '${_exhaustive as string}'.`,
			);
		}
	}

	// --- Register tools ---------------------------------------------
	pi.registerTool(webFetchTool);
	pi.registerTool(browserNavigateTool);
	pi.registerTool(browserSnapshotTool);
	pi.registerTool(browserClickTool);
	pi.registerTool(browserTypeTool);
	pi.registerTool(browserScrollTool);
	pi.registerTool(browserBackTool);
	pi.registerTool(browserPressTool);
	pi.registerTool(browserConsoleTool);
	pi.registerTool(browserInspectTool);
	pi.registerTool(webGuideTool);
	pi.registerTool(webLearnTool);

	// --- Register commands ------------------------------------------
	initBrowserToggle(pi);

	// --- Profile change callback for TUI status updates ------------
	router.setOnProfileChange((taskId, profileName, profileMode) => {
		// Update TUI status bar on any profile lifecycle event
		const lastCtx = getLastCtx();
		if (lastCtx) {
			updateFooterStatus(lastCtx);
		}

		// Debug logging when BROWSER_DEBUG is set
		if (process.env.BROWSER_DEBUG) {
			const parts = [`[browser] profile_changed: task=${taskId}`];
			if (profileName) parts.push(`profile=${profileName}`);
			if (profileMode) parts.push(`mode=${profileMode}`);
			console.error(parts.join(" "));
		}
	});

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
		setLastCtx(null);
		const piSessionId = (ctx as any)?.sessionManager?.getSessionId?.();
		if (piSessionId) {
			deleteSessionKey(piSessionId);
			// Per-conversation fetch cleanup — prevents cross-conversation eviction
			const tid = sessionManager.getTaskIdForPiSessionId(piSessionId);
			if (tid) cleanupFetchTempFiles(tid);
		}

		// Clean up all registered plugins
		const ordered = pluginRegistry.getOrdered();
		for (const { plugin } of ordered) {
			await plugin.cleanupAll().catch(() => {});
		}

		await sessionManager.removeAll();
		removeAllSnapshotFiles();
		try {
			ctx?.ui?.setStatus?.("browser", "");
		} catch {
			// ctx.ui may not be available during shutdown
		}
	});
}
