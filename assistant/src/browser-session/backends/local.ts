import type { BrowserBackend, CdpCommand, CdpResult } from "../types.js";

/**
 * Local backend for BrowserSessionManager. Wraps a caller-provided
 * `sendCdp` transport that drives a Playwright CDPSession against the
 * sacrificial-profile Chromium managed by `browserManager`. The factory
 * in `assistant/src/tools/browser/cdp-client/factory.ts` constructs one
 * per tool invocation using the per-conversation LocalCdpClient.
 */
export interface LocalBackendDeps {
  /** Sends a CDP command to a Playwright CDPSession and returns the CDP result. */
  sendCdp(command: CdpCommand, signal?: AbortSignal): Promise<CdpResult>;
  isAvailable(): boolean;
  dispose(): void;
}

export function createLocalBackend(deps: LocalBackendDeps): BrowserBackend {
  return {
    kind: "local",
    isAvailable: deps.isAvailable,
    send: deps.sendCdp,
    dispose: deps.dispose,
  };
}
