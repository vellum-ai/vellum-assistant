import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/** Events published through the mock event hub. */
let publishedEvents: unknown[] = [];
let mockHasConnection = true;

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async (event: unknown, _options?: unknown) => {
      publishedEvents.push(event);
    },
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_browser" && mockHasConnection
        ? {
            type: "client",
            clientId: "test-client",
            interfaceId: "macos",
            capabilities: ["host_browser"],
          }
        : undefined,
  },
  broadcastMessage: (msg: unknown) => {
    publishedEvents.push(msg);
  },
}));

// ── Real imports (after mocks) ───────────────────────────────────────

const pendingInteractions = await import("../runtime/pending-interactions.js");
const { HostBrowserProxy } = await import("../daemon/host-browser-proxy.js");

/** Extract the ServerMessage payloads from published events. */
function getPublishedMessages(): unknown[] {
  return publishedEvents;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("HostBrowserProxy", () => {
  let proxy: InstanceType<typeof HostBrowserProxy>;

  beforeEach(() => {
    HostBrowserProxy.reset();
    pendingInteractions.clear();
    publishedEvents = [];
    mockHasConnection = true;
    proxy = HostBrowserProxy.instance;
  });

  afterEach(() => {
    HostBrowserProxy.reset();
    pendingInteractions.clear();
  });

  describe("request/resolve lifecycle (happy path)", () => {
    test("sends host_browser_request and resolves with content", async () => {
      const resultPromise = proxy.request(
        {
          cdpMethod: "Page.navigate",
          cdpParams: { url: "https://example.com" },
        },
        "session-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_browser_request");
      expect(sent.conversationId).toBe("session-1");
      expect(sent.cdpMethod).toBe("Page.navigate");
      expect(sent.cdpParams).toEqual({ url: "https://example.com" });
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveResult(requestId, { content: "ok", isError: false });

      const result = await resultPromise;
      expect(result.content).toBe("ok");
      expect(result.isError).toBe(false);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("forwards cdpParams and cdpSessionId on the emitted envelope", async () => {
      const resultPromise = proxy.request(
        {
          cdpMethod: "Runtime.evaluate",
          cdpParams: { expression: "document.title", returnByValue: true },
          cdpSessionId: "session-abc",
        },
        "session-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_browser_request");
      expect(sent.cdpMethod).toBe("Runtime.evaluate");
      expect(sent.cdpParams).toEqual({
        expression: "document.title",
        returnByValue: true,
      });
      expect(sent.cdpSessionId).toBe("session-abc");

      proxy.resolveResult(sent.requestId as string, {
        content: "Example Domain",
        isError: false,
      });

      await resultPromise;
    });

    test("resolves error responses correctly", async () => {
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "invalid://" } },
        "session-1",
      );

      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      proxy.resolveResult(sent.requestId as string, {
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
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
      );

      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveResult(requestId, { content: "ok", isError: false });

      expect(pendingInteractions.get(requestId)).toBeUndefined();
      await resultPromise;
    });
  });

  describe("timeout", () => {
    test("resolves with timeout error when proxy timeout fires", async () => {
      const resultPromise = proxy.request(
        {
          cdpMethod: "Page.navigate",
          cdpParams: { url: "https://slow.test" },
          timeout_seconds: 0.01,
        },
        "session-1",
      );

      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      await new Promise((r) => setTimeout(r, 50));

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Host browser proxy timed out");
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  describe("abort signal", () => {
    test("returns immediately if signal already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        controller.signal,
      );

      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("mid-flight abort resolves with Aborted and emits host_browser_cancel", async () => {
      const controller = new AbortController();
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        controller.signal,
      );

      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(pendingInteractions.get(requestId)).toBeUndefined();

      // Cancel envelope should have been sent.
      expect(getPublishedMessages()).toHaveLength(2);
      const cancelMsg = getPublishedMessages()[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_browser_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
    });
  });

  describe("isAvailable", () => {
    test("returns true when a connection exists in the registry", () => {
      mockHasConnection = true;
      expect(proxy.isAvailable()).toBe(true);
    });

    test("returns false when no connection exists", () => {
      mockHasConnection = false;
      expect(proxy.isAvailable()).toBe(false);
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests and emits cancels", async () => {
      const p1 = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
      );
      const p2 = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://b.test" } },
        "session-1",
      );
      const p1Swallowed = p1.catch(() => {});
      const p2Swallowed = p2.catch(() => {});

      const requestIds = (
        getPublishedMessages() as Array<Record<string, unknown>>
      ).map((m) => m.requestId as string);
      expect(requestIds).toHaveLength(2);

      proxy.dispose();

      expect(pendingInteractions.get(requestIds[0]!)).toBeUndefined();
      expect(pendingInteractions.get(requestIds[1]!)).toBeUndefined();

      await expect(p1).rejects.toThrow("Host browser proxy disposed");
      await expect(p2).rejects.toThrow("Host browser proxy disposed");
      await p1Swallowed;
      await p2Swallowed;

      const cancelMessages = getPublishedMessages()
        .slice(2)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_browser_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
    });
  });

  describe("resolve with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      proxy.resolveResult("nonexistent", { content: "stale", isError: false });
    });
  });

  describe("send failure", () => {
    test("rejects when no connection exists at send time", async () => {
      mockHasConnection = false;

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://x.test" } },
        "session-1",
      );

      await expect(resultPromise).rejects.toThrow(
        "no active extension connection",
      );
    });
  });

  describe("singleton", () => {
    test("instance always returns the same proxy", () => {
      const a = HostBrowserProxy.instance;
      const b = HostBrowserProxy.instance;
      expect(a).toBe(b);
    });

    test("reset() clears the singleton", () => {
      const before = HostBrowserProxy.instance;
      HostBrowserProxy.reset();
      const after = HostBrowserProxy.instance;
      expect(before).not.toBe(after);
    });
  });

  describe("abort listener lifecycle", () => {
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
      const controller = new AbortController();
      const spy = spySignal(controller.signal);

      const resultPromise = proxy.request(
        { cdpMethod: "Page.reload" },
        "session-1",
        spy.signal,
      );

      expect(spy.addCalls).toEqual(["abort"]);
      expect(spy.removeCalls).toEqual([]);

      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;
      proxy.resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;

      expect(spy.removeCalls).toEqual(["abort"]);

      controller.abort();
      expect(getPublishedMessages()).toHaveLength(1);
    });

    test("removes abort listener from signal after dispose", () => {
      const controller = new AbortController();
      const spy = spySignal(controller.signal);

      const p = proxy.request(
        { cdpMethod: "Page.reload" },
        "session-1",
        spy.signal,
      );
      p.catch(() => {});

      proxy.dispose();

      expect(spy.removeCalls).toEqual(["abort"]);
    });
  });
});
