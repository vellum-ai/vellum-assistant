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

import { createHostCuExecutor } from "./host-cu-executor";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePoster() {
  const postCuResult = mock(async (_payload: unknown) => true);
  return { poster: { postCuResult } as unknown as HostProxyPoster, postCuResult };
}

function request(overrides: Partial<HostProxySseMessage> = {}): HostProxySseMessage {
  return {
    type: "host_cu_request",
    requestId: "req-1",
    conversationId: "conv-1",
    toolName: "computer_use_click",
    input: { element_id: 3, reasoning: "click it" },
    stepNumber: 2,
    reasoning: "click it",
    ...overrides,
  };
}

describe("hostCuExecutor", () => {
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

  test("forwards the request to cu.perform and posts the observation", async () => {
    const helper = helperReturning({
      axTree: "Window: x",
      axDiff: "+ Added: [4] button",
      screenshot: "BASE64",
      screenshotWidthPx: 960,
      screenshotHeightPx: 540,
      screenWidthPt: 1512,
      screenHeightPt: 982,
      executionResult: "clicked",
    });
    const executor = createHostCuExecutor({ helper });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(lastCall?.method).toBe("cu.perform");
    expect(lastCall?.params).toMatchObject({
      requestId: "req-1",
      conversationId: "conv-1",
      toolName: "computer_use_click",
      stepNumber: 2,
      reasoning: "click it",
    });
    expect(postCuResult).toHaveBeenCalledTimes(1);
    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      axTree: "Window: x",
      screenshot: "BASE64",
      screenshotWidthPx: 960,
      executionResult: "clicked",
    });
  });

  test("posts an error when toolName is missing", async () => {
    const helper = helperReturning({});
    const executor = createHostCuExecutor({ helper });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(request({ toolName: undefined }), poster);
    await tick();

    expect(helper.call).not.toHaveBeenCalled();
    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      executionError: "Missing toolName",
    });
  });

  test("surfaces helper failures as executionError", async () => {
    const helper = {
      call: mock(async () => {
        throw new Error("helper exploded");
      }),
    };
    const executor = createHostCuExecutor({ helper });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      executionError: "helper exploded",
    });
  });

  test("drops the result when the request was cancelled", async () => {
    const helper = helperReturning({ executionResult: "done" });
    const executor = createHostCuExecutor({ helper });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(request(), poster);
    executor.handleCancel(request(), poster);
    await tick();

    expect(postCuResult).not.toHaveBeenCalled();
  });
});
