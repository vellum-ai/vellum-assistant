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
// real one. Only the answer matters here: why the marks did not stand, or
// null for marks that did.
let refusal: CoachmarkRefusal | null = null;
/**
 * Stands in for the window layer, and tags the marks the way it does: bounds
 * given outright keep their ring, a named control resolves to a place.
 */
const showCoachmarks = mock(
  async (
    requests: readonly CoachmarkRequest[],
    _conversationId?: string,
  ): Promise<CoachmarkResult> =>
    refusal === null
      ? {
          kind: "placed",
          marks: requests.map((request) =>
            "target" in request
              ? {
                  kind: "point" as const,
                  x: 0.5,
                  y: 0.5,
                  matched: request.target,
                }
              : { kind: "region" as const, ...request },
          ),
        }
      : { kind: "refused", refusal },
);

import { createHostCuExecutor, POINT_AT_TOOL } from "./host-cu-executor";
import type {
  CoachmarkRefusal,
  CoachmarkRequest,
  CoachmarkResult,
} from "@vellumai/ipc-contract";
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
    refusal = null;
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
    expect(showCoachmarks.mock.calls[0]?.[1]).toBe("conv-1");
    expect(postCuResult.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      executionResult:
        "Drew 1 mark on the shared surface: a ring over 10%,20% to 40%,30%. Coordinates are fractions of the surface.",
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

  /** What the assistant is told, for one refusal. */
  const refusedWith = async (reason: CoachmarkRefusal): Promise<string> => {
    refusal = reason;
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
    return posted.executionError ?? "";
  };

  /**
   * The assistant is not looking at the screen it asked to draw on. A refusal
   * it could not read would have it talking the user through a ring that is
   * not there.
   */
  test("reports a refusal rather than a silent success", async () => {
    expect(await refusedWith("unshared")).toContain("Nothing is being shared");
  });

  /**
   * Each refusal has its own answer, so the assistant can act on which one it
   * got: one asks the user to share, one is not answerable at all, and one
   * asks for another look. A single wording would have it asking for a share
   * that is already running.
   */
  test("tells a turn that does not own the call so", async () => {
    expect(await refusedWith("not-this-call")).toContain(
      "belongs to another conversation",
    );
  });

  test("tells a turn holding an old picture to look again", async () => {
    const told = await refusedWith("stale-surface");
    expect(told).toContain("moved the share");
    expect(told).not.toContain("Ask the user to share");
  });

  /**
   * Overtaken is not the same as failed: the screen is showing what asked
   * last, and a turn told only that it failed would point again and take it
   * back.
   */
  test("tells an overtaken turn that the screen belongs to the later one", async () => {
    const told = await refusedWith("superseded");
    expect(told).toContain("Another request");
    expect(told).toContain("were not drawn");
  });

  /**
   * A lookup held open, so a case can decide what else happens while a name
   * is still being resolved.
   */
  const paintHeldBy = (): (() => void) => {
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    showCoachmarks.mockImplementationOnce(async (requests) => {
      await held;
      return {
        kind: "placed",
        marks: requests.map((request) =>
          "target" in request
            ? {
                kind: "point" as const,
                x: 0.5,
                y: 0.5,
                matched: request.target,
              }
            : { kind: "region" as const, ...request },
        ),
      };
    });
    return letGo;
  };

  /**
   * Resolving a name is a round trip, which is long enough for a cancel to
   * land inside one. By the time it answers the turn that asked is gone: a
   * result posted for it answers nobody.
   */
  test("posts nothing for a pointing that was cancelled mid-lookup", async () => {
    const letGo = paintHeldBy();
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt(), poster);
    executor.handleCancel(pointAt(), poster);
    letGo();
    await tick();

    expect(postCuResult).not.toHaveBeenCalled();
  });

  /**
   * And it touches nothing else on the way out. A cancel can answer after a
   * later request has painted, and a tidy-up from here would be taking that
   * request's marks down rather than its own. What is on the screen belongs
   * to whichever request painted last.
   */
  test("a cancelled pointing takes nothing down", async () => {
    const letGo = paintHeldBy();
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster } = makePoster();

    executor.handleRequest(pointAt(), poster);
    executor.handleCancel(pointAt(), poster);
    letGo();
    await tick();

    expect(showCoachmarks).toHaveBeenCalledTimes(1);
  });

  /** A cancel for a pointing that already answered changes nothing. */
  test("a cancel after the marks are up leaves them up", async () => {
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(pointAt(), poster);
    await tick();
    executor.handleCancel(pointAt(), poster);
    await tick();

    expect(postCuResult).toHaveBeenCalledTimes(1);
    expect(showCoachmarks).toHaveBeenCalledTimes(1);
  });

  /**
   * The host bounds the names it sends back, so a surface carrying hundreds
   * arrives as a handful. Counting the rest off the list that arrived would
   * tell the assistant a page of 300 controls has 24 of them.
   */
  test("counts the names it is not showing off the surface, not off the list", async () => {
    showCoachmarks.mockImplementationOnce(
      async () =>
        ({
          kind: "unresolved",
          unresolved: {
            target: "white balance",
            reason: "no-match",
            candidates: Array.from({ length: 30 }, (_, i) => `Control ${i}`),
            candidateCount: 312,
          },
        }) as CoachmarkResult,
    );
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(
      pointAt({ marks: [{ target: "white balance" }] }),
      poster,
    );
    await tick();

    const told = (
      postCuResult.mock.calls[0]?.[0] as { executionError?: string }
    ).executionError;
    expect(told).toContain("(and 288 more)");
    expect(told).toContain("Control 23");
    expect(told).not.toContain("Control 24");
  });

  /** A host that sends no count is read off the names it did send. */
  test("counts off the list when the host sent no total", async () => {
    showCoachmarks.mockImplementationOnce(
      async () =>
        ({
          kind: "unresolved",
          unresolved: {
            target: "white balance",
            reason: "no-match",
            candidates: Array.from({ length: 30 }, (_, i) => `Control ${i}`),
          },
        }) as CoachmarkResult,
    );
    const executor = createHostCuExecutor({
      helper: helperReturning({}),
      showCoachmarks,
    });
    const { poster, postCuResult } = makePoster();

    executor.handleRequest(
      pointAt({ marks: [{ target: "white balance" }] }),
      poster,
    );
    await tick();

    expect(
      (postCuResult.mock.calls[0]?.[0] as { executionError?: string })
        .executionError,
    ).toContain("(and 6 more)");
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
