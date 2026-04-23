/**
 * Shared test helper: mock gateway-client.js so tests can run without a
 * live gateway process.
 *
 * Instead of going over the IPC socket, `ipcClassifyRisk` delegates
 * directly to the gateway's `handleClassifyRisk` handler, which calls the
 * real risk classifiers in-process.
 */

import { handleClassifyRisk } from "../../../../gateway/src/ipc/risk-classification-handlers.js";

export function createGatewayClientMock() {
  return {
    ipcClassifyRisk: async (params: Record<string, unknown>) => {
      return handleClassifyRisk(params as any);
    },
    ipcCall: async () => undefined,
    ipcCallPersistent: async () => undefined,
    ipcGetFeatureFlags: async () => ({}),
    resetPersistentClient: () => {},
  };
}
