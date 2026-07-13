import { describe, beforeAll, afterAll } from "vitest";
import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { createPyBackendTestHarness } from "./helpers/create-py-backend-harness.js";
import { startCookiePersistenceServer } from "./helpers/test-server.js";
import { runPersistenceSuite } from "./helpers/persistence-suite.js";

const { bridgeScript, pythonPath, prerequisitesMet } =
	createPyBackendTestHarness("chromium-py");
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
	name: "chromium-py",
	getServerUrl: () => serverUrl,
	createPlugin: async () => {
		const p = new PythonPluginAdapter("chromium-py-persist", {
			bridgeScript,
			pythonPath,
		});
		await p.init();
		return p;
	},
});
