/**
 * Tool definitions barrel — exports all 13 tool definitions for registration.
 *
 * Each tool is defined in its own file under tools/ for maintainability.
 * This barrel collects them for import by index.ts.
 */

export { browserNavigateTool } from "./browser-navigate.js";
export { browserSnapshotTool } from "./browser-snapshot.js";
export { browserClickTool } from "./browser-click.js";
export { browserTypeTool } from "./browser-type.js";
export { browserScrollTool } from "./browser-scroll.js";
export { browserGetImagesTool } from "./browser-get-images.js";
export { browserBackTool } from "./browser-back.js";
export { browserPressTool } from "./browser-press.js";
export { browserConsoleTool } from "./browser-console.js";
export { browserInspectTool } from "./browser-inspect.js";
export { webFetchTool } from "./web-fetch.js";
export { webGuideTool } from "./web-guide.js";
export { webLearnTool } from "./web-learn.js";
