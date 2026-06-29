import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { APP_VERSION } from "../version.js";

/**
 * Broadcast the daemon's current version and signing-key fingerprint to all
 * connected clients. Clients use the fingerprint to detect instance switches.
 */
export function broadcastDaemonStatus(): void {
  broadcastMessage({
    type: "assistant_status",
    version: APP_VERSION,
    keyFingerprint: getSigningKeyFingerprint(),
  });
}
