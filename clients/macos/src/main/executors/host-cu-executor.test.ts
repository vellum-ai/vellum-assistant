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
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
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

// What draws the marks, handed to the executor the way the app hands it the
// real one. Only the answer matters here: whether the marks stood.
let marksStand = true;
const showCoachmarks = mock((_marks: readonly unknown[]) => marksStand);

import { createHostCuExecutor, POINT_AT_TOOL } from "./host-cu-executor";
import type { HostProxyPoster } from "@vellumai/electron-desktop/host-proxy/poster";
import type { HostProxySseMessage } from "@vellumai/electron-desktop/host-proxy/sse";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePoster() {
  const postCuResult = mock(async (_payload: unknown) => true);
  return {
    poster: { postCuResult } as unknown as HostProxyPoster,
    postCuResult,
  };
}

function request(
  overrides: Partial<HostProxySseMessage> = {},
): HostProxySseMessage {
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

/**
 * The one tool answered in this process. The helper has no idea the frame
 * exists, so a request that reached it would come back as an unknown tool.
 */
describe("pointing at the shared surface", () => {
  const marks = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1, caption: "Press" }];

  const pointAt = (input: unknown = { marks }) =>
    request({ toolName: POINT_AT_TOOL, input: input as never });

  // Its own, since the helper is what this path must not reach: a call on it
  // is the failure these cases are looking for.
  const helperReturning = (result: unknown) => ({
    call: mock(async () => result),
  });

  beforeEach(() => {
    marksStand = true;
    showCoachmarks.mockClear();
  });

  test("draws the marks without going to the helper", async () => {
    const helper = helperReturning({});
    const executor = createHostCuExecutor({ helper, showCoachmarks });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt(), poster);
    await tick();

    expect(helper.call).not.toHaveBeenCalled();
    expect(showCoachmarks).toHaveBeenCalledTimes(1);
    expect(showCoachmarks.mock.calls[0]?.[0]).toEqual(marks);
    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      executionResult: "Drew 1 mark on the shared surface.",
    });
  });

  test("says so when the marks were taken down", async () => {
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt({ marks: [] }), poster);
    await tick();

    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      executionResult: "Marks cleared.",
    });
  });

  /**
   * The assistant is not looking at the screen it asked to draw on. A refusal
   * it could not read would have it talking the user through a ring that is
   * not there.
   */
  test("reports a refusal rather than a silent success", async () => {
    marksStand = false;
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt(), poster);
    await tick();

    const posted = postCuResult.mock.calls[0]?.[0] as {
      executionError?: string;
      executionResult?: string;
    };
    expect(posted.executionResult).toBeUndefined();
    expect(posted.executionError).toContain("Nothing is being shared");
  });

  test("refuses coordinates measured against some other surface", async () => {
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(
      pointAt({ marks: [{ x: 4, y: 0.2, width: 0.3, height: 0.1 }] }),
      poster,
    );
    await tick();

    expect(showCoachmarks).not.toHaveBeenCalled();
    expect(
      (postCuResult.mock.calls[0]?.[0] as { executionError?: string })
        .executionError,
    ).toContain("Invalid marks");
  });

  /**
   * A client with nowhere to draw says so, rather than reporting marks it
   * never placed. Every desktop client shares this executor; only one of them
   * has the frame.
   */
  test("answers that it cannot draw when nothing is wired to", async () => {
    const executor = createHostCuExecutor({ helper: helperReturning({}) });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt(), poster);
    await tick();

    expect(
      (postCuResult.mock.calls[0]?.[0] as { executionError?: string })
        .executionError,
    ).toContain("cannot draw on the screen");
  });

  test("still forwards every other tool to the helper", async () => {
    const helper = helperReturning({ executionResult: "clicked" });
    const executor = createHostCuExecutor({ helper, showCoachmarks });
    const { poster } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(helper.call).toHaveBeenCalledTimes(1);
    expect(showCoachmarks).not.toHaveBeenCalled();
  });
});
