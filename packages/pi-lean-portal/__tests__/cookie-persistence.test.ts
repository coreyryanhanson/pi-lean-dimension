import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, beforeAll, afterAll } from "vitest";
import { ChromiumPlugin } from "../backends/chromium/index.js";
import { startCookiePersistenceServer } from "./helpers/test-server.js";
import { runPersistenceSuite } from "./helpers/persistence-suite.js";

const describeIfAvailable = (() => {
	try {
		return existsSync(chromium.executablePath()) ? describe : describe.skip;
	} catch {
		return describe.skip;
	}
})();

let serverUrl: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
	const s = await startCookiePersistenceServer();
	serverUrl = s.url;
	stopServer = s.stop;
});
afterAll(async () => {
	await stopServer();
});

runPersistenceSuite(describeIfAvailable, {
	name: "chromium",
	getServerUrl: () => serverUrl,
	createPlugin: async () => {
		const p = new ChromiumPlugin();
		await p.init({});
		return p;
	},
});
