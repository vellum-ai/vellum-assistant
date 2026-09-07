/**
 * Which capability answers a point-at request.
 *
 * Pointing rides the `computer_use_` wire so it reaches the same proxy as an
 * action, but only a client that draws the overlay can serve it. Resolving it
 * as plain `host_cu` would call a lone annotation-capable client ambiguous
 * against a helper-backed one that could never have answered, and would
 * accept an explicit helper target and forward it an action its helper does
 * not have.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { POINT_AT_PROXY_TOOL } from "../tools/computer-use/skill-proxy-bridge.js";
import { clearHubClients, registerHubClient } from "./helpers/hub-clients.js";
import { asConversation } from "./helpers/mock-conversation.js";

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const { assistantEventHub } = await import("../runtime/assistant-event-hub.js");

const ACTOR = "actor-1";

/** A proxy that answers, so resolution is the only thing under test. */
function proxyDouble() {
  const request = mock(async () => ({ content: "ok", isError: false }));
  return {
    request,
    proxy: {
      isAvailable: () => true,
      recordAction: () => {},
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
    currentTurnSourceActorPrincipalId: ACTOR,
  });

const MARKS = { marks: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }] };

beforeEach(() => {
  clearHubClients(assistantEventHub);
});

afterEach(() => {
  clearHubClients(assistantEventHub);
});

describe("resolving a point-at request", () => {
  /**
   * The case Codex named: one client can draw and one cannot, and selecting on
   * the transport makes that pair ambiguous even though only one answer was
   * ever possible.
   */
  test("is not made ambiguous by a client that cannot draw", async () => {
    const { proxy, request } = proxyDouble();
    registerHubClient({
      hub: assistantEventHub,
      clientId: "mac",
      interfaceId: "macos",
      capabilities: ["host_cu", "host_cu_annotate"],
      actorPrincipalId: ACTOR,
    });
    registerHubClient({
      hub: assistantEventHub,
      clientId: "win",
      interfaceId: "windows",
      capabilities: ["host_cu"],
      actorPrincipalId: ACTOR,
    });

    const result = await surfaceProxyResolver(
      context(proxy),
      POINT_AT_PROXY_TOOL,
      MARKS,
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half: an explicit target that cannot draw is refused here rather
   * than forwarded to a helper with no such action.
   */
  test("refuses an explicit target that cannot draw", async () => {
    const { proxy, request } = proxyDouble();
    registerHubClient({
      hub: assistantEventHub,
      clientId: "win",
      interfaceId: "windows",
      capabilities: ["host_cu"],
      actorPrincipalId: ACTOR,
    });

    const result = await surfaceProxyResolver(
      context(proxy),
      POINT_AT_PROXY_TOOL,
      { ...MARKS, target_client_id: "win" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("host_cu_annotate");
    expect(request).not.toHaveBeenCalled();
  });

  /**
   * The annotation-capable client went away after the skill was already on the
   * surface. Nothing left can draw, so the request is refused rather than
   * broadcast: an untargeted point-at would otherwise be handed to whatever
   * host_cu client was listening, which is the mis-routing this capability
   * exists to prevent.
   */
  test("refuses rather than broadcasting when nothing can draw", async () => {
    const { proxy, request } = proxyDouble();
    registerHubClient({
      hub: assistantEventHub,
      clientId: "win",
      interfaceId: "windows",
      capabilities: ["host_cu"],
      actorPrincipalId: ACTOR,
    });

    const result = await surfaceProxyResolver(
      context(proxy),
      POINT_AT_PROXY_TOOL,
      MARKS,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("host_cu_annotate");
    expect(request).not.toHaveBeenCalled();
  });

  /** An ordinary action still resolves on the transport it always did. */
  test("leaves an ordinary computer-use action on host_cu", async () => {
    const { proxy, request } = proxyDouble();
    registerHubClient({
      hub: assistantEventHub,
      clientId: "win",
      interfaceId: "windows",
      capabilities: ["host_cu"],
      actorPrincipalId: ACTOR,
    });

    const result = await surfaceProxyResolver(
      context(proxy),
      "computer_use_click",
      { x: 10, y: 10 },
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
