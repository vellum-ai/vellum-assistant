import type { BrowserBackend, CdpCommand, CdpResult } from "../types.js";

/**
 * Host-bridge backend for BrowserSessionManager. Wraps a caller-provided
 * `sendCdp` transport that routes raw CDP commands through the daemon's
 * HostBrowserProxy to the desktop client's SSE bridge, which executes
 * them against the user's Chrome via its local remote-debugging port.
 * Unlike the extension backend, the bridge has no `Vellum.*`
 * pseudo-method support. The factory in
 * `assistant/src/tools/browser/cdp-client/factory.ts` constructs one
 * per tool invocation.
 */
export interface HostBridgeBackendDeps {
  /** Sends a raw CDP command via the desktop SSE bridge and returns the CDP result. */
  sendCdp(command: CdpCommand, signal?: AbortSignal): Promise<CdpResult>;
  isAvailable(): boolean;
  dispose(): void;
}

export function createHostBridgeBackend(
  deps: HostBridgeBackendDeps,
): BrowserBackend {
  return {
    kind: "host-bridge",
    isAvailable: deps.isAvailable,
    send: deps.sendCdp,
    dispose: deps.dispose,
  };
}
