/**
 * Shared test helper: mock gateway-client.js so tests can run without a
 * live gateway process.
 *
 * Instead of going over the IPC socket, `ipcClassifyRisk` delegates
 * directly to the gateway's `handleClassifyRisk` handler, which calls the
 * real risk classifiers in-process.
 */

import { handleClassifyRisk } from "../../../../gateway/src/ipc/risk-classification-handlers.js";

interface GatewayClientMock {
  ipcClassifyRisk: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  ipcCall: () => Promise<undefined>;
  ipcCallPersistent: () => Promise<undefined>;
  ipcGetFeatureFlags: () => Promise<Record<string, boolean>>;
  resetPersistentClient: () => void;
}

export function createGatewayClientMock(): GatewayClientMock {
  return {
    ipcClassifyRisk: async (params: Record<string, unknown>) => {
      return handleClassifyRisk(
        params as Parameters<typeof handleClassifyRisk>[0],
      ) as unknown as Promise<Record<string, unknown>>;
    },
    ipcCall: async () => undefined,
    ipcCallPersistent: async () => undefined,
    ipcGetFeatureFlags: async () => ({}),
    resetPersistentClient: () => {},
  };
}
