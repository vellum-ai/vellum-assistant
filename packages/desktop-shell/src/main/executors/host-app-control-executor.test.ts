import { beforeEach, describe, expect, mock, test } from "bun:test";

// Avoid pulling electron (via shared-cu-helper → mac-helper-path) and the
// electron-log file backend into the test process.
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: { maxSize: 0, fileName: "", format: "", getFile: () => ({ path: "" }) },
      },
    },
  };
});
mock.module("../sidecar/shared-cu-helper", () => ({
  CU_HELPER_TIMEOUT_MS: 20_000,
  getSharedCuHelper: () => {
    throw new Error("shared helper should not be used in tests");
  },
}));

import { createHostAppControlExecutor } from "./host-app-control-executor";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePoster() {
  const postAppControlResult = mock(async (_payload: unknown) => true);
  return {
    poster: { postAppControlResult } as unknown as HostProxyPoster,
    postAppControlResult,
  };
}

function request(overrides: Partial<HostProxySseMessage> = {}): HostProxySseMessage {
  return {
    type: "host_app_control_request",
    requestId: "req-1",
    conversationId: "conv-1",
    toolName: "app_control_observe",
    input: { tool: "observe", app: "com.apple.Safari" },
    ...overrides,
  };
}

describe("hostAppControlExecutor", () => {
  let lastCall: { method: string; params: unknown } | null;

  beforeEach(() => {
    lastCall = null;
  });

  function helperReturning(result: unknown) {
    return {
      call: mock(async (method: string, params?: unknown) => {
        lastCall = { method, params };
        return result;
      }),
    };
  }

  test("forwards the request to appControl.perform and posts the result", async () => {
    const helper = helperReturning({
      state: "running",
      pngBase64: "PNG",
      windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      executionResult: "observed",
    });
    const executor = createHostAppControlExecutor({ helper });
    const { poster, postAppControlResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(lastCall?.method).toBe("appControl.perform");
    expect(lastCall?.params).toMatchObject({
      requestId: "req-1",
      toolName: "app_control_observe",
      input: { tool: "observe", app: "com.apple.Safari" },
    });
    expect(postAppControlResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      state: "running",
      pngBase64: "PNG",
      windowBounds: { x: 0, y: 0, width: 800, height: 600 },
    });
  });

  test("posts a missing-state error when input is absent", async () => {
    const helper = helperReturning({});
    const executor = createHostAppControlExecutor({ helper });
    const { poster, postAppControlResult } = makePoster();

    executor.handleRequest(request({ input: undefined }), poster);
    await tick();

    expect(helper.call).not.toHaveBeenCalled();
    expect(postAppControlResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      state: "missing",
      executionError: "Missing input",
    });
  });

  test("surfaces helper failures as a missing-state error", async () => {
    const helper = {
      call: mock(async () => {
        throw new Error("helper exploded");
      }),
    };
    const executor = createHostAppControlExecutor({ helper });
    const { poster, postAppControlResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(postAppControlResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      state: "missing",
      executionError: "helper exploded",
    });
  });

  test("drops the result when the request was cancelled", async () => {
    const helper = helperReturning({ state: "running" });
    const executor = createHostAppControlExecutor({ helper });
    const { poster, postAppControlResult } = makePoster();

    executor.handleRequest(request(), poster);
    executor.handleCancel(request(), poster);
    await tick();

    expect(postAppControlResult).not.toHaveBeenCalled();
  });
});
