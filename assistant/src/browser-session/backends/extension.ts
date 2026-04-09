import type { BrowserBackend, CdpCommand, CdpResult } from "../types.js";

/**
 * Extension backend for BrowserSessionManager. Wraps a caller-provided
 * `sendCdp` transport that routes CDP commands through the daemon's
 * HostBrowserProxy to an attached chrome extension. The factory in
 * `assistant/src/tools/browser/cdp-client/factory.ts` constructs one
 * per tool invocation using the conversation's `hostBrowserProxy`.
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
