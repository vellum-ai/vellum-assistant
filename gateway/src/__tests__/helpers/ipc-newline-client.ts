/**
 * Shared newline-framed IPC client for `GatewayIpcServer` unit tests.
 *
 * The server speaks one JSON object per `\n`-terminated line over a UNIX
 * socket. `connectClient` opens a socket; `sendRequest` writes a request and
 * resolves with the first response line. Imports only node built-ins, so it is
 * free of import-time side effects and safe to static-import from any suite.
 */
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export function connectClient(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const client: Socket = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

export function sendRequest(
  client: Socket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{
  id: string;
  result?: unknown;
  error?: string;
  statusCode?: number;
  errorCode?: string;
}> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(4).toString("hex");
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        client.off("data", onData);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    client.on("data", onData);
    client.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
