/**
 * Lightweight HTTP static-file server for MiniWoB++ HTML content.
 *
 * Serves the cloned `miniwob-plusplus/miniwob/html/` directory over
 * HTTP so the MiniWoB driver and BrowserPlugin can navigate task
 * pages. Replaces the old `startMiniwobServer` from
 * `pi-lean-portal/__tests__/helpers/miniwob.ts` (deleted in Batch C).
 *
 * Usage in test files:
 * ```ts
 * import { startMiniwobServer } from "../scripts/miniwob-server.js";
 *
 * let server: TestServer;
 * beforeAll(async () => { server = await startMiniwobServer(); });
 * afterAll(async () => { if (server) await server.stop().catch(() => {}); });
 * ```
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
	startTestServer,
	type TestServer,
} from "../../../packages/pi-lean-portal/__tests__/helpers/test-server.js";

// ─── MIME types ───────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

// ─── Server ───────────────────────────────────────────────────────

/**
 * Start an HTTP server serving the MiniWoB++ html root.
 *
 * The returned `url` points at the html root, so a task's HTML lives
 * at `${url}/miniwob/<subdomain>.html` (mirroring the spike's layout
 * where `miniwob/` holds per-task files and `core/`, `common/` hold
 * shared resources).
 *
 * @param htmlRoot Absolute path to the cloned `miniwob-plusplus/miniwob/html/`
 *                  directory. Defaults to `MINIWOB_HTML_ROOT` env or
 *                  `/tmp/miniwob-plusplus/miniwob/html`.
 * @throws if `htmlRoot` does not exist.
 */
export async function startMiniwobServer(
	htmlRoot: string = process.env.MINIWOB_HTML_ROOT ??
		"/tmp/miniwob-plusplus/miniwob/html",
): Promise<TestServer> {
	const root = resolve(htmlRoot);
	if (!existsSync(root)) {
		throw new Error(
			`MiniWoB html root not found: ${root}. Clone miniwob-plusplus@7fd85d71 ` +
				`by running: npm run setup:miniwob`,
		);
	}

	return startTestServer((req: IncomingMessage, res: ServerResponse) => {
		void serveStatic(root, req, res);
	});
}

// ─── Static file handler ──────────────────────────────────────────

/** Static file request handler with path-traversal guard. */
async function serveStatic(
	root: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const parsed = new URL(req.url ?? "/", "http://localhost");
	const decoded = decodeURIComponent(parsed.pathname);
	// Normalize and ensure the resolved path stays under root.
	const target = normalize(join(root, decoded));
	const rel = relative(root, target);
	if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
		res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("403 Forbidden");
		return;
	}

	try {
		const data = await readFile(target);
		const mime =
			MIME_BY_EXT[extname(target).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, { "Content-Type": mime });
		res.end(data);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("404 Not Found");
	}
}
