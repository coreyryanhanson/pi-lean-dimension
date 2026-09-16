import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as router from "./core/router.js";

import { cleanupFetchTempFiles } from "./core/fetch-backend.js";
import { pluginRegistry } from "./core/plugin-registry.js";
import {
	loadFullConfig,
	DEFAULT_BACKEND_ROOTS,
	invalidateConfigCache,
} from "./core/plugin-config.js";
import { ChromiumPlugin } from "./backends/chromium/index.js";
import { PythonPluginAdapter } from "./backends/python-adapter.js";
import type { PythonBridgeConfig } from "./backends/python-adapter.js";

import { sessionManager } from "./core/shared/session-manager.js";
import { removeAllSnapshotFiles } from "./core/shared/snapshot-cache.js";
import initBrowserToggle from "./browser-toggle.js";
import { updateFooterStatus, setLastCtx } from "./tools/utils.js";
import { deleteSessionKey, resetTaskIds } from "./core/shared/task-id.js";
import { resetToggleModuleState } from "./browser-toggle.js";
import { registerGuideProvider } from "./core/guides.js";

// ─── Tool definitions ────────────────────────────────────────────

import {
	browserNavigateTool,
	strategyDescription,
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
	// Resolve plugin `dir` values against the shipped backends root first,
	// then the user-writable `~/.pi/agent/pi-lean-portal/user-backends/`
	// tree.  An absolute `dir` short-circuits both roots.
	// Configs come pre-validated with resolved entry points from
	// parsePluginConfig (detectPluginType runs once per plugin, there).
	const { plugins: validConfigs, errors: configErrors } = loadFullConfig(
		DEFAULT_BACKEND_ROOTS,
	).plugins;

	// Log config errors
	for (const err of configErrors) {
		console.warn(`[pi-lean-portal] Plugin config error: ${err}`);
	}

	// ── Seed registry with config array order ────────────────────
	// This preserves the user's declared priority even when some
	// plugins load asynchronously (Node via dynamic import) while
	// others register synchronously (Python adapter).
	if (validConfigs.length > 0) {
		pluginRegistry.seedOrder(validConfigs.map((c) => c.name));
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
	// The pre-seeded ordering ensures all plugins keep their configured
	// position regardless of when register() is called.
	for (const { detection, ...config } of validConfigs) {
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
				if (userConfig.pythonPath) bridgeConfig.pythonPath = userConfig.pythonPath;
				if (userConfig.pythonArgs) bridgeConfig.pythonArgs = userConfig.pythonArgs;
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
	// Patch the browser-navigate strategy description with the actually
	// configured plugin names so the agent doesn't second-guess which
	// strategies exist (matches what /web status reports). Wording lives in
	// strategyDescription() next to the tool; index.ts only supplies the data.
	const strategyPlugins =
		validConfigs.length > 0
			? validConfigs.map(({ name, enabled }) => ({ name, enabled }))
			: [{ name: "chromium", enabled: true }]; // fallback path
	const enabledNames: string[] = [];
	const disabledNames: string[] = [];
	for (const { name, enabled } of strategyPlugins)
		(enabled ? enabledNames : disabledNames).push(name);
	// SAFETY: defineTool's return type doesn't expose the TypeBox schema as
	// mutable, but `parameters` is the live Type.Object literal whose
	// properties.strategy.description exists at runtime; patching it before
	// registerTool is the whole point (see strategyDescription).
	(
		browserNavigateTool as unknown as {
			parameters: { properties: { strategy: { description: string } } };
		}
	).parameters.properties.strategy.description = strategyDescription(
		enabledNames,
		disabledNames,
	);

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

	// --- Expose guide-provider registry for peer packages ----------
	(globalThis as Record<string, unknown>)[
		"__piLeanPortalRegisterGuideProvider"
	] = registerGuideProvider;

	// --- Register commands ------------------------------------------
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

	// Sync the status-bar glyph after /tree navigation. browser-toggle's
	// session_tree handler restores the toggle state + active tools first
	// (registered earlier, runs first); this repaints the glyph to match.
	pi.on("session_tree", async (_event, ctx) => {
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
		for (const plugin of ordered) {
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
