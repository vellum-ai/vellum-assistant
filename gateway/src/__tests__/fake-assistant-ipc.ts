/**
 * Minimal fake assistant IPC server for tests.
 *
 * Listens on assistant.sock inside the given workspace dir and responds
 * to the "health" JSON-RPC call with { status: "ok" }. This satisfies
 * the gateway's waitForAssistant() poll so it starts immediately.
 */
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function startFakeAssistantIpc(workspaceDir: string): Server {
  mkdirSync(workspaceDir, { recursive: true });
  const socketPath = join(workspaceDir, "assistant.sock");

  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line) as { id: string; method: string };
          conn.write(
            JSON.stringify({ id: req.id, result: { status: "ok" } }) + "\n",
          );
        } catch {
          // ignore malformed
        }
      }
    });
  });

  server.listen(socketPath);
  return server;
}
