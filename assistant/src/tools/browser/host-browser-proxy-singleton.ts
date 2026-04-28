/**
 * Module-level singleton HostBrowserProxy wired to the ChromeExtensionRegistry.
 *
 * Instead of creating a per-conversation proxy and threading it through
 * ToolContext, callers use `getHostBrowserProxySingleton()` to obtain the
 * proxy. The proxy's sender routes through the ChromeExtensionRegistry,
 * which handles guardian-scoped connection lookup and WebSocket delivery.
 *
 * The proxy is lazily created on first access and disposed/recreated when
 * the extension connection state changes. Callers should treat the returned
 * reference as potentially short-lived — always call the getter rather than
 * caching the result.
 */

import { HostBrowserProxy } from "../../daemon/host-browser-proxy.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getChromeExtensionRegistry } from "../../runtime/chrome-extension-registry.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("host-browser-proxy-singleton");

let instance: HostBrowserProxy | null = null;

/**
 * Build the sender function that routes `host_browser_request` frames
 * through the ChromeExtensionRegistry. Registers pending interactions
 * with a direct proxy reference (no conversation object) so the
 * `host_browser_result` resolver can call `proxy.resolve()` directly.
 */
function createRegistrySender(): (msg: ServerMessage) => void {
  return (msg: ServerMessage): void => {
    const conn = getChromeExtensionRegistry().getAny();
    if (!conn) {
      throw new Error(
        "host_browser send failed: no active extension connection in registry",
      );
    }

    // Register the pending interaction so host_browser_result can resolve it.
    if (
      msg.type === "host_browser_request" &&
      "requestId" in msg &&
      typeof msg.requestId === "string"
    ) {
      pendingInteractions.register(msg.requestId, {
        conversation: null,
        conversationId: "host-browser-singleton",
        kind: "host_browser",
        hostBrowserProxy: instance ?? undefined,
      });
    }

    const ok = getChromeExtensionRegistry().send(conn.guardianId, msg);
    if (!ok) {
      // Clean up the pending interaction we just registered.
      if (
        msg.type === "host_browser_request" &&
        "requestId" in msg &&
        typeof msg.requestId === "string"
      ) {
        pendingInteractions.resolve(msg.requestId);
      }
      throw new Error(
        `host_browser send failed: extension connection for guardian ${conn.guardianId} went away`,
      );
    }
  };
}

/**
 * Return the singleton HostBrowserProxy if an extension connection is
 * available in the ChromeExtensionRegistry. Returns `undefined` when no
 * extension is connected.
 *
 * The proxy is lazily created and reused across calls. It routes
 * `host_browser_request` frames through the registry and registers
 * pending interactions with a direct proxy reference for result resolution.
 */
export function getHostBrowserProxySingleton(): HostBrowserProxy | undefined {
  const conn = getChromeExtensionRegistry().getAny();
  if (!conn) {
    // No extension connected — dispose any stale proxy.
    if (instance) {
      instance.dispose();
      instance = null;
    }
    return undefined;
  }

  if (!instance) {
    log.info("Creating singleton HostBrowserProxy wired to extension registry");
    const sender = createRegistrySender();
    instance = new HostBrowserProxy(sender, (requestId) => {
      pendingInteractions.resolve(requestId);
    });
    instance.updateSender(sender, true);
  }

  return instance;
}

/**
 * Dispose the singleton proxy. Called during graceful shutdown or when
 * the extension connection is known to be permanently gone.
 */
export function disposeHostBrowserProxySingleton(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}

/**
 * Test helper: reset the singleton so each test starts fresh.
 */
export function __resetHostBrowserProxySingletonForTests(): void {
  instance = null;
}
