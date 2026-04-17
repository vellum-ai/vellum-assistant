import { createConnection } from "net";
import { existsSync } from "fs";

import type { AssistantEntry } from "./assistant-config";

/**
 * Execute a command inside an Apple Container assistant via the management
 * socket. Non-interactive: sends the command, streams stdout/stderr to the
 * terminal, and exits with the appropriate code.
 */
export async function execAppleContainer(
  entry: AssistantEntry,
  command: string[],
  service: string,
): Promise<void> {
  const mgmtSocket = entry.mgmtSocket as string | undefined;
  if (!mgmtSocket) {
    console.error(
      `No management socket found for '${entry.assistantId}'.\n` +
        "The assistant may not be running.",
    );
    process.exit(1);
  }

  if (!existsSync(mgmtSocket)) {
    console.error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped.",
    );
    process.exit(1);
  }

  const handshake =
    JSON.stringify({
      command,
      service,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
    }) + "\n";

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      socket.write(handshake);
    });

    const HANDSHAKE_TIMEOUT_MS = 10_000;
    let handshakeComplete = false;
    const handshakeChunks: Buffer[] = [];
    let handshakeLen = 0;

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (!handshakeComplete) {
        console.error("Timed out waiting for response from management socket.");
        socket.destroy();
        process.exit(1);
      }
    });

    socket.on("data", (data: Buffer) => {
      if (!handshakeComplete) {
        handshakeChunks.push(data);
        handshakeLen += data.length;
        const accumulated = Buffer.concat(handshakeChunks, handshakeLen);
        const nlIndex = accumulated.indexOf(0x0a);
        if (nlIndex === -1) return;

        const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
        const remainder = accumulated.slice(nlIndex + 1);
        handshakeComplete = true;
        socket.setTimeout(0);

        let response: { status: string; message?: string };
        try {
          response = JSON.parse(responseLine) as {
            status: string;
            message?: string;
          };
        } catch {
          console.error("Invalid response from management socket.");
          socket.destroy();
          process.exit(1);
          return;
        }

        if (response.status !== "ok") {
          console.error(`Exec failed: ${response.message || "unknown error"}`);
          socket.destroy();
          process.exit(1);
          return;
        }

        // Write any bytes that arrived after the handshake newline.
        if (remainder.length > 0) {
          process.stdout.write(remainder);
        }
        return;
      }

      // Stream command output to stdout.
      process.stdout.write(data);
    });

    socket.on("end", () => {
      if (handshakeComplete) {
        resolve();
      } else {
        reject(new Error("Connection closed before handshake completed."));
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("close", () => {
      if (handshakeComplete) {
        resolve();
      }
    });
  });
}
