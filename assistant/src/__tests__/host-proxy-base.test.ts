import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
const resolvedInteractionIds: string[] = [];
let mockHasClient = false;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_cu" && mockHasClient ? { id: "mock-client" } : null,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  resolve: (requestId: string) => {
    resolvedInteractionIds.push(requestId);
    return undefined;
  },
  get: () => undefined,
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

const { HostProxyBase, HostProxyRequestError } =
  await import("../daemon/host-proxy-base.js");

interface TestRequest {
  payload: string;
}

interface TestResultPayload {
  result: string;
}

class TestProxy extends HostProxyBase<TestRequest, TestResultPayload> {
  constructor(timeoutMs?: number) {
    super({
      capabilityName: "host_cu",
      requestEventName: "test_request",
      cancelEventName: "test_cancel",
      resultPendingKind: "host_cu",
      timeoutMs,
      disposedMessage: "Test proxy disposed",
    });
  }

  // Re-expose the protected `dispatchRequest` so the tests can drive it directly.
  send(
    toolName: string,
    input: TestRequest,
    conversationId: string,
    signal?: AbortSignal,
    extraFields?: Record<string, unknown>,
  ): Promise<TestResultPayload> {
    return this.dispatchRequest(
      toolName,
      input,
      conversationId,
      signal,
      extraFields,
    );
  }
}

describe("HostProxyBase", () => {
  let proxy: TestProxy;

  function setup(timeoutMs?: number) {
    sentMessages.length = 0;
    resolvedInteractionIds.length = 0;
    mockHasClient = false;
    proxy = new TestProxy(timeoutMs);
  }

  afterEach(() => {
    proxy?.dispose();
  });

  describe("request lifecycle", () => {
    test("broadcasts the configured envelope and resolves on resolve()", async () => {
      setup();

      const promise = proxy.send("tool-1", { payload: "hello" }, "conv-1");

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("test_request");
      expect(sent.conversationId).toBe("conv-1");
      expect(sent.toolName).toBe("tool-1");
      expect(sent.input).toEqual({ payload: "hello" });
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.resolve(requestId, { result: "ok" });

      await expect(promise).resolves.toEqual({ result: "ok" });
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("merges extraFields into the broadcast envelope", async () => {
      setup();

      const promise = proxy.send(
        "tool-1",
        { payload: "hi" },
        "conv-1",
        undefined,
        { stepNumber: 7, reasoning: "because" },
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.stepNumber).toBe(7);
      expect(sent.reasoning).toBe("because");
      expect(sent.input).toEqual({ payload: "hi" }); // input not nested under extras

      // Resolve so afterEach.dispose() doesn't see an orphan pending request.
      proxy.resolve(sent.requestId as string, { result: "ok" });
      await promise;
    });

    test("resolve with unknown requestId is silently ignored", () => {
      setup();
      // Should not throw
      proxy.resolve("unknown-id", { result: "late" });
    });
  });

  describe("timeout", () => {
    test("rejects with HostProxyRequestError(reason='timeout') after timeoutMs", async () => {
      setup();

      jest.useFakeTimers();
      try {
        const promise = proxy.send("tool-1", { payload: "x" }, "conv-1");
        const requestId = (sentMessages[0] as Record<string, unknown>)
          .requestId as string;
        expect(proxy.hasPendingRequest(requestId)).toBe(true);

        // Default timeout is 60s.
        jest.advanceTimersByTime(61 * 1000);

        await expect(promise).rejects.toBeInstanceOf(HostProxyRequestError);
        await expect(promise).rejects.toMatchObject({ reason: "timeout" });
        expect(proxy.hasPendingRequest(requestId)).toBe(false);
        expect(resolvedInteractionIds).toContain(requestId);
      } finally {
        jest.useRealTimers();
      }
    });

    test("respects custom timeoutMs", async () => {
      setup(10);

      jest.useFakeTimers();
      try {
        const promise = proxy.send("tool-1", { payload: "x" }, "conv-1");
        jest.advanceTimersByTime(11);

        await expect(promise).rejects.toMatchObject({ reason: "timeout" });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("abort signal", () => {
    test("broadcasts cancel envelope and rejects with reason='aborted'", async () => {
      setup();

      const controller = new AbortController();
      const promise = proxy.send(
        "tool-1",
        { payload: "x" },
        "conv-1",
        controller.signal,
      );

      const requestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;

      controller.abort();

      await expect(promise).rejects.toMatchObject({ reason: "aborted" });

      // Second message should be the cancel envelope.
      expect(sentMessages).toHaveLength(2);
      const cancel = sentMessages[1] as Record<string, unknown>;
      expect(cancel.type).toBe("test_cancel");
      expect(cancel.requestId).toBe(requestId);
      expect(cancel.conversationId).toBe("conv-1");

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      expect(resolvedInteractionIds).toContain(requestId);
    });

    test("removes abort listener after normal resolve", async () => {
      setup();

      const controller = new AbortController();
      const removeCalls: string[] = [];
      const origRemove = controller.signal.removeEventListener.bind(
        controller.signal,
      );
      (controller.signal as any).removeEventListener = (
        type: string,
        ...rest: any[]
      ) => {
        removeCalls.push(type);
        return (origRemove as any)(type, ...rest);
      };

      const promise = proxy.send(
        "tool-1",
        { payload: "x" },
        "conv-1",
        controller.signal,
      );

      const requestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      proxy.resolve(requestId, { result: "ok" });
      await promise;

      expect(removeCalls).toEqual(["abort"]);

      // Late aborts must be no-ops with no extra envelopes emitted.
      controller.abort();
      expect(sentMessages).toHaveLength(1);
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests with reason='disposed'", async () => {
      setup();

      const p1 = proxy.send("t1", { payload: "1" }, "conv-1");
      const p2 = proxy.send("t2", { payload: "2" }, "conv-1");

      // Suppress unhandled rejection noise — we assert below.
      p1.catch(() => {});
      p2.catch(() => {});

      const beforeIds = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(beforeIds).toHaveLength(2);

      proxy.dispose();

      await expect(p1).rejects.toBeInstanceOf(HostProxyRequestError);
      await expect(p1).rejects.toMatchObject({
        reason: "disposed",
        message: "Test proxy disposed",
      });
      await expect(p2).rejects.toMatchObject({ reason: "disposed" });

      // Cancel envelopes broadcast for each pending request.
      const cancelMessages = sentMessages
        .slice(2)
        .filter(
          (m) => (m as Record<string, unknown>).type === "test_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
      const cancelIds = cancelMessages.map((m) => m.requestId as string);
      expect(cancelIds).toEqual(expect.arrayContaining(beforeIds));

      // pendingInteractions notified for each pending request.
      for (const id of beforeIds) {
        expect(resolvedInteractionIds).toContain(id);
      }
    });

    test("clears all timers on dispose", async () => {
      setup();

      jest.useFakeTimers();
      try {
        const p = proxy.send("t1", { payload: "1" }, "conv-1");
        p.catch(() => {});

        proxy.dispose();

        // Advance well past the default timeout — no extra rejection or log
        // should fire because the timer was cleared.
        jest.advanceTimersByTime(120 * 1000);

        await expect(p).rejects.toMatchObject({ reason: "disposed" });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("isAvailable", () => {
    test("returns false when no client with the configured capability is connected", () => {
      setup();
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true when a client with the configured capability is connected", () => {
      setup();
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
    });
  });
});
