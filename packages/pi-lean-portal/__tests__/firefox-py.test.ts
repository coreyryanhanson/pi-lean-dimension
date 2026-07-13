import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { runContractTests } from "./helpers/plugin-contract.js";
import { createPyBackendTestHarness } from "./helpers/create-py-backend-harness.js";

const { bridgeScript, pythonPath, describeIfAvailable } =
	createPyBackendTestHarness("firefox-py", { engine: "firefox" });

describeIfAvailable("Firefox-Py contract tests", () => {
	runContractTests(
		"firefox-py",
		() =>
			new PythonPluginAdapter("firefox-py", {
				bridgeScript,
				pythonPath,
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsJavaScriptEvaluate: true,
					engine: "firefox",
				},
			}),
		{ realBrowser: true, navigateTimeout: 30_000, navigationSettle: true },
	);
});
