/**
 * Minimal fake assistant IPC server for tests.
 *
 * Listens on assistant.sock inside the given workspace dir and responds
 * to the "health" JSON-RPC call with { status: "ok" }. This satisfies
 * the gateway's waitForAssistant() poll so it starts immediately.
 *
 * Speaks the daemon's length-prefixed framing through the shared
 * reader/writer, because that is what the gateway client sends. A
 * newline-delimited fake never parses the request, so the gateway sits
 * behind its startup gate waiting on a health response that never arrives.
 */
import { createServer, type Server } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { IpcFrameReader, writeMessage } from "@vellumai/ipc-server-utils";

export function startFakeAssistantIpc(workspaceDir: string): Server {
  mkdirSync(workspaceDir, { recursive: true });
  const socketPath = join(workspaceDir, "assistant.sock");

  const server = createServer((conn) => {
    const reader = new IpcFrameReader((envelope) => {
      writeMessage(conn, { id: envelope.id, result: { status: "ok" } });
    });
    conn.on("data", (chunk) => {
      reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  });

  server.listen(socketPath);
  return server;
}
