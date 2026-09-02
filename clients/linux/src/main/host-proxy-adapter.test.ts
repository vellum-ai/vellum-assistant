import { expect, test } from "bun:test";

import { createLinuxHostProxyRuntime } from "./host-proxy-adapter";

test("creates a Linux runtime with only the committed portable executors", () => {
  const runtime = createLinuxHostProxyRuntime({
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
    "X-Vellum-Interface-Id": "linux",
  });
  expect(runtime.posterClientHeaders()).toEqual({
    "X-Vellum-Client-Id": "client-123",
  });
  expect(runtime.sseFallbackClientHeaders?.()).toMatchObject({
    "X-Vellum-Client-Id": "client-123",
    "X-Vellum-Interface-Id": "macos",
  });
  expect(() => runtime.teardownExecutors?.()).not.toThrow();
});

test("adds host_cu when the computer-use capability is installed", () => {
  const host_cu = {
    handleRequest: () => undefined,
    handleCancel: () => undefined,
  };
  let didTeardown = false;
  const teardown = () => {
    didTeardown = true;
  };

  const runtime = createLinuxHostProxyRuntime({
    acquireGuardianToken: async () => null,
    getSessionToken: () => null,
    getLockfile: () => ({ assistants: [], activeAssistant: null }),
    onLockfileChange: () => () => undefined,
    installPresenceMonitor: () => () => undefined,
    getClientId: () => "client-123",
    logger: console,
    computerUseExecutors: { host_cu, teardown },
  });

  expect(Object.keys(runtime.executors).sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_cu",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(runtime.executors.host_cu).toBe(host_cu);
  runtime.teardownExecutors?.();
  expect(didTeardown).toBe(true);
});
