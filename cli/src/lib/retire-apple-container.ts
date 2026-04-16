import { createConnection } from "net";
import { existsSync } from "fs";

import type { AssistantEntry } from "./assistant-config.js";

/**
 * Retire an Apple Container assistant by sending a retire command to the
 * macOS app via the management socket. The app handles the full lifecycle:
 * stop the pod, archive the instance directory, remove the guardian token,
 * deregister from the platform, and remove the lockfile entry.
 */
export async function retireAppleContainer(
  name: string,
  entry: AssistantEntry,
): Promise<void> {
  console.log(`\u{1F5D1}\ufe0f  Retiring Apple Container assistant '${name}'...\n`);

  const mgmtSocket = entry.mgmtSocket as string | undefined;
  if (!mgmtSocket) {
    console.error(
      `No management socket found for '${name}'.\n` +
        "The assistant may not be running. If the macOS app is closed, " +
        "open it and try again.",
    );
    process.exit(1);
  }

  if (!existsSync(mgmtSocket)) {
    console.error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped. Open the macOS app and try again.",
    );
    process.exit(1);
  }

  const handshake = JSON.stringify({ action: "retire" }) + "\n";

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      socket.write(handshake);
    });

    const TIMEOUT_MS = 30_000;
    const chunks: Buffer[] = [];
    let totalLen = 0;

    socket.setTimeout(TIMEOUT_MS);
    socket.on("timeout", () => {
      console.error("Timed out waiting for retire response from the macOS app.");
      socket.destroy();
      process.exit(1);
    });

    socket.on("data", (data: Buffer) => {
      chunks.push(data);
      totalLen += data.length;
      const accumulated = Buffer.concat(chunks, totalLen);
      const nlIndex = accumulated.indexOf(0x0a);
      if (nlIndex === -1) return;

      const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
      socket.destroy();

      let response: { status: string; message?: string };
      try {
        response = JSON.parse(responseLine) as {
          status: string;
          message?: string;
        };
      } catch {
        reject(new Error("Invalid response from management socket."));
        return;
      }

      if (response.status === "ok") {
        console.log(`\u2705 Apple Container assistant '${name}' retired.`);
        resolve();
      } else {
        reject(
          new Error(
            `Retire failed: ${response.message || "unknown error"}`,
          ),
        );
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("end", () => {
      if (chunks.length === 0) {
        reject(
          new Error(
            "Management socket closed without responding. " +
              "The macOS app may have crashed during retire.",
          ),
        );
      }
    });
  });
}
