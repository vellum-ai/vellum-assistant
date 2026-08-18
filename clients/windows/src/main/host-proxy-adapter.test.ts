import { expect, test } from "bun:test";

import { createWindowsHostProxyRuntime } from "./host-proxy-adapter";

test("creates a Windows runtime with unavailable executors", () => {
  const runtime = createWindowsHostProxyRuntime({
    acquireGuardianToken: async () => null,
    getSessionToken: () => null,
    getLockfile: () => ({ assistants: [], activeAssistant: null }),
    onLockfileChange: () => () => undefined,
    installPresenceMonitor: () => () => undefined,
    getClientId: () => "client-123",
    logger: console,
  });

  expect(runtime.executors).toEqual({});
  expect(runtime.sseClientHeaders()).toMatchObject({
    "X-Vellum-Client-Id": "client-123",
    "X-Vellum-Interface-Id": "windows",
  });
  expect(runtime.posterClientHeaders()).toEqual({
    "X-Vellum-Client-Id": "client-123",
  });
});

test("exposes host_cu when the computer-use capability is installed", () => {
  // GIVEN computer-use executors contributed by the capability module
  const host_cu = {
    handleRequest: () => undefined,
    handleCancel: () => undefined,
  };
  const teardown = () => undefined;

  // WHEN the Windows host-proxy runtime is created with them
  const runtime = createWindowsHostProxyRuntime({
    acquireGuardianToken: async () => null,
    getSessionToken: () => null,
    getLockfile: () => ({ assistants: [], activeAssistant: null }),
    onLockfileChange: () => () => undefined,
    installPresenceMonitor: () => () => undefined,
    getClientId: () => "client-123",
    logger: console,
    computerUseExecutors: { host_cu, teardown },
  });

  // THEN the daemon sees host_cu and teardown is routed to the helper shutdown
  expect(runtime.executors).toEqual({ host_cu });
  expect(runtime.teardownExecutors).toBe(teardown);
});
