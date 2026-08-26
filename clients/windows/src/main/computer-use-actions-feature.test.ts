import { expect, mock, test } from "bun:test";

import type { HostProxyPoster } from "@vellumai/electron-desktop/host-proxy/poster";
import type { HostProxySseMessage } from "@vellumai/electron-desktop/host-proxy/sse";

// Keep electron-log's file backend out of the test process.
mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [],
}));

const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const {
  COMPUTER_USE_ACTION_EXECUTORS,
  createWindowsHostAppControlExecutor,
  createWindowsHostCuExecutor,
  default: computerUseActionsFeature,
  protectComputerUseCapture,
} = await import("./features/computer-use-actions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("provides the host_cu executor through the capability registry", () => {
  const registry = new DesktopCapabilityRegistry();
  computerUseActionsFeature.install(registry);
  const provided = registry.require(COMPUTER_USE_ACTION_EXECUTORS);
  expect(typeof provided.host_cu.handleRequest).toBe("function");
  expect(typeof provided.host_app_control.handleRequest).toBe("function");
  expect(typeof provided.teardown).toBe("function");
});

test("forwards app-control requests to appControl.perform and posts the result", async () => {
  let seen: { method: string; params: unknown } | null = null;
  const executor = createWindowsHostAppControlExecutor({
    helper: {
      call: async (method, params) => {
        seen = { method, params };
        return {
          state: "running",
          pngBase64: "PNG",
          windowBounds: { x: 0, y: 0, width: 800, height: 600 },
          executionResult: "observed",
        };
      },
    },
  });
  const postAppControlResult = mock(async (_payload: unknown) => true);

  executor.handleRequest(
    {
      type: "host_app_control_request",
      requestId: "req-ac-1",
      conversationId: "conv-1",
      toolName: "app_control_observe",
      input: { tool: "observe", app: "notepad" },
    } satisfies HostProxySseMessage,
    { postAppControlResult } as unknown as HostProxyPoster,
  );
  await tick();

  expect(seen).toMatchObject({
    method: "appControl.perform",
    params: {
      requestId: "req-ac-1",
      toolName: "app_control_observe",
      input: { tool: "observe", app: "notepad" },
    },
  });
  expect(postAppControlResult).toHaveBeenCalledWith({
    requestId: "req-ac-1",
    state: "running",
    pngBase64: "PNG",
    windowBounds: { x: 0, y: 0, width: 800, height: 600 },
    executionResult: "observed",
  });
});

test("reports app-control helper failures as a missing-state error", async () => {
  const executor = createWindowsHostAppControlExecutor({
    helper: {
      call: async () => {
        throw new Error("helper exploded");
      },
    },
  });
  const postAppControlResult = mock(async (_payload: unknown) => true);

  executor.handleRequest(
    {
      type: "host_app_control_request",
      requestId: "req-ac-2",
      toolName: "app_control_press",
      input: { tool: "press", app: "notepad", key: "a" },
    },
    { postAppControlResult } as unknown as HostProxyPoster,
  );
  await tick();

  expect(postAppControlResult).toHaveBeenCalledWith({
    requestId: "req-ac-2",
    state: "missing",
    executionError: "helper exploded",
  });
});

test("forwards cu requests to cu.perform and posts the result", async () => {
  let seen: { method: string; params: unknown } | null = null;
  const executor = createWindowsHostCuExecutor({
    helper: {
      call: async (method, params) => {
        seen = { method, params };
        return { executionResult: "clicked" };
      },
    },
  });
  const postCuResult = mock(async (_payload: unknown) => true);

  executor.handleRequest(
    {
      type: "host_cu_request",
      requestId: "req-1",
      conversationId: "conv-1",
      toolName: "computer_use_click",
      input: { x: 1, y: 2 },
      stepNumber: 3,
    } satisfies HostProxySseMessage,
    { postCuResult } as unknown as HostProxyPoster,
  );
  await tick();

  expect(seen).toMatchObject({
    method: "cu.perform",
    params: {
      requestId: "req-1",
      toolName: "computer_use_click",
      stepNumber: 3,
    },
  });
  expect(postCuResult).toHaveBeenCalledWith({
    requestId: "req-1",
    executionResult: "clicked",
  });
});

test("a cancel received before the helper responds drops the result", async () => {
  let release: (() => void) | undefined;
  const executor = createWindowsHostCuExecutor({
    helper: {
      call: () =>
        new Promise<unknown>(
          (resolve) => (release = () => resolve({ executionResult: "late" })),
        ),
    },
  });
  const postCuResult = mock(async (_payload: unknown) => true);
  const poster = { postCuResult } as unknown as HostProxyPoster;

  executor.handleRequest(
    {
      type: "host_cu_request",
      requestId: "req-3",
      toolName: "computer_use_wait",
      input: { duration_ms: 1 },
    },
    poster,
  );
  executor.handleCancel({ type: "host_cu_cancel", requestId: "req-3" }, poster);
  release?.();
  await tick();

  expect(postCuResult).not.toHaveBeenCalled();
});

test("excludes Vellum windows while the helper captures the screen", async () => {
  const states = [false, true];
  const windows = states.map((_, index) => ({
    isContentProtected: () => states[index],
    setContentProtection: (protectedState: boolean) => {
      states[index] = protectedState;
    },
  }));
  const helper = protectComputerUseCapture(
    {
      call: async () => {
        expect(states).toEqual([true, true]);
        return { screenshot: "jpeg" };
      },
    },
    () => windows,
  );

  await helper.call("cu.perform", {});

  expect(states).toEqual([false, true]);
});
