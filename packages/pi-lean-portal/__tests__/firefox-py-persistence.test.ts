import { describe, beforeAll, afterAll } from "vitest";
import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { createPyBackendTestHarness } from "./helpers/create-py-backend-harness.js";
import { startCookiePersistenceServer } from "./helpers/test-server.js";
import { runPersistenceSuite } from "./helpers/persistence-suite.js";

const { bridgeScript, pythonPath, prerequisitesMet } =
	createPyBackendTestHarness("firefox-py", { engine: "firefox" });
let serverUrl: string, stopServer: () => Promise<void>;
beforeAll(async () => {
	const s = await startCookiePersistenceServer();
	serverUrl = s.url;
	stopServer = s.stop;
});
afterAll(async () => {
	await stopServer();
});
runPersistenceSuite(prerequisitesMet ? describe : describe.skip, {
	name: "firefox-py",
	getServerUrl: () => serverUrl,
	createPlugin: async () => {
		const p = new PythonPluginAdapter("firefox-py-persist", {
			bridgeScript,
			pythonPath,
		});
		await p.init();
		return p;
	},
});
