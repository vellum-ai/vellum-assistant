import { expect, test } from "bun:test";

import { createWindowsHostProxyRuntime } from "./host-proxy-adapter";

test("creates a Windows runtime with only the committed portable executors", () => {
  const runtime = createWindowsHostProxyRuntime({
    acquireGuardianToken: async () => null,
    getSessionToken: () => null,
    getLockfile: () => ({ assistants: [], activeAssistant: null }),
    onLockfileChange: () => () => undefined,
    installPresenceMonitor: () => () => undefined,
    getClientId: () => "client-123",
    logger: console,
  });

  expect(Object.keys(runtime.executors).sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(runtime.sseClientHeaders()).toMatchObject({
    "X-Vellum-Client-Id": "client-123",
    "X-Vellum-Interface-Id": "windows",
  });
  expect(runtime.posterClientHeaders()).toEqual({
    "X-Vellum-Client-Id": "client-123",
  });
  expect(() => runtime.teardownExecutors?.()).not.toThrow();
});
