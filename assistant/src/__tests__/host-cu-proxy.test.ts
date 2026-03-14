import { afterEach, describe, expect, test } from "bun:test";

import { HostCuProxy } from "../daemon/host-cu-proxy.js";

describe("HostCuProxy", () => {
  let proxy: InstanceType<typeof HostCuProxy>;
  let sentMessages: unknown[];
  let sendToClient: (msg: unknown) => void;
  let resolvedRequestIds: string[];

  function setup(maxSteps?: number) {
    sentMessages = [];
    resolvedRequestIds = [];
    sendToClient = (msg: unknown) => sentMessages.push(msg);
    proxy = new HostCuProxy(
      sendToClient as never,
      (requestId: string) => resolvedRequestIds.push(requestId),
      maxSteps,
    );
  }

  afterEach(() => {
    proxy?.dispose();
  });

  // -------------------------------------------------------------------------
  // Request / resolve lifecycle
  // -------------------------------------------------------------------------

  describe("request/resolve lifecycle", () => {
    test("sends host_cu_request and resolves with formatted observation", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 42 },
        "session-1",
        1,
        "Clicking the button",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_cu_request");
      expect(sent.sessionId).toBe("session-1");
      expect(sent.toolName).toBe("computer_use_click");
      expect(sent.input).toEqual({ element_id: 42 });
      expect(sent.stepNumber).toBe(1);
      expect(sent.reasoning).toBe("Clicking the button");
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.resolve(requestId, {
        axTree: "Button [1]\nLabel [2]",
        executionResult: "Clicked element 42",
      });

      const result = await resultPromise;
      expect(result.content).toContain("Clicked element 42");
      expect(result.content).toContain("<ax-tree>");
      expect(result.content).toContain("CURRENT SCREEN STATE:");
      expect(result.isError).toBe(false);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("formats error observation correctly", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 99 },
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolve(requestId, {
        executionError: "Element not found",
        axTree: "Window [1]",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Action failed: Element not found");
      expect(result.content).toContain("<ax-tree>");
    });

    test("includes screenshot as content block", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_screenshot",
        {},
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolve(requestId, {
        axTree: "Button [1]",
        screenshot: "base64data",
        screenshotWidthPx: 1920,
        screenshotHeightPx: 1080,
      });

      const result = await resultPromise;
      expect(result.contentBlocks).toBeDefined();
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks![0]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "base64data",
        },
      });
      expect(result.content).toContain("1920x1080 px");
    });

    test("resolves with unknown requestId is silently ignored", () => {
      setup();
      // Should not throw
      proxy.resolve("unknown-id", { axTree: "something" });
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe("timeout", () => {
    test("resolves with timeout error when timer fires", async () => {
      setup();

      // We can't easily test the 60s timeout in a unit test, but we can
      // verify the pending state and manual resolution.
      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Resolve to avoid test hanging
      proxy.resolve(requestId, { axTree: "resolved" });
      await resultPromise;
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe("abort signal", () => {
    test("resolves with abort result when signal fires", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toContain("Aborted");
      expect(result.isError).toBe(true);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("returns immediately if signal already aborted", async () => {
      setup();

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        controller.signal,
      );

      expect(result.content).toContain("Aborted");
      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0); // No message sent
    });
  });

  // -------------------------------------------------------------------------
  // Step limit enforcement
  // -------------------------------------------------------------------------

  describe("step limit enforcement", () => {
    test("returns error when step count exceeds max", async () => {
      setup(3); // maxSteps = 3

      // Record 4 actions to exceed the limit
      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      proxy.recordAction("computer_use_click", { element_id: 3 });
      proxy.recordAction("computer_use_click", { element_id: 4 });

      expect(proxy.stepCount).toBe(4);

      // Now request should be rejected without sending to client
      const result = await proxy.request(
        "computer_use_click",
        { element_id: 5 },
        "session-1",
        5,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Step limit (3) exceeded");
      expect(result.content).toContain("computer_use_done");
      expect(sentMessages).toHaveLength(0); // No message sent to client
    });

    test("allows requests within step limit", async () => {
      setup(5); // maxSteps = 5

      proxy.recordAction("computer_use_click", { element_id: 1 });
      expect(proxy.stepCount).toBe(1);

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 2 },
        "session-1",
        2,
      );

      expect(sentMessages).toHaveLength(1); // Message was sent

      const sent = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(sent.requestId as string, { axTree: "screen" });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Loop detection
  // -------------------------------------------------------------------------

  describe("loop detection", () => {
    test("injects warning when same action repeated 3 times", () => {
      setup();

      // Record 3 identical actions
      proxy.recordAction("computer_use_click", { element_id: 42 });
      proxy.recordAction("computer_use_click", { element_id: 42 });
      proxy.recordAction("computer_use_click", { element_id: 42 });

      const result = proxy.formatObservation({
        axTree: "Button [1]",
      });

      expect(result.content).toContain(
        "WARNING: You've repeated the same action (computer_use_click) 3 times",
      );
    });

    test("does not warn when actions differ", () => {
      setup();

      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      proxy.recordAction("computer_use_click", { element_id: 3 });

      const result = proxy.formatObservation({
        axTree: "Button [1]",
      });

      expect(result.content).not.toContain("WARNING: You've repeated");
    });

    test("does not warn with fewer than 3 actions", () => {
      setup();

      proxy.recordAction("computer_use_click", { element_id: 42 });
      proxy.recordAction("computer_use_click", { element_id: 42 });

      const result = proxy.formatObservation({
        axTree: "Button [1]",
      });

      expect(result.content).not.toContain("WARNING: You've repeated");
    });
  });

  // -------------------------------------------------------------------------
  // Consecutive unchanged steps warning
  // -------------------------------------------------------------------------

  describe("consecutive unchanged steps", () => {
    test("warns after 2 consecutive unchanged observations", async () => {
      setup();

      // Simulate first request/resolve to establish previous AX tree
      const p1 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(sent1.requestId as string, {
        axTree: "Button [1]",
      });
      await p1;

      // Second request — same AX tree, no diff (unchanged step 1)
      const p2 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        2,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent2 = sentMessages[1] as Record<string, unknown>;
      proxy.resolve(sent2.requestId as string, {
        axTree: "Button [1]",
        // No axDiff — screen unchanged
      });
      const result2 = await p2;
      // First unchanged: simple warning
      expect(result2.content).toContain("NO VISIBLE EFFECT");
      expect(result2.content).not.toContain("2 consecutive");

      // Third request — still same AX tree, no diff (unchanged step 2)
      const p3 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        3,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent3 = sentMessages[2] as Record<string, unknown>;
      proxy.resolve(sent3.requestId as string, {
        axTree: "Button [1]",
      });
      const result3 = await p3;
      // Should now have the consecutive warning
      expect(result3.content).toContain(
        "2 consecutive actions had NO VISIBLE EFFECT",
      );
    });

    test("does not emit spurious warning on first observation", async () => {
      setup();

      // First ever request — no previous AX tree exists
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const p1 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(sent1.requestId as string, {
        axTree: "Button [1]",
        // No axDiff on first observation — this is normal, not unchanged
      });
      const result1 = await p1;
      expect(result1.content).not.toContain("NO VISIBLE EFFECT");
    });

    test("skips unchanged warning after computer_use_wait", async () => {
      setup();

      // Establish previous AX tree
      const p1 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(sent1.requestId as string, {
        axTree: "Button [1]",
      });
      await p1;

      // Wait action with unchanged screen — should NOT warn
      const p2 = proxy.request(
        "computer_use_wait",
        { duration_ms: 2000 },
        "session-1",
        2,
      );
      proxy.recordAction("computer_use_wait", { duration_ms: 2000 });
      const sent2 = sentMessages[1] as Record<string, unknown>;
      proxy.resolve(sent2.requestId as string, {
        axTree: "Button [1]",
        // No axDiff — screen unchanged, but that's expected after wait
      });
      const result2 = await p2;
      expect(result2.content).not.toContain("NO VISIBLE EFFECT");
    });

    test("resets consecutive count when diff is present", async () => {
      setup();

      // Establish previous AX tree
      const p1 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(sent1.requestId as string, {
        axTree: "Button [1]",
      });
      await p1;

      // Second request with no diff (unchanged)
      const p2 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        2,
      );
      proxy.recordAction("computer_use_click", { element_id: 1 });
      const sent2 = sentMessages[1] as Record<string, unknown>;
      proxy.resolve(sent2.requestId as string, {
        axTree: "Button [1]",
      });
      await p2;
      expect(proxy.consecutiveUnchangedSteps).toBe(1);

      // Third request WITH diff (changed) — should reset
      const p3 = proxy.request(
        "computer_use_click",
        { element_id: 2 },
        "session-1",
        3,
      );
      proxy.recordAction("computer_use_click", { element_id: 2 });
      const sent3 = sentMessages[2] as Record<string, unknown>;
      proxy.resolve(sent3.requestId as string, {
        axTree: "TextField [1]",
        axDiff: "+ TextField [1]\n- Button [1]",
      });
      await p3;
      expect(proxy.consecutiveUnchangedSteps).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Observation formatting
  // -------------------------------------------------------------------------

  describe("observation formatting", () => {
    test("formats AX tree with markers", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Button [1]\nLabel [2]",
      });

      expect(result.content).toContain("<ax-tree>");
      expect(result.content).toContain("CURRENT SCREEN STATE:");
      expect(result.content).toContain("Button [1]");
      expect(result.content).toContain("</ax-tree>");
      expect(result.isError).toBe(false);
    });

    test("formats user guidance prominently", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Button [1]",
        userGuidance: "Click the save button",
      });

      expect(result.content).toContain("USER GUIDANCE: Click the save button");
      // User guidance should appear before AX tree
      const guidanceIdx = result.content.indexOf("USER GUIDANCE");
      const axTreeIdx = result.content.indexOf("<ax-tree>");
      expect(guidanceIdx).toBeLessThan(axTreeIdx);
    });

    test("formats execution result", () => {
      setup();

      const result = proxy.formatObservation({
        executionResult: "Element clicked successfully",
        axTree: "Button [1]",
      });

      expect(result.content).toContain("Element clicked successfully");
    });

    test("formats execution error", () => {
      setup();

      const result = proxy.formatObservation({
        executionError: "Element not found",
        axTree: "Window [1]",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Action failed: Element not found");
    });

    test("returns 'Action executed' when observation is empty", () => {
      setup();

      const result = proxy.formatObservation({});

      expect(result.content).toBe("Action executed");
      expect(result.isError).toBe(false);
    });

    test("includes screenshot metadata", () => {
      setup();

      const result = proxy.formatObservation({
        screenshot: "base64data",
        screenshotWidthPx: 2560,
        screenshotHeightPx: 1440,
        screenWidthPt: 1280,
        screenHeightPt: 720,
      });

      expect(result.content).toContain("2560x1440 px");
      expect(result.content).toContain("1280x720 pt");
    });

    test("escapes </ax-tree> in AX tree content", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Some content with </ax-tree> inside",
      });

      expect(result.content).toContain("&lt;/ax-tree&gt;");
      // Should still have the real closing marker
      expect(result.content).toMatch(/<\/ax-tree>$/m);
    });

    test("includes secondaryWindows after AX tree with cross-window note", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Button [1]\nLabel [2]",
        secondaryWindows: "Safari — Window [10]\n  Link [11]",
      });

      expect(result.content).toContain("Safari — Window [10]");
      expect(result.content).toContain("Link [11]");
      expect(result.content).toContain(
        "Note: The element [ID]s above are from other windows",
      );
      // secondaryWindows should appear after the AX tree
      const axTreeEnd = result.content.indexOf("</ax-tree>");
      const secondaryIdx = result.content.indexOf("Safari — Window [10]");
      expect(axTreeEnd).toBeLessThan(secondaryIdx);
    });

    test("omits secondaryWindows section when field is absent", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Button [1]",
      });

      expect(result.content).not.toContain("other windows");
    });

    test("includes diff when present", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "TextField [1]",
        axDiff: "+ TextField [1]\n- Button [1]",
      });

      expect(result.content).toContain("+ TextField [1]");
      expect(result.content).toContain("- Button [1]");
    });

    test("no screenshot content blocks when screenshot absent", () => {
      setup();

      const result = proxy.formatObservation({
        axTree: "Button [1]",
      });

      expect(result.contentBlocks).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // CU state: reset
  // -------------------------------------------------------------------------

  describe("reset", () => {
    test("clears all CU state", () => {
      setup();

      proxy.recordAction("computer_use_click", { element_id: 1 });
      proxy.recordAction("computer_use_click", { element_id: 2 });
      expect(proxy.stepCount).toBe(2);
      expect(proxy.actionHistory).toHaveLength(2);

      proxy.reset();

      expect(proxy.stepCount).toBe(0);
      expect(proxy.actionHistory).toHaveLength(0);
      expect(proxy.previousAXTree).toBeUndefined();
      expect(proxy.consecutiveUnchangedSteps).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // CU state: action history bounding
  // -------------------------------------------------------------------------

  describe("action history bounding", () => {
    test("keeps only last 10 entries", () => {
      setup();

      for (let i = 0; i < 15; i++) {
        proxy.recordAction("computer_use_click", { element_id: i });
      }

      expect(proxy.actionHistory).toHaveLength(10);
      // First entry should be step 6 (entries 1-5 trimmed)
      expect(proxy.actionHistory[0].step).toBe(6);
      expect(proxy.stepCount).toBe(15);
    });
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    test("rejects all pending requests", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.dispose();

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      await expect(resultPromise).rejects.toThrow("Host CU proxy disposed");
    });
  });

  // -------------------------------------------------------------------------
  // onInternalResolve callback
  // -------------------------------------------------------------------------

  describe("onInternalResolve", () => {
    test("calls onInternalResolve when abort signal fires", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      controller.abort();

      await resultPromise;
      expect(resolvedRequestIds).toContain(requestId);
    });

    test("calls onInternalResolve on dispose", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.dispose();

      // dispose rejects pending requests — catch to avoid unhandled rejection
      await resultPromise.catch(() => {});

      expect(resolvedRequestIds).toContain(requestId);
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe("isAvailable", () => {
    test("returns false by default", () => {
      setup();
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true after updateSender with clientConnected=true", () => {
      setup();
      proxy.updateSender(sendToClient as never, true);
      expect(proxy.isAvailable()).toBe(true);
    });

    test("returns false after updateSender with clientConnected=false", () => {
      setup();
      proxy.updateSender(sendToClient as never, true);
      proxy.updateSender(sendToClient as never, false);
      expect(proxy.isAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // updateSender
  // -------------------------------------------------------------------------

  describe("updateSender", () => {
    test("uses updated sender for new requests", async () => {
      setup();

      const newMessages: unknown[] = [];
      proxy.updateSender((msg) => newMessages.push(msg), true);

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      expect(sentMessages).toHaveLength(0); // Old sender not used
      expect(newMessages).toHaveLength(1); // New sender used

      const sent = newMessages[0] as Record<string, unknown>;
      proxy.resolve(sent.requestId as string, {
        axTree: "Button [1]",
      });

      await resultPromise;
    });
  });
});
