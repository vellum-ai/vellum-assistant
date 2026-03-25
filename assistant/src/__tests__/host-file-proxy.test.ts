import { afterEach, describe, expect, test } from "bun:test";

const { HostFileProxy } = await import("../daemon/host-file-proxy.js");

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
