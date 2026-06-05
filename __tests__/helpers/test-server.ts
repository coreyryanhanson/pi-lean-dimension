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
