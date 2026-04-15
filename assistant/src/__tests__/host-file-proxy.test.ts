import { afterEach, describe, expect, jest, test } from "bun:test";

const { HostFileProxy } = await import("../daemon/host-file-proxy.js");

// Minimal PNG header
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

describe("HostFileProxy", () => {
  let proxy: InstanceType<typeof HostFileProxy>;
  let sentMessages: unknown[];
  let sendToClient: (msg: unknown) => void;

  function setup(onInternalResolve?: (requestId: string) => void) {
    sentMessages = [];
    sendToClient = (msg: unknown) => sentMessages.push(msg);
    proxy = new HostFileProxy(sendToClient, onInternalResolve);
  }

  afterEach(() => {
    proxy?.dispose();
  });

  describe("request/resolve lifecycle (happy path)", () => {
    test("sends host_file_request and resolves with content", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
      );

      // Verify the request was sent to the client
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_file_request");
      expect(sent.conversationId).toBe("session-1");
      expect(sent.operation).toBe("read");
      expect(sent.path).toBe("/tmp/test.txt");
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Simulate client response
      proxy.resolve(requestId, {
        content: "file contents here",
        isError: false,
      });

      const result = await resultPromise;
      expect(result.content).toBe("file contents here");
      expect(result.isError).toBe(false);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("resolves error responses correctly", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/nonexistent",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolve(requestId, {
        content: "ENOENT: no such file or directory",
        isError: true,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ENOENT");
    });

    test("rebuilds image tool results from proxied image payloads", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/Users/test/Desktop/screenshot.png",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolve(requestId, {
        content: "Image loaded on host",
        isError: false,
        imageData: PNG_HEADER.toString("base64"),
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Image loaded");
      expect(result.content).toContain("/Users/test/Desktop/screenshot.png");
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks?.[0]).toMatchObject({
        type: "image",
        source: {
          media_type: "image/png",
        },
      });
    });

    test("handles write operations", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "write",
          path: "/tmp/output.txt",
          content: "new content",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.operation).toBe("write");
      expect(sent.content).toBe("new content");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        content: "File written successfully",
        isError: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("handles edit operations", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "edit",
          path: "/tmp/file.txt",
          old_string: "foo",
          new_string: "bar",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.operation).toBe("edit");
      expect(sent.old_string).toBe("foo");
      expect(sent.new_string).toBe("bar");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        content: "Edit applied successfully",
        isError: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  describe("timeout", () => {
    test("tracks pending state before timeout fires", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/slow.txt",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Resolve to avoid test hanging (actual 30s timeout too long for test)
      proxy.resolve(requestId, {
        content: "",
        isError: false,
      });

      await resultPromise;
    });
  });

  describe("abort signal", () => {
    test("resolves with abort result when signal fires", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("sends host_file_cancel to client on abort", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      controller.abort();
      await resultPromise;

      // Second message should be the cancel
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_file_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
    });

    test("returns immediately if signal already aborted", async () => {
      setup();

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
        controller.signal,
      );

      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0); // No message sent
    });
  });

  describe("isAvailable", () => {
    test("returns false by default (no client connected)", () => {
      setup();
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true after updateSender with clientConnected=true", () => {
      setup();
      proxy.updateSender(sendToClient, true);
      expect(proxy.isAvailable()).toBe(true);
    });

    test("returns false after updateSender with clientConnected=false", () => {
      setup();
      proxy.updateSender(sendToClient, true);
      expect(proxy.isAvailable()).toBe(true);
      proxy.updateSender(sendToClient, false);
      expect(proxy.isAvailable()).toBe(false);
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests", () => {
      setup();

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.dispose();

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      expect(resultPromise).rejects.toThrow("Host file proxy disposed");
    });

    test("sends host_file_cancel for each pending request on dispose", () => {
      setup();

      const p1 = proxy.request(
        { operation: "read", path: "/tmp/a.txt" },
        "session-1",
      );
      const p2 = proxy.request(
        { operation: "read", path: "/tmp/b.txt" },
        "session-1",
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
          (m) => (m as Record<string, unknown>).type === "host_file_cancel",
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
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      controller.abort();
      const result = await resultPromise;
      expect(result.content).toBe("Aborted");

      // Late resolve should be silently ignored (no throw, no double-resolve)
      proxy.resolve(requestId, {
        content: "late response",
        isError: false,
      });

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });
  });

  describe("updateSender", () => {
    test("uses updated sender for new requests", async () => {
      setup();

      const newMessages: unknown[] = [];
      proxy.updateSender((msg) => newMessages.push(msg), true);

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
      );

      expect(sentMessages).toHaveLength(0); // Old sender not used
      expect(newMessages).toHaveLength(1); // New sender used

      const sent = newMessages[0] as Record<string, unknown>;
      proxy.resolve(sent.requestId as string, {
        content: "updated content",
        isError: false,
      });

      await resultPromise;
    });
  });

  describe("resolve with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw
      proxy.resolve("unknown-id", {
        content: "",
        isError: false,
      });
    });
  });

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
      s.addEventListener = (
        type: string,

        ...rest: any[]
      ) => {
        addCalls.push(type);

        return (origAdd as any)(type, ...rest);
      };
      s.removeEventListener = (
        type: string,

        ...rest: any[]
      ) => {
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
        { operation: "read", path: "/tmp/test.txt" },
        "session-1",
        spy.signal,
      );

      expect(spy.addCalls).toEqual(["abort"]);
      expect(spy.removeCalls).toEqual([]);

      const requestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      proxy.resolve(requestId, { content: "file contents", isError: false });
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
          { operation: "read", path: "/tmp/slow.txt" },
          "session-1",
          spy.signal,
        );

        expect(spy.addCalls).toEqual(["abort"]);
        expect(spy.removeCalls).toEqual([]);

        const requestId = (sentMessages[0] as Record<string, unknown>)
          .requestId as string;
        expect(proxy.hasPendingRequest(requestId)).toBe(true);

        // Advance past the 30s internal timeout.
        jest.advanceTimersByTime(31 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("Host file proxy timed out");
        expect(proxy.hasPendingRequest(requestId)).toBe(false);

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

  describe("sender throws synchronously", () => {
    test("rejects the promise, clears pending state and timer, invokes onInternalResolve", async () => {
      const resolvedIds: string[] = [];
      sentMessages = [];
      sendToClient = () => {
        throw new Error("transport down");
      };
      proxy = new HostFileProxy(sendToClient, (id) => resolvedIds.push(id));

      const resultPromise = proxy.request(
        { operation: "read", path: "/tmp/test.txt" },
        "session-1",
      );

      await expect(resultPromise).rejects.toThrow("transport down");

      // The internal resolve should fire exactly once as part of cleanup.
      expect(resolvedIds).toHaveLength(1);

      // Issue a new request on a fresh (non-throwing) sender and verify
      // the proxy is still functional — no stale timers or bookkeeping
      // from the failed request.
      sentMessages = [];
      proxy.updateSender((msg) => sentMessages.push(msg), true);
      const okPromise = proxy.request(
        { operation: "read", path: "/tmp/ok.txt" },
        "session-1",
      );
      expect(sentMessages).toHaveLength(1);
      const okRequestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      expect(proxy.hasPendingRequest(okRequestId)).toBe(true);
      proxy.resolve(okRequestId, { content: "ok", isError: false });
      const okResult = await okPromise;
      expect(okResult.content).toBe("ok");
      expect(okResult.isError).toBe(false);
    });
  });

  describe("onInternalResolve callback", () => {
    test("fires on abort", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      const controller = new AbortController();
      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      controller.abort();
      await resultPromise;

      expect(resolvedIds).toEqual([requestId]);
    });

    test("fires for each pending request on dispose", () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      // Create two pending requests and catch rejections from dispose
      const p1 = proxy.request(
        {
          operation: "read",
          path: "/tmp/a.txt",
        },
        "session-1",
      );
      const p2 = proxy.request(
        {
          operation: "read",
          path: "/tmp/b.txt",
        },
        "session-1",
      );
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const ids = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(ids).toHaveLength(2);

      proxy.dispose();

      expect(resolvedIds).toHaveLength(2);
      expect(resolvedIds).toContain(ids[0]);
      expect(resolvedIds).toContain(ids[1]);
    });

    test("does not fire on normal client-initiated resolve", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      // Normal resolve from client — should NOT trigger onInternalResolve
      proxy.resolve(requestId, {
        content: "file contents",
        isError: false,
      });

      await resultPromise;
      expect(resolvedIds).toEqual([]);
    });
  });
});
