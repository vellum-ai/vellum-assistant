import type { BrowserBackend, CdpCommand, CdpResult } from "../types.js";

/**
 * cdp-inspect backend for BrowserSessionManager. Wraps a
 * caller-provided `sendCdp` transport that talks to an already-running
 * Chrome via DevTools JSON discovery + a raw WebSocket transport
 * (see `assistant/src/tools/browser/cdp-client/cdp-inspect-client.ts`).
 *
 * The factory in
 * `assistant/src/tools/browser/cdp-client/factory.ts` constructs
 * one per tool invocation, paralleling the existing extension
 * and local backend wiring.
 */
export interface CdpInspectBackendDeps {
  /** Sends a CDP command to the user's Chrome via cdp-inspect and returns the CDP result. */
  sendCdp(command: CdpCommand, signal?: AbortSignal): Promise<CdpResult>;
  isAvailable(): boolean;
  dispose(): void;
}

export function createCdpInspectBackend(
  deps: CdpInspectBackendDeps,
): BrowserBackend {
  return {
    kind: "cdp-inspect",
    isAvailable: deps.isAvailable,
    send: deps.sendCdp,
    dispose: deps.dispose,
  };
}
