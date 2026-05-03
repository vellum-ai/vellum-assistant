import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
let mockHasClient = false;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_file" && mockHasClient ? { id: "mock-client" } : null,
  },
}));

// Use the REAL pending-interactions module — the proxy self-registers here.
const pendingInteractions = await import("../runtime/pending-interactions.js");
const { HostFileProxy } = await import("../daemon/host-file-proxy.js");

// Minimal PNG header
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

describe("HostFileProxy", () => {
  let proxy: InstanceType<typeof HostFileProxy>;

  function setup() {
    sentMessages.length = 0;
    mockHasClient = false;
    pendingInteractions.clear();
    proxy = new (HostFileProxy as any)();
  }

  afterEach(() => {
    proxy?.dispose();
    HostFileProxy.reset();
    pendingInteractions.clear();
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      // Simulate client response
      proxy.resolveResult(requestId, {
        content: "file contents here",
        isError: false,
      });

      const result = await resultPromise;
      expect(result.content).toBe("file contents here");
      expect(result.isError).toBe(false);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
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

      proxy.resolveResult(requestId, {
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

      proxy.resolveResult(requestId, {
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
      proxy.resolveResult(requestId, {
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
      proxy.resolveResult(requestId, {
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      // Resolve to avoid test hanging (actual 30s timeout too long for test)
      proxy.resolveResult(requestId, {
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
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
    test("returns false when no client with host_file capability is connected", () => {
      setup();
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true when a client with host_file capability is connected", () => {
      setup();
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.dispose();

      expect(pendingInteractions.get(requestId)).toBeUndefined();
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
      proxy.resolveResult(requestId, {
        content: "late response",
        isError: false,
      });

      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  describe("resolve with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw
      proxy.resolveResult("unknown-id", {
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
      proxy.resolveResult(requestId, {
        content: "file contents",
        isError: false,
      });
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
        expect(pendingInteractions.get(requestId)).toBeDefined();

        // Advance past the 30s internal timeout.
        jest.advanceTimersByTime(31 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("Host file proxy timed out");
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

  describe("pendingInteractions cleanup", () => {
    test("cleans up on abort", async () => {
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      controller.abort();
      await resultPromise;

      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("cleans up for each pending request on dispose", () => {
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

      const ids = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(ids).toHaveLength(2);
      expect(pendingInteractions.get(ids[0])).toBeDefined();
      expect(pendingInteractions.get(ids[1])).toBeDefined();

      proxy.dispose();

      expect(pendingInteractions.get(ids[0])).toBeUndefined();
      expect(pendingInteractions.get(ids[1])).toBeUndefined();
    });

    test("cleans up on normal client-initiated resolveResult", async () => {
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
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveResult(requestId, {
        content: "file contents",
        isError: false,
      });

      await resultPromise;
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });
});
