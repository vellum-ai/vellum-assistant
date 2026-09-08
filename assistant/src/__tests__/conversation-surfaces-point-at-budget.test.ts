import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { POINT_AT_PROXY_TOOL } from "../tools/computer-use/skill-proxy-bridge.js";
import { clearHubClients, registerHubClient } from "./helpers/hub-clients.js";
import { asConversation } from "./helpers/mock-conversation.js";

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const { assistantEventHub } = await import("../runtime/assistant-event-hub.js");

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

const ACTOR = "actor-1";

const context = (proxy: unknown) =>
  asConversation({
    conversationId: "conv-1",
    hostCuProxy: proxy as never,
    currentTurnSourceActorPrincipalId: ACTOR,
  });

/**
 * A client that can actually draw. Pointing resolves on `host_cu_annotate`
 * and refuses outright when nothing holds it, so without this the requests
 * below would never reach the proxy and the budget would go untested.
 */
function withAnnotationClient(): void {
  registerHubClient({
    hub: assistantEventHub,
    clientId: "mac",
    interfaceId: "macos",
    capabilities: ["host_cu", "host_cu_annotate"],
    actorPrincipalId: ACTOR,
  });
}

/**
 * Pointing at the screen drives nothing: the user does the acting, and a
 * walkthrough can run for many marks. Counting each one against the
 * computer-use step budget would end a long one with the unrelated
 * instruction to call `computer_use_done`.
 */
describe("the computer-use step budget", () => {
  beforeEach(() => {
    clearHubClients(assistantEventHub);
    withAnnotationClient();
  });

  afterEach(() => {
    clearHubClients(assistantEventHub);
  });

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

  /**
   * Not advancing the count is only half of it: the proxy also refuses a
   * request once the count is past the limit. A conversation that had spent
   * its steps on real computer use could otherwise be left unable to take
   * down a mark it had already put on the user's screen.
   */
  test("does not stop a mark once it is spent", async () => {
    const { HostCuProxy } = await import("../daemon/host-cu-proxy.js");
    const proxy = new HostCuProxy(1);
    proxy.recordAction("computer_use_click", { element_id: 1 });
    proxy.recordAction("computer_use_click", { element_id: 2 });
    expect(proxy.stepCount).toBeGreaterThan(proxy.maxSteps);

    // The guard answers immediately; anything that gets past it goes on to
    // wait for a client, and there is none here. So "still pending" is the
    // observable difference between refused and allowed through.
    const pending = Symbol("pending");
    const settle = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(pending), 20)),
      ]);

    const spent = await settle(
      proxy.request("computer_use_click", {}, "conv-1", proxy.stepCount),
    );
    expect((spent as { content?: string }).content).toContain("Step limit");

    // The actor is passed so resolution finds the annotation client and the
    // step limit stays the only thing that could refuse this. Without it the
    // request is turned back for having no client to draw on, which would
    // pass this assertion for entirely the wrong reason.
    const cleared = await settle(
      proxy.request(
        POINT_AT_PROXY_TOOL,
        { marks: [] },
        "conv-1",
        proxy.stepCount,
        undefined,
        undefined,
        undefined,
        ACTOR,
      ),
    );
    expect(cleared).toBe(pending);
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
