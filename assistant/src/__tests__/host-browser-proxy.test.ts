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

/**
 * Per-test client roster used by the same-actor binding tests below.
 *
 * When non-empty, `listClientsByCapability` and `getActorPrincipalIdForClient`
 * read from this list. The legacy `mockHasConnection` boolean continues to
 * drive `getPreferredClientByCapability`, which is the fallback path used
 * when the caller has no `sourceActorPrincipalId` (legacy/internal flows).
 */
type MockClient = {
  clientId: string;
  interfaceId: "chrome-extension" | "macos";
  actorPrincipalId?: string;
  capabilities: string[];
};
let mockClients: MockClient[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async (event: unknown, _options?: unknown) => {
      publishedEvents.push(event);
    },
    getPreferredClientByCapability: (cap: string, _preference?: unknown) =>
      cap === "host_browser" && mockHasConnection
        ? {
            type: "client",
            clientId: "test-client",
            interfaceId: "macos",
            capabilities: ["host_browser"],
          }
        : undefined,
    listClientsByCapability: (cap: string) =>
      mockClients.filter((c) => c.capabilities.includes(cap)),
    getActorPrincipalIdForClient: (clientId: string) =>
      mockClients.find((c) => c.clientId === clientId)?.actorPrincipalId,
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
    mockClients = [];
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

  // ---------------------------------------------------------------------------
  // Same-actor binding (cross-user enforcement)
  //
  // When the caller does not supply `targetClientId`, the proxy auto-resolves
  // using `resolveTargetClient(sourceActorPrincipalId)` which filters clients
  // to the same actor before applying the interface-preference order:
  //
  //   1. `resolveTargetClient(sourceActorPrincipalId)` filters candidate
  //      clients to those owned by the caller's actor before applying the
  //      chrome-extension-first interface preference. When the caller has
  //      no actor (legacy/internal flow), it falls back to the legacy
  //      `getPreferredClientByCapability` path used by other tests above.
  //   2. The proxy persists `targetClientId` and `targetActorPrincipalId`
  //      on the pending interaction so the result-route's same-actor check
  //      has authoritative bindings to compare against (mirrors host-cu).
  //
  // These tests focus on (1) and (2). Result-side guard coverage lives in
  // `host-browser-routes.test.ts` (HTTP 400/403 against the same bindings).
  // ---------------------------------------------------------------------------

  describe("same-actor binding", () => {
    test("persists targetClientId + targetActorPrincipalId when caller actor matches", async () => {
      mockClients = [
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      const pending = pendingInteractions.get(requestId);
      expect(pending).toBeDefined();
      expect(pending?.targetClientId).toBe("ext-client");
      expect(pending?.targetActorPrincipalId).toBe("user-1");

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("rejects when only different-actor clients are connected", async () => {
      mockClients = [
        {
          clientId: "other-user-ext",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-2",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
      );

      // Auto-resolution filters out the cross-user candidate, so the
      // proxy falls into the existing "no active extension connection"
      // rejection — we never broadcast to a different actor's client.
      await expect(resultPromise).rejects.toThrow(
        "no active extension connection",
      );
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("prefers chrome-extension over macos among same-actor clients", async () => {
      mockClients = [
        {
          clientId: "macos-client",
          interfaceId: "macos",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      const pending = pendingInteractions.get(requestId);
      expect(pending?.targetClientId).toBe("ext-client");

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });

    test("falls back to macOS bridge when no chrome-extension is connected for the caller's actor", async () => {
      mockClients = [
        {
          clientId: "macos-client",
          interfaceId: "macos",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;

      const pending = pendingInteractions.get(requestId);
      expect(pending?.targetClientId).toBe("macos-client");
      expect(pending?.targetActorPrincipalId).toBe("user-1");

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });

    test("legacy callers without a sourceActorPrincipalId use the unfiltered fallback path", async () => {
      // No mockClients populated — but mockHasConnection is true, so the
      // legacy `getPreferredClientByCapability` branch returns its default
      // `test-client` candidate. The pending interaction binds to that
      // client without an actor, preserving prior single-user behavior.
      mockHasConnection = true;
      mockClients = [];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        // signal omitted
        // sourceActorPrincipalId omitted — legacy path
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;

      const pending = pendingInteractions.get(requestId);
      expect(pending?.targetClientId).toBe("test-client");
      expect(pending?.targetActorPrincipalId).toBeUndefined();

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });

    test("rejects when caller has actor but no host_browser-capable client is connected for that actor", async () => {
      // Same-user filter returns empty even though listClientsByCapability
      // would return a non-empty list (because that list is for a
      // different actor). The legacy fallback IS NOT consulted in this
      // branch — we don't want to silently broadcast to anyone.
      mockClients = [
        {
          clientId: "other-user-ext",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-99",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
      );

      await expect(resultPromise).rejects.toThrow(
        "no active extension connection",
      );
      expect(getPublishedMessages()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Explicit targetClientId routing
  //
  // When `targetClientId` is supplied, the proxy skips the interface-preference
  // sort and routes directly to the named client (subject to the same-actor
  // enforcement that runs on all host-proxy requests).
  // ---------------------------------------------------------------------------

  describe("explicit targetClientId routing", () => {
    test("routes to the named client and persists targetClientId in pending state", async () => {
      mockClients = [
        {
          clientId: "macos-client",
          interfaceId: "macos",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      // Explicitly target the macOS client even though chrome-extension
      // would win under normal interface-preference ordering.
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
        "macos-client",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const sent = getPublishedMessages()[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      const pending = pendingInteractions.get(requestId);
      expect(pending?.targetClientId).toBe("macos-client");

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("rejects when targetClientId does not match any connected client", async () => {
      mockClients = [
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
        "nonexistent-client",
      );

      await expect(resultPromise).rejects.toThrow(
        "no active extension connection",
      );
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("rejects when targetClientId points to a client without host_browser capability", async () => {
      // The client exists but is not in the host_browser roster, so
      // listClientsByCapability("host_browser") does not return it.
      mockClients = [
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_bash"],
        },
      ];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
        "ext-client",
      );

      await expect(resultPromise).rejects.toThrow(
        "no active extension connection",
      );
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("same-actor check rejects targetClientId that belongs to a different actor", async () => {
      mockClients = [
        {
          clientId: "other-user-ext",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-2",
          capabilities: ["host_browser"],
        },
      ];

      // actor user-1 explicitly targets user-2's client — same-actor gate
      // should fire and return an isError result (not reject the promise).
      const result = await proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
        "other-user-ext",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Submitting actor does not match");
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("no targetClientId falls back to interface-preference order (regression guard)", async () => {
      mockClients = [
        {
          clientId: "macos-client",
          interfaceId: "macos",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
        {
          clientId: "ext-client",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-1",
          capabilities: ["host_browser"],
        },
      ];

      // No targetClientId — should auto-resolve to chrome-extension (higher priority).
      const resultPromise = proxy.request(
        { cdpMethod: "Page.navigate", cdpParams: { url: "https://a.test" } },
        "session-1",
        undefined,
        "user-1",
        // targetClientId omitted
      );

      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;
      const pending = pendingInteractions.get(requestId);
      expect(pending?.targetClientId).toBe("ext-client");

      proxy.resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });
  });
});
