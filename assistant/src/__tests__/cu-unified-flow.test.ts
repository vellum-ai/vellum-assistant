/**
 * End-to-end tests for the unified CU proxy flow.
 *
 * Tests the surfaceProxyResolver's CU tool routing — the integration
 * point between the agent loop and the HostCuProxy.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
let mockHasClient = true; // Default to true for CU unified flow tests

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_cu" && mockHasClient ? { id: "mock-client" } : null,
  },
}));

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const { HostCuProxy } = await import("../daemon/host-cu-proxy.js");
type SurfaceConversationContext =
  import("../daemon/conversation-surfaces.js").SurfaceConversationContext;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SurfaceConversationContext with optional hostCuProxy.
 * Only the fields required by the CU routing path are populated.
 */
function buildMockContext(
  hostCuProxy?: InstanceType<typeof HostCuProxy>,
): SurfaceConversationContext {
  return {
    conversationId: "test-session",
    traceEmitter: { emit: () => {} },
    sendToClient: () => {},
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set(),
    currentTurnSurfaces: [],
    hostCuProxy,
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async (_id, fn) => fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("surfaceProxyResolver — CU tool routing", () => {
  let proxy: InstanceType<typeof HostCuProxy>;

  function setupProxy(maxSteps?: number): SurfaceConversationContext {
    sentMessages.length = 0;
    mockHasClient = true;
    proxy = new HostCuProxy(maxSteps);
    return buildMockContext(proxy);
  }

  afterEach(() => {
    proxy?.dispose();
  });

  // -------------------------------------------------------------------------
  // No desktop client connected
  // -------------------------------------------------------------------------

  describe("no desktop client connected", () => {
    test("returns error when hostCuProxy is undefined", async () => {
      const ctx = buildMockContext(/* no proxy */);
      const result = await surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 42,
        reasoning: "click the button",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
      expect(result.content).toContain("no desktop client");
    });

    test("returns error for screenshot tool when no proxy", async () => {
      const ctx = buildMockContext();
      const result = await surfaceProxyResolver(
        ctx,
        "computer_use_screenshot",
        {},
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
    });

    test("returns error when proxy exists but client not connected", async () => {
      mockHasClient = false;
      const proxyObj = new HostCuProxy();
      const ctx = buildMockContext(proxyObj);
      const result = await surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
      proxyObj.dispose();
    });

    test("returns error for terminal tools when no proxy", async () => {
      const ctx = buildMockContext();

      const doneResult = await surfaceProxyResolver(ctx, "computer_use_done", {
        summary: "finished",
      });
      expect(doneResult.isError).toBe(true);

      const respondResult = await surfaceProxyResolver(
        ctx,
        "computer_use_respond",
        { answer: "42" },
      );
      expect(respondResult.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Terminal tools (computer_use_done, computer_use_respond)
  // -------------------------------------------------------------------------

  describe("terminal tools resolve immediately", () => {
    test("computer_use_done resets proxy and returns summary", async () => {
      const ctx = setupProxy();

      // Record some actions first to verify reset
      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      expect(proxy.stepCount).toBe(2);

      const result = await surfaceProxyResolver(ctx, "computer_use_done", {
        summary: "Completed the file upload",
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Completed the file upload");
      // No message sent to client for terminal tools
      expect(sentMessages).toHaveLength(0);
      // Proxy state should be reset
      expect(proxy.stepCount).toBe(0);
      expect(proxy.actionHistory).toHaveLength(0);
    });

    test("computer_use_respond resets proxy and returns answer", async () => {
      const ctx = setupProxy();

      proxy.recordAction("computer_use_click", { element_id: 1 });

      const result = await surfaceProxyResolver(ctx, "computer_use_respond", {
        answer: "The price is $42",
        reasoning: "Found the price on the page",
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBe("The price is $42");
      expect(sentMessages).toHaveLength(0);
      expect(proxy.stepCount).toBe(0);
    });

    test("computer_use_done uses default when no summary provided", async () => {
      const ctx = setupProxy();

      const result = await surfaceProxyResolver(ctx, "computer_use_done", {});

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Task complete");
    });

    test("computer_use_respond falls back to summary then default", async () => {
      const ctx = setupProxy();

      // No answer but has summary — done tool uses summary
      const r1 = await surfaceProxyResolver(ctx, "computer_use_done", {
        summary: "All done",
      });
      expect(r1.content).toBe("All done");

      // respond with answer field
      const r2 = await surfaceProxyResolver(ctx, "computer_use_respond", {
        answer: "The answer is 7",
      });
      expect(r2.content).toBe("The answer is 7");
    });
  });

  // -------------------------------------------------------------------------
  // Action tools (computer_use_click, screenshot, etc.) — proxy to client
  // -------------------------------------------------------------------------

  describe("action tools proxy to client", () => {
    test("computer_use_click routes through proxy and returns observation", async () => {
      const ctx = setupProxy();

      const resultPromise = surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 42,
        reasoning: "Click the submit button",
      });

      // Verify the proxy sent a request to the client
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_cu_request");
      expect(sent.toolName).toBe("computer_use_click");
      expect(sent.input).toEqual({
        element_id: 42,
        reasoning: "Click the submit button",
      });
      expect(sent.conversationId).toBe("test-session");

      // Action was recorded
      expect(proxy.stepCount).toBe(1);
      expect(proxy.actionHistory).toHaveLength(1);
      expect(proxy.actionHistory[0].toolName).toBe("computer_use_click");

      // Simulate client resolving with observation
      const requestId = sent.requestId as string;
      proxy.processObservation(requestId, {
        axTree: "SubmitButton [1]\nTextField [2]",
        executionResult: "Clicked element 42",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Clicked element 42");
      expect(result.content).toContain("<ax-tree>");
      expect(result.content).toContain("SubmitButton [1]");
    });

    test("computer_use_screenshot routes through proxy", async () => {
      const ctx = setupProxy();

      const resultPromise = surfaceProxyResolver(
        ctx,
        "computer_use_screenshot",
        { reasoning: "Capture current state" },
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_cu_request");
      expect(sent.toolName).toBe("computer_use_screenshot");

      proxy.processObservation(sent.requestId as string, {
        axTree: "Window [1]",
        screenshot: "base64screenshot",
        screenshotWidthPx: 1920,
        screenshotHeightPx: 1080,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("1920x1080 px");
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks![0]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "base64screenshot",
        },
      });
    });

    test("computer_use_type_text routes through proxy", async () => {
      const ctx = setupProxy();

      const resultPromise = surfaceProxyResolver(
        ctx,
        "computer_use_type_text",
        { text: "Hello world", reasoning: "Type into search box" },
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.toolName).toBe("computer_use_type_text");
      expect(sent.input).toEqual({
        text: "Hello world",
        reasoning: "Type into search box",
      });

      proxy.processObservation(sent.requestId as string, {
        axTree: "SearchBox [1] value='Hello world'",
        executionResult: "Typed text",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Typed text");
    });
  });

  // -------------------------------------------------------------------------
  // Full proxy lifecycle (observe → click → done)
  // -------------------------------------------------------------------------

  describe("full proxy lifecycle", () => {
    test("observe → click → done sequence", async () => {
      const ctx = setupProxy();

      // Step 1: observe (screenshot)
      const p1 = surfaceProxyResolver(ctx, "computer_use_screenshot", {
        reasoning: "Check what's on screen",
      });
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy.processObservation(sent1.requestId as string, {
        axTree: "LoginButton [1]\nUsernameField [2]",
      });
      const r1 = await p1;
      expect(r1.isError).toBe(false);
      expect(r1.content).toContain("LoginButton [1]");
      expect(proxy.stepCount).toBe(1);

      // Step 2: click
      const p2 = surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 1,
        reasoning: "Click login button",
      });
      const sent2 = sentMessages[1] as Record<string, unknown>;
      proxy.processObservation(sent2.requestId as string, {
        axTree: "PasswordField [1]\nSubmitButton [2]",
        axDiff: "+ PasswordField [1]\n+ SubmitButton [2]\n- LoginButton [1]",
        executionResult: "Clicked element 1",
      });
      const r2 = await p2;
      expect(r2.isError).toBe(false);
      expect(r2.content).toContain("Clicked element 1");
      expect(r2.content).toContain("PasswordField [1]");
      expect(proxy.stepCount).toBe(2);

      // Step 3: done
      const r3 = await surfaceProxyResolver(ctx, "computer_use_done", {
        summary: "Logged in successfully",
      });
      expect(r3.isError).toBe(false);
      expect(r3.content).toBe("Logged in successfully");

      // Proxy state is clean after done
      expect(proxy.stepCount).toBe(0);
      expect(proxy.actionHistory).toHaveLength(0);
      // Only 2 messages sent to client (screenshot + click; done is terminal)
      expect(sentMessages).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Step limit enforced through resolver
  // -------------------------------------------------------------------------

  describe("step limit enforcement through resolver", () => {
    test("rejects action tools when step limit exceeded", async () => {
      const ctx = setupProxy(2); // maxSteps = 2

      // Record enough actions to exceed the limit
      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      proxy.recordAction("computer_use_click", { element_id: 3 });
      expect(proxy.stepCount).toBe(3);

      // The surfaceProxyResolver calls proxy.request, which checks step limit
      const result = await surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 4,
        reasoning: "click",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Step limit");
      expect(result.content).toContain("computer_use_done");
    });

    test("terminal tools still work after step limit exceeded", async () => {
      const ctx = setupProxy(2);

      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      proxy.recordAction("computer_use_click", { element_id: 3 });

      // computer_use_done should still work (terminal, resolves immediately)
      const result = await surfaceProxyResolver(ctx, "computer_use_done", {
        summary: "Stopped because step limit",
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Stopped because step limit");
      expect(proxy.stepCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error from client
  // -------------------------------------------------------------------------

  describe("error from client observation", () => {
    test("returns error result when client reports execution error", async () => {
      const ctx = setupProxy();

      const resultPromise = surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 999,
        reasoning: "click missing element",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      proxy.processObservation(sent.requestId as string, {
        executionError: "Element 999 not found in AX tree",
        axTree: "Window [1]",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Action failed");
      expect(result.content).toContain("Element 999 not found");
    });
  });

  // -------------------------------------------------------------------------
  // Reasoning propagation
  // -------------------------------------------------------------------------

  describe("reasoning propagation", () => {
    test("reasoning from input is passed to proxy request", async () => {
      const ctx = setupProxy();

      const resultPromise = surfaceProxyResolver(ctx, "computer_use_key", {
        key: "Enter",
        reasoning: "Submit the form",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.reasoning).toBe("Submit the form");

      // Resolve to avoid unhandled rejection on dispose
      proxy.processObservation(sent.requestId as string, { axTree: "..." });
      await resultPromise;
    });

    test("reasoning is recorded in action history", async () => {
      const ctx = setupProxy();

      surfaceProxyResolver(ctx, "computer_use_scroll", {
        direction: "down",
        amount: 3,
        reasoning: "Scroll to see more",
      });

      expect(proxy.actionHistory[0].reasoning).toBe("Scroll to see more");

      // Resolve to avoid hanging
      const sent = sentMessages[0] as Record<string, unknown>;
      proxy.processObservation(sent.requestId as string, { axTree: "..." });
    });
  });

  // -------------------------------------------------------------------------
  // Non-CU tools are not handled by CU routing
  // -------------------------------------------------------------------------

  describe("non-CU tools are not handled by CU routing", () => {
    test("ui_show is not affected by CU routing", async () => {
      const ctx = setupProxy();

      const result = await surfaceProxyResolver(ctx, "ui_show", {
        surface_type: "confirmation",
        data: { message: "Are you sure?" },
      });

      // ui_show goes through its own path, not the CU path
      expect(result.content).not.toContain("not available");
      expect(result.content).not.toContain("desktop client");
    });

    test("unknown tool returns error", async () => {
      const ctx = setupProxy();

      const result = await surfaceProxyResolver(ctx, "not_a_real_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown proxy tool");
    });
  });

  // -------------------------------------------------------------------------
  // Multiple sequential CU actions accumulate state
  // -------------------------------------------------------------------------

  describe("state accumulation across actions", () => {
    test("step count increments across multiple actions", async () => {
      const ctx = setupProxy();

      // Action 1
      const p1 = surfaceProxyResolver(ctx, "computer_use_click", {
        element_id: 1,
        reasoning: "first",
      });
      const s1 = sentMessages[0] as Record<string, unknown>;
      proxy.processObservation(s1.requestId as string, { axTree: "A" });
      await p1;
      expect(proxy.stepCount).toBe(1);

      // Action 2
      const p2 = surfaceProxyResolver(ctx, "computer_use_type_text", {
        text: "hello",
        reasoning: "second",
      });
      const s2 = sentMessages[1] as Record<string, unknown>;
      proxy.processObservation(s2.requestId as string, { axTree: "B" });
      await p2;
      expect(proxy.stepCount).toBe(2);

      // Action 3
      const p3 = surfaceProxyResolver(ctx, "computer_use_scroll", {
        direction: "down",
        amount: 1,
        reasoning: "third",
      });
      const s3 = sentMessages[2] as Record<string, unknown>;
      proxy.processObservation(s3.requestId as string, { axTree: "C" });
      await p3;
      expect(proxy.stepCount).toBe(3);

      // History has all 3
      expect(proxy.actionHistory).toHaveLength(3);
      expect(proxy.actionHistory.map((a) => a.toolName)).toEqual([
        "computer_use_click",
        "computer_use_type_text",
        "computer_use_scroll",
      ]);
    });
  });
});
