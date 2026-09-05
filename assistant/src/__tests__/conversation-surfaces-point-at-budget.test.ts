import { describe, expect, mock, test } from "bun:test";

import { POINT_AT_PROXY_TOOL } from "../tools/computer-use/skill-proxy-bridge.js";
import { asConversation } from "./helpers/mock-conversation.js";

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");

/**
 * A CU proxy that records what it was asked to account for. `recordAction` is
 * what advances `stepCount` towards `maxStepsPerSession`, so counting calls to
 * it is the same question as "did this consume the budget".
 */
function proxyDouble() {
  const recordAction = mock(() => {});
  const request = mock(async () => ({ content: "ok", isError: false }));
  return {
    recordAction,
    request,
    proxy: {
      isAvailable: () => true,
      recordAction,
      request,
      reset: () => {},
      stepCount: 0,
    },
  };
}

const context = (proxy: unknown) =>
  asConversation({
    conversationId: "conv-1",
    hostCuProxy: proxy as never,
  });

/**
 * Pointing at the screen drives nothing: the user does the acting, and a
 * walkthrough can run for many marks. Counting each one against the
 * computer-use step budget would end a long one with the unrelated
 * instruction to call `computer_use_done`.
 */
describe("the computer-use step budget", () => {
  test("is not spent by pointing at the screen", async () => {
    const { proxy, recordAction, request } = proxyDouble();

    await surfaceProxyResolver(context(proxy), POINT_AT_PROXY_TOOL, {
      marks: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }],
    });

    expect(recordAction).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("is not spent by taking the marks down", async () => {
    const { proxy, recordAction } = proxyDouble();

    await surfaceProxyResolver(context(proxy), POINT_AT_PROXY_TOOL, {
      marks: [],
    });

    expect(recordAction).not.toHaveBeenCalled();
  });

  /** The actions it exists to bound still count. */
  test("is spent by an action that drives the machine", async () => {
    const { proxy, recordAction } = proxyDouble();

    await surfaceProxyResolver(context(proxy), "computer_use_click", {
      element_id: 3,
    });

    expect(recordAction).toHaveBeenCalledTimes(1);
  });
});
