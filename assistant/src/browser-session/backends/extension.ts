import type { BrowserBackend, CdpCommand, CdpResult } from "../types.js";

/**
 * Extension backend stub. Phase 2 Wave 2 will wire this to the runtime's
 * chrome-extension WebSocket connection registry. For now this is a pure
 * interface implementation so BrowserSessionManager and its tests can be
 * written without depending on runtime internals.
 */
export interface ExtensionBackendDeps {
  /** Sends a CDP command to an attached chrome extension and returns the CDP result. */
  sendCdp(command: CdpCommand, signal?: AbortSignal): Promise<CdpResult>;
  isAvailable(): boolean;
  dispose(): void;
}

export function createExtensionBackend(
  deps: ExtensionBackendDeps,
): BrowserBackend {
  return {
    kind: "extension",
    isAvailable: deps.isAvailable,
    send: deps.sendCdp,
    dispose: deps.dispose,
  };
}
