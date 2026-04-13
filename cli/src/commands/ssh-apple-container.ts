import { createConnection } from "net";
import { existsSync } from "fs";

import type { AssistantEntry } from "../lib/assistant-config";

/**
 * Connect to an Apple Container assistant via its management socket.
 * Sends a JSON handshake then relays stdin/stdout in raw mode.
 */
export async function sshAppleContainer(entry: AssistantEntry): Promise<void> {
  const mgmtSocket = entry.mgmtSocket as string | undefined;
  if (!mgmtSocket) {
    console.error(
      `No management socket found for '${entry.assistantId}'.\n` +
        "The assistant may not have finished starting. Try again in a moment.",
    );
    process.exit(1);
  }

  if (!existsSync(mgmtSocket)) {
    console.error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped. Run 'vellum hatch' to start it.",
    );
    process.exit(1);
  }

  console.log(
    `🔗 Connecting to ${entry.assistantId} via apple container exec...\n`,
  );

  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const handshake =
    JSON.stringify({
      command: ["/bin/bash"],
      service: "vellum-assistant",
      cols,
      rows,
    }) + "\n";

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      // Send handshake as soon as connected.
      socket.write(handshake);
    });

    // 10s handshake timeout — matches SSH ConnectTimeout.
    const HANDSHAKE_TIMEOUT_MS = 10_000;
    let handshakeComplete = false;
    const handshakeChunks: Buffer[] = [];
    let handshakeLen = 0;

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (!handshakeComplete) {
        console.error(
          "Timed out waiting for handshake response from management socket.",
        );
        socket.destroy();
        process.exit(1);
      }
      // After handshake, no timeout — interactive session runs indefinitely.
    });

    socket.on("data", (data: Buffer) => {
      if (!handshakeComplete) {
        // Accumulate raw buffers until we find a newline (end of JSON response).
        handshakeChunks.push(data);
        handshakeLen += data.length;
        const accumulated = Buffer.concat(handshakeChunks, handshakeLen);
        const nlIndex = accumulated.indexOf(0x0a);
        if (nlIndex === -1) return; // Wait for more data.

        const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
        const remainder = accumulated.slice(nlIndex + 1);
        handshakeComplete = true;
        socket.setTimeout(0); // Disable timeout for interactive session.

        let response: { status: string; message?: string };
        try {
          response = JSON.parse(responseLine) as {
            status: string;
            message?: string;
          };
        } catch {
          console.error("Invalid handshake response from management socket.");
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

        // Handshake succeeded — enter raw mode and relay stdio.
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.pipe(socket);

        // Write any raw bytes that arrived after the handshake newline.
        if (remainder.length > 0) {
          process.stdout.write(remainder);
        }

        // From now on, relay socket data to stdout.
        return;
      }

      // Raw mode: relay container output to stdout.
      process.stdout.write(data);
    });

    socket.on("end", () => {
      cleanup();
      if (handshakeComplete) {
        resolve();
      } else {
        reject(
          new Error(
            "Management socket closed before handshake completed. " +
              "The assistant may be restarting.",
          ),
        );
      }
    });

    socket.on("error", (err) => {
      cleanup();
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("close", () => {
      cleanup();
      if (handshakeComplete) {
        resolve();
      } else {
        reject(
          new Error(
            "Management socket closed before handshake completed. " +
              "The assistant may be restarting.",
          ),
        );
      }
    });

    function cleanup(): void {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.unpipe(socket);
      process.stdin.pause();
    }
  });
}
