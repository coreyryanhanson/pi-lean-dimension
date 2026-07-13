import { PythonPluginAdapter } from "../backends/python-adapter.js";
import { runContractTests } from "./helpers/plugin-contract.js";
import { createPyBackendTestHarness } from "./helpers/create-py-backend-harness.js";

const { bridgeScript, pythonPath, describeIfAvailable } =
	createPyBackendTestHarness("chromium-py");

describeIfAvailable("Chromium-Py contract tests", () => {
	runContractTests(
		"chromium-py",
		() =>
			new PythonPluginAdapter("chromium-py", {
				bridgeScript,
				pythonPath,
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsJavaScriptEvaluate: true,
					engine: "chromium",
				},
			}),
		{ realBrowser: true, navigateTimeout: 30_000, navigationSettle: true },
	);
});
