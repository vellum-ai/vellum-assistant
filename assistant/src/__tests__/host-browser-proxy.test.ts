import { afterEach, describe, expect, test } from "bun:test";

const { HostBrowserProxy } = await import("../daemon/host-browser-proxy.js");

describe("HostBrowserProxy", () => {
  let proxy: InstanceType<typeof HostBrowserProxy>;
  let sentMessages: unknown[];
  let sendToClient: (msg: unknown) => void;

  function setup(onInternalResolve?: (requestId: string) => void) {
    sentMessages = [];
    sendToClient = (msg: unknown) => sentMessages.push(msg);
    proxy = new HostBrowserProxy(sendToClient, onInternalResolve);
  }

  afterEach(() => {
    proxy?.dispose();
  });

  describe("request/resolve lifecycle (happy path)", () => {
    test("sends host_browser_request and resolves with content", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          cdpMethod: "Page.navigate",
          cdpParams: { url: "https://example.com" },
        },
        "session-1",
      );

      // Verify the request was sent to the client
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_browser_request");
      expect(sent.conversationId).toBe("session-1");
      expect(sent.cdpMethod).toBe("Page.navigate");
      expect(sent.cdpParams).toEqual({ url: "https://example.com" });
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Simulate client response
      proxy.resolve(requestId, {
        content: "ok",
        isError: false,
      });

      const result = await resultPromise;
      expect(result.content).toBe("ok");
      expect(result.isError).toBe(false);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });

    test("forwards cdpParams and cdpSessionId on the emitted envelope", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          cdpMethod: "Runtime.evaluate",
          cdpParams: { expression: "document.title", returnByValue: true },
          cdpSessionId: "session-abc",
        },
        "session-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_browser_request");
      expect(sent.cdpMethod).toBe("Runtime.evaluate");
      expect(sent.cdpParams).toEqual({
        expression: "document.title",
        returnByValue: true,
      });
      expect(sent.cdpSessionId).toBe("session-abc");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        content: "Example Domain",
        isError: false,
      });

      await resultPromise;
    });

    test("resolves error responses correctly", async () => {
      setup();

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "invalid://" } },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolve(requestId, {
        content: "Navigation failed",
        isError: true,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Navigation failed");
    });
  });

  describe("pending tracking", () => {
    test("hasPendingRequest returns true after request and false after resolve", async () => {
      setup();

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.resolve(requestId, { content: "ok", isError: false });

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      await resultPromise;
    });
  });

  describe("timeout", () => {
    test("resolves with timeout error when proxy timeout fires", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      const resultPromise = proxy.request(
        {
          cdpMethod: "Page.navigate",
          cdpParams: { url: "https://slow.test" },
          // Sub-second timeout to trigger the timer quickly.
          timeout_seconds: 0.01,
        },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Wait long enough for the timer (10ms) to fire.
      await new Promise((r) => setTimeout(r, 50));

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Host browser proxy timed out");
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      expect(resolvedIds).toEqual([requestId]);
    });
  });

  describe("abort signal", () => {
    test("returns immediately if signal already aborted", async () => {
      setup();

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        controller.signal,
      );

      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0); // No envelope emitted.
    });

    test("mid-flight abort resolves with Aborted and emits host_browser_cancel", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      const controller = new AbortController();
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
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

      // Second message should be the cancel envelope.
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_browser_cancel");
      expect(cancelMsg.requestId).toBe(requestId);

      // onInternalResolve should have been invoked.
      expect(resolvedIds).toEqual([requestId]);
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

  describe("updateSender", () => {
    test("uses updated sender for new requests", async () => {
      setup();

      const newMessages: unknown[] = [];
      proxy.updateSender((msg) => newMessages.push(msg), true);

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
      );

      expect(sentMessages).toHaveLength(0); // Old sender not used.
      expect(newMessages).toHaveLength(1); // New sender used.

      const sent = newMessages[0] as Record<string, unknown>;
      proxy.resolve(sent.requestId as string, {
        content: "ok",
        isError: false,
      });

      await resultPromise;
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests, emits cancels, invokes onInternalResolve", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      const p1 = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
      );
      const p2 = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://b.test" } },
        "session-1",
      );
      // Attach rejection handlers immediately so Bun doesn't flag the
      // promises as unhandled before the awaited assertions run.
      const p1Swallowed = p1.catch(() => {});
      const p2Swallowed = p2.catch(() => {});

      const requestIds = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(requestIds).toHaveLength(2);
      expect(proxy.hasPendingRequest(requestIds[0]!)).toBe(true);
      expect(proxy.hasPendingRequest(requestIds[1]!)).toBe(true);

      proxy.dispose();

      // Both pending requests should no longer be tracked.
      expect(proxy.hasPendingRequest(requestIds[0]!)).toBe(false);
      expect(proxy.hasPendingRequest(requestIds[1]!)).toBe(false);

      // Both promises should reject with AssistantError message.
      await expect(p1).rejects.toThrow("Host browser proxy disposed");
      await expect(p2).rejects.toThrow("Host browser proxy disposed");
      // Drain the swallowed copies so the unhandled-rejection guard clears.
      await p1Swallowed;
      await p2Swallowed;

      // After the 2 request messages, dispose should have sent 2 cancel messages.
      const cancelMessages = sentMessages
        .slice(2)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_browser_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[0]);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[1]);

      // onInternalResolve fired for each pending request on dispose.
      expect(resolvedIds).toHaveLength(2);
      expect(resolvedIds).toContain(requestIds[0]!);
      expect(resolvedIds).toContain(requestIds[1]!);
    });
  });

  describe("resolve with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw.
      proxy.resolve("nonexistent", {
        content: "stale",
        isError: false,
      });
    });
  });

  describe("sender throws synchronously", () => {
    test("rejects the promise, clears pending state and timer, invokes onInternalResolve", async () => {
      const resolvedIds: string[] = [];
      sentMessages = [];
      sendToClient = () => {
        throw new Error("transport down");
      };
      proxy = new HostBrowserProxy(sendToClient, (id) => resolvedIds.push(id));

      // request() synchronously calls sendToClient inside the Promise
      // executor. A throw there surfaces as a rejected promise.
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://x.test" } },
        "session-1",
      );

      await expect(resultPromise).rejects.toThrow("transport down");

      // No entries should have leaked into the pending map.
      // (We can't assert against a specific requestId because the sender
      // threw before any message was observed, so there's nothing to read
      // the id from. We can instead assert the internal resolve fired once
      // and that no pending entries remain for any id we issue next.)
      expect(resolvedIds).toHaveLength(1);

      // Issue a new request on a fresh (non-throwing) sender and verify
      // the proxy is still functional — no stale timers or bookkeeping
      // from the failed request.
      sentMessages = [];
      proxy.updateSender((msg) => sentMessages.push(msg), true);
      const okPromise = proxy.request(
        { cdpMethod: "Page.reload" },
        "session-1",
      );
      expect(sentMessages).toHaveLength(1);
      const okRequestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      expect(proxy.hasPendingRequest(okRequestId)).toBe(true);
      proxy.resolve(okRequestId, { content: "reloaded", isError: false });
      const okResult = await okPromise;
      expect(okResult.content).toBe("reloaded");
      expect(okResult.isError).toBe(false);
    });
  });
});
