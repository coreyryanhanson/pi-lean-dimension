import {
	createServer,
	type Server,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

export interface TestServer {
	server: Server;
	url: string;
	stop(): Promise<void>;
}

/** Shared HTML fixture for cookie persistence tests. */
export const COOKIE_PERSISTENCE_HTML = `<!DOCTYPE html>
<html><head><title>Cookie Persistence Test</title></head>
<body>
  <div id="consent-banner" role="dialog" aria-label="Data Protection Consent">
    <h2>Data Protection Consent</h2>
    <p>We use cookies to improve your experience.</p>
    <button id="accept-btn"
      onclick="document.cookie='consent=accepted;path=/;max-age=86400';
               document.getElementById('consent-banner').style.display='none'">
      Accept All
    </button>
  </div>
  <h1>Page Content</h1>
  <p>Cookie status: <span id="cookie-status">none</span></p>
  <script>
    if (document.cookie.includes('consent=accepted')) {
      document.getElementById('consent-banner').style.display = 'none';
      document.getElementById('cookie-status').textContent = 'accepted';
    }
  </script>
</body></html>`;

export async function startTestServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
	const server = createServer(handler);
	return new Promise((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (typeof addr === "object" && addr !== null) {
				resolve({
					server,
					url: `http://127.0.0.1:${addr.port}`,
					stop: (): Promise<void> =>
						new Promise<void>((res, rej) =>
							server.close((_err: unknown) =>
								_err ? rej(_err as Error) : res(),
							),
						),
				});
			} else {
				reject(new Error("Could not determine server address"));
			}
		});
		server.on("error", reject);
	});
}
