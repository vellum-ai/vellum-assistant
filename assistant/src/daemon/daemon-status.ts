import { readFileSync } from "node:fs";
import { join } from "node:path";

import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";

function readPackageVersion(): string | undefined {
  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

const daemonVersion = readPackageVersion();

/**
 * Broadcast the daemon's current version and signing-key fingerprint to all
 * connected clients. Clients use the fingerprint to detect instance switches.
 */
export function broadcastDaemonStatus(): void {
  broadcastMessage({
    type: "assistant_status",
    version: daemonVersion,
    keyFingerprint: getSigningKeyFingerprint(),
  });
}
