import { createServer, type IncomingMessage } from "node:http";

export async function withHttpServer<T>(
  respond: (request: IncomingMessage) => Response,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(async (request, response) => {
    request.resume();
    try {
      const result = respond(request);
      const body = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }
}
