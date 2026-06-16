import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as router from "./core/router.js";

import { cleanupFetchTempFiles } from "./core/fetch-backend.js";
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
import { removeAllSnapshotFiles } from "./core/shared/snapshot-cache.js";
import { isSessionProfile } from "./core/shared/storage-state.js";
import { listProfiles } from "./browser-profile.js";
import initBrowserToggle from "./browser-toggle.js";
import { cleanupInjectedGuides } from "./core/guides.js";
import {
	updateFooterStatus,
	getLastCtx,
	setLastCtx,
	deleteSessionKey,
} from "./tools/utils.js";

// ─── Tool definitions ────────────────────────────────────────────

import {
	browserNavigateTool,
	browserSnapshotTool,
	browserClickTool,
	browserTypeTool,
	browserScrollTool,
	browserScreenshotTool,
	browserGetImagesTool,
	browserBackTool,
	browserPressTool,
	browserConsoleTool,
	browserInspectTool,
	webFetchTool,
	webGuideTool,
	webLearnTool,
} from "./tools/index.js";

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
				if (s.profileName) msg += ` [profile: ${s.profileName}]`;
			}
		}

		// Profiles section
		const profiles = listProfiles();
		if (profiles.length > 0) {
			// Find which profile is currently active (if any)
			const activeProfile = active.find((s) => s.profileName)?.profileName;
			const lines = [`\nProfiles: ${profiles.length} on disk`];
			for (const p of profiles) {
				const current = p.name === activeProfile ? " ← active" : "";
				const badge = isSessionProfile(p.name) ? " 📋" : "";
				const label = isSessionProfile(p.name) ? "📋 session" : p.name;
				lines.push(`  ${label}  (${p.stateSize})${badge}${current}`);
			}
			lines.push("  /web profile list — detailed view");
			msg += lines.join("\n");
		} else {
			msg += `\nProfiles: none`;
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
	pi.registerTool(browserInspectTool);
	pi.registerTool(webGuideTool);
	pi.registerTool(webLearnTool);

	// --- Register commands ------------------------------------------
	pi.registerCommand("browser-status", browserStatusCommand);
	initBrowserToggle(pi);

	// --- Profile event listener for TUI status updates ------------
	router.onProfileEvent((event) => {
		// Update TUI status bar on any profile lifecycle event
		const lastCtx = getLastCtx();
		if (lastCtx) {
			updateFooterStatus(lastCtx);
		}

		// Debug logging when BROWSER_DEBUG is set
		if (process.env.BROWSER_DEBUG) {
			const parts = [`[browser] ${event.type}: task=${event.taskId}`];
			if (event.profileName) parts.push(`profile=${event.profileName}`);
			if (event.profileMode) parts.push(`mode=${event.profileMode}`);
			if (event.sharedRefCount !== undefined)
				parts.push(`refCount=${event.sharedRefCount}`);
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
			cleanupInjectedGuides(piSessionId);
		}

		// Clean up all registered plugins
		const ordered = pluginRegistry.getOrdered();
		for (const { plugin } of ordered) {
			await plugin.cleanupAll().catch(() => {});
		}

		await sessionManager.removeAll();
		removeAllSnapshotFiles();
		cleanupFetchTempFiles();
		try {
			ctx?.ui?.setStatus?.("browser", "");
		} catch {
			// ctx.ui may not be available during shutdown
		}
	});
}
