import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
let mockHasClient = false;
type MockClient = {
  clientId: string;
  capabilities: string[];
  actorPrincipalId?: string;
};
let mockClients: MockClient[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_cu" && mockHasClient ? { id: "mock-client" } : null,
    getClientById: (id: string) =>
      mockClients.find((c) => c.clientId === id) ?? undefined,
    getActorPrincipalIdForClient: (id: string) =>
      mockClients.find((c) => c.clientId === id)?.actorPrincipalId,
  },
}));

// Use the REAL pending-interactions module — the proxy self-registers here.
const pendingInteractions = await import("../runtime/pending-interactions.js");
const { HostCuProxy } = await import("../daemon/host-cu-proxy.js");

describe("HostCuProxy", () => {
  let proxy: InstanceType<typeof HostCuProxy>;

  function setup(maxSteps?: number) {
    sentMessages.length = 0;
    mockHasClient = false;
    mockClients = [];
    pendingInteractions.clear();
    proxy = new HostCuProxy(maxSteps);
  }

  afterEach(() => {
    proxy?.dispose();
    pendingInteractions.clear();
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
      expect(sent.conversationId).toBe("session-1");
      expect(sent.toolName).toBe("computer_use_click");
      expect(sent.input).toEqual({ element_id: 42 });
      expect(sent.stepNumber).toBe(1);
      expect(sent.reasoning).toBe("Clicking the button");
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.processObservation(requestId, {
        axTree: "Button [1]\nLabel [2]",
        executionResult: "Clicked element 42",
      });

      const result = await resultPromise;
      expect(result.content).toContain("Clicked element 42");
      expect(result.content).toContain("<ax-tree>");
      expect(result.content).toContain("CURRENT SCREEN STATE:");
      expect(result.isError).toBe(false);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
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

      proxy.processObservation(requestId, {
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

      proxy.processObservation(requestId, {
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
      proxy.processObservation("unknown-id", { axTree: "something" });
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      // Resolve to avoid test hanging
      proxy.processObservation(requestId, { axTree: "resolved" });
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toContain("Aborted");
      expect(result.isError).toBe(true);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("sends host_cu_cancel to client on abort", async () => {
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

      // Second message should be the cancel
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_cu_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
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
      proxy.processObservation(sent.requestId as string, { axTree: "screen" });

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
      proxy.processObservation(sent1.requestId as string, {
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
      proxy.processObservation(sent2.requestId as string, {
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
      proxy.processObservation(sent3.requestId as string, {
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
      proxy.processObservation(sent1.requestId as string, {
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
      proxy.processObservation(sent1.requestId as string, {
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
      proxy.processObservation(sent2.requestId as string, {
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
      proxy.processObservation(sent1.requestId as string, {
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
      proxy.processObservation(sent2.requestId as string, {
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
      proxy.processObservation(sent3.requestId as string, {
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.dispose();

      expect(pendingInteractions.get(requestId)).toBeUndefined();
      await expect(resultPromise).rejects.toThrow("Host CU proxy disposed");
    });

    test("sends host_cu_cancel for each pending request on dispose", () => {
      setup();

      const p1 = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );
      const p2 = proxy.request(
        "computer_use_type_text",
        { text: "hello" },
        "session-1",
        2,
      );
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const requestIds = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(requestIds).toHaveLength(2);

      proxy.dispose();

      // After the 2 request messages, dispose should have sent 2 cancel messages
      const cancelMessages = sentMessages
        .slice(2)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_cu_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[0]);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[1]);
    });
  });

  describe("late resolve after abort", () => {
    test("resolve is a no-op after abort (entry already deleted)", async () => {
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
      const result = await resultPromise;
      expect(result.content).toContain("Aborted");

      // Late resolve should be silently ignored (no throw, no double-resolve)
      proxy.processObservation(requestId, { axTree: "late response" });

      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // abort listener lifecycle
  // -------------------------------------------------------------------------

  describe("abort listener lifecycle", () => {
    // Helper that wraps an AbortSignal to observe add/removeEventListener
    // invocations without tripping over tsc's strict overload matching on
    // AbortSignal itself.
    type Spied = {
      signal: AbortSignal;
      addCalls: string[];
      removeCalls: string[];
    };
    function spySignal(source: AbortSignal): Spied {
      const addCalls: string[] = [];
      const removeCalls: string[] = [];
      const s = source as any;
      const origAdd = source.addEventListener.bind(source);
      const origRemove = source.removeEventListener.bind(source);
      s.addEventListener = (type: string, ...rest: any[]) => {
        addCalls.push(type);
        return (origAdd as any)(type, ...rest);
      };
      s.removeEventListener = (type: string, ...rest: any[]) => {
        removeCalls.push(type);
        return (origRemove as any)(type, ...rest);
      };
      return { signal: source, addCalls, removeCalls };
    }

    test("removes abort listener from signal after resolve completes", async () => {
      setup();
      const controller = new AbortController();
      const spy = spySignal(controller.signal);

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        spy.signal,
      );

      expect(spy.addCalls).toEqual(["abort"]);
      expect(spy.removeCalls).toEqual([]);

      const requestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      proxy.processObservation(requestId, { axTree: "Button [1]" });
      await resultPromise;

      // Listener is detached after normal completion.
      expect(spy.removeCalls).toEqual(["abort"]);

      // Subsequent aborts are harmless no-ops (no side effects on the proxy).
      controller.abort();
      // No additional emitted envelopes from the late abort.
      expect(sentMessages).toHaveLength(1);
    });

    test("removes abort listener from signal on timer timeout", async () => {
      setup();

      jest.useFakeTimers();
      try {
        const controller = new AbortController();
        const spy = spySignal(controller.signal);

        const resultPromise = proxy.request(
          "computer_use_click",
          { element_id: 1 },
          "session-1",
          1,
          undefined,
          spy.signal,
        );

        expect(spy.addCalls).toEqual(["abort"]);
        expect(spy.removeCalls).toEqual([]);

        const requestId = (sentMessages[0] as Record<string, unknown>)
          .requestId as string;
        expect(pendingInteractions.get(requestId)).toBeDefined();

        // Advance past the 60s internal timeout.
        jest.advanceTimersByTime(61 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("Host CU proxy timed out");
        expect(pendingInteractions.get(requestId)).toBeUndefined();

        // Listener is detached after the timer fires.
        expect(spy.removeCalls).toEqual(["abort"]);

        // Subsequent aborts should be harmless — no cancel emitted.
        controller.abort();
        expect(sentMessages).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // pendingInteractions.resolve callback
  // -------------------------------------------------------------------------

  describe("pendingInteractions.resolve callback", () => {
    test("fires when abort signal fires", async () => {
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
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("fires on dispose", async () => {
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

      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("does not fire on normal client-initiated resolve", async () => {
      setup();

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.processObservation(requestId, { axTree: "Button [1]" });

      await resultPromise;
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe("isAvailable", () => {
    test("returns false when no client with host_cu capability is connected", () => {
      setup();
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true when a client with host_cu capability is connected", () => {
      setup();
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // targetClientId validation
  //
  // The surfaceProxyResolver layer validates first (so an invalid ID does
  // not burn a step or pollute action history — see cu-unified-flow.test.ts
  // for those tests). The proxy ALSO validates internally because it is
  // exposed as a separately-callable API; these tests exercise that
  // backstop along with the same-user enforcement.
  // -------------------------------------------------------------------------

  describe("targetClientId validation", () => {
    test("rejects when targetClientId does not match any connected client", async () => {
      setup();
      mockClients = [
        {
          clientId: "real-client",
          capabilities: ["host_cu"],
          actorPrincipalId: "user-1",
        },
      ];

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "ghost-client",
        "user-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("ghost-client");
      expect(result.content).toContain("host_cu");
      expect(sentMessages).toHaveLength(0);
    });

    test("rejects when target client lacks host_cu capability", async () => {
      setup();
      mockClients = [
        {
          clientId: "no-cu-client",
          capabilities: ["host_bash"],
          actorPrincipalId: "user-1",
        },
      ];

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "no-cu-client",
        "user-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not support host_cu");
      expect(sentMessages).toHaveLength(0);
    });

    test("succeeds when caller and target share the same actor principal", async () => {
      setup();
      mockClients = [
        {
          clientId: "cu-client",
          capabilities: ["host_cu"],
          actorPrincipalId: "user-1",
        },
      ];

      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "cu-client",
        "user-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_cu_request");
      expect(sent.targetClientId).toBe("cu-client");

      proxy.processObservation(sent.requestId as string, { axTree: "ok" });
      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("rejects cross-user targeted request", async () => {
      setup();
      mockClients = [
        {
          clientId: "cu-client",
          capabilities: ["host_cu"],
          actorPrincipalId: "user-2",
        },
      ];

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "cu-client",
        "user-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "Submitting actor does not match the target client's actor",
      );
      expect(sentMessages).toHaveLength(0);
    });

    test("rejects when source actor principal is missing", async () => {
      setup();
      mockClients = [
        {
          clientId: "cu-client",
          capabilities: ["host_cu"],
          actorPrincipalId: "user-1",
        },
      ];

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "cu-client",
        // sourceActorPrincipalId omitted
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "Submitting actor does not match the target client's actor",
      );
      expect(sentMessages).toHaveLength(0);
    });

    test("rejects when target actor principal is missing", async () => {
      setup();
      mockClients = [
        {
          clientId: "cu-client",
          capabilities: ["host_cu"],
          // actorPrincipalId omitted
        },
      ];

      const result = await proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
        undefined,
        undefined,
        "cu-client",
        "user-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "Submitting actor does not match the target client's actor",
      );
      expect(sentMessages).toHaveLength(0);
    });

    test("untargeted request bypasses same-user check", async () => {
      setup();
      // No targetClientId, no sourceActorPrincipalId — flow proceeds.
      const resultPromise = proxy.request(
        "computer_use_click",
        { element_id: 1 },
        "session-1",
        1,
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_cu_request");
      expect(sent.targetClientId).toBeUndefined();

      proxy.processObservation(sent.requestId as string, { axTree: "ok" });
      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });
});
