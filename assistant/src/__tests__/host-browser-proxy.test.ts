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

/**
 * Per-test client roster. Drives `listClientsByCapability` and
 * `getMostRecentClientByCapability` — the two hub methods the proxy
 * uses for client resolution. Order matters: the first entry whose
 * capabilities include the requested cap is the "most recent", which
 * matches the production `listClientsByCapability` contract of
 * returning clients in `lastActiveAt`-desc order.
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
      // `interaction_resolved` envelopes are emitted by the
      // pending-interactions tracker for every resolution. They are
      // orthogonal to the host-browser wire messages these tests assert
      // on, so swallow them here.
      if ((event as { type?: string } | null)?.type === "interaction_resolved") {
        return;
      }
      publishedEvents.push(event);
    },
    getMostRecentClientByCapability: (cap: string) =>
      mockClients.find((c) => c.capabilities.includes(cap)),
    listClientsByCapability: (cap: string) =>
      mockClients.filter((c) => c.capabilities.includes(cap)),
    listClientsByInterface: (interfaceId: string) =>
      mockClients.filter((c) => c.interfaceId === interfaceId),
    getActorPrincipalIdForClient: (clientId: string) =>
      mockClients.find((c) => c.clientId === clientId)?.actorPrincipalId,
  },
  broadcastMessage: (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === "interaction_resolved") {
      return;
    }
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

/**
 * Simulate the HTTP route resolving a host_browser result. Mirrors what
 * `resolveHostBrowserResultByRequestId` does after its guards pass: consume
 * the pending interaction and invoke `rpcResolve` with the response.
 */
function resolveResult(
  requestId: string,
  response: { content: string; isError: boolean },
): void {
  const interaction = pendingInteractions.resolve(requestId);
  interaction?.rpcResolve?.(response);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("HostBrowserProxy", () => {
  let proxy: InstanceType<typeof HostBrowserProxy>;

  /**
   * A single anonymous host_browser client, used as the default fixture
   * for tests that don't care about actor identity.
   */
  const DEFAULT_CLIENT: MockClient = {
    clientId: "test-client",
    interfaceId: "macos",
    capabilities: ["host_browser"],
  };

  beforeEach(() => {
    HostBrowserProxy.reset();
    pendingInteractions.clear();
    publishedEvents = [];
    mockClients = [DEFAULT_CLIENT];
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

      resolveResult(requestId, { content: "ok", isError: false });

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

      resolveResult(sent.requestId as string, {
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
      resolveResult(sent.requestId as string, {
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

      resolveResult(requestId, { content: "ok", isError: false });

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
      mockClients = [DEFAULT_CLIENT];
      expect(proxy.isAvailable()).toBe(true);
    });

    test("returns false when no connection exists", () => {
      mockClients = [];
      expect(proxy.isAvailable()).toBe(false);
    });
  });

  describe("actor-scoped availability", () => {
    const EXT_A: MockClient = {
      clientId: "ext-a",
      interfaceId: "chrome-extension",
      actorPrincipalId: "actor-a",
      capabilities: ["host_browser"],
    };
    const BRIDGE_B: MockClient = {
      clientId: "bridge-b",
      interfaceId: "macos",
      actorPrincipalId: "actor-b",
      capabilities: ["host_browser"],
    };

    test("isAvailable(actor) only counts that actor's clients", () => {
      mockClients = [EXT_A, BRIDGE_B];
      expect(proxy.isAvailable("actor-a")).toBe(true);
      expect(proxy.isAvailable("actor-b")).toBe(true);
      expect(proxy.isAvailable("actor-c")).toBe(false);
      // Legacy no-actor form still counts any client.
      expect(proxy.isAvailable()).toBe(true);
    });

    test("hasExtensionClient(actor) ignores other actors' extensions", () => {
      mockClients = [EXT_A, BRIDGE_B];
      expect(proxy.hasExtensionClient("actor-a")).toBe(true);
      // actor-b has only the bridge — actor-a's extension must not count.
      expect(proxy.hasExtensionClient("actor-b")).toBe(false);
      expect(proxy.hasExtensionClient()).toBe(true);
    });

    test("hasExtensionClient(actor) is false for a client without an actor binding", () => {
      // Strict matching mirrors resolveTargetClient: a legacy extension
      // connection without an actor is not dispatchable for an
      // actor-authenticated caller, so it must not count as available.
      mockClients = [
        {
          clientId: "legacy-ext",
          interfaceId: "chrome-extension",
          capabilities: ["host_browser"],
        },
      ];
      expect(proxy.hasExtensionClient("actor-a")).toBe(false);
      expect(proxy.hasExtensionClient()).toBe(true);
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
      resolveResult("nonexistent", { content: "stale", isError: false });
    });
  });

  describe("send failure", () => {
    test("rejects when no connection exists at send time", async () => {
      mockClients = [];

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
      resolveResult(requestId, { content: "ok", isError: false });
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
  // When the caller does not supply `targetClientId`, the proxy auto-
  // resolves using `resolveTargetClient(sourceActorPrincipalId)`:
  //
  //   1. Candidate clients are filtered to those owned by the caller's
  //      actor; the first match (lastActiveAt-desc) wins. When the
  //      caller has no actor, the resolver falls through to the most-
  //      recently-active host_browser client without same-actor filtering.
  //   2. The proxy persists `targetClientId` and `targetActorPrincipalId`
  //      on the pending interaction so the result-route's same-actor
  //      check has authoritative bindings to compare against (mirrors
  //      host-cu).
  //
  // These tests focus on (1) and (2). Result-side guard coverage lives
  // in `host-browser-routes.test.ts` (HTTP 400/403 against the same
  // bindings).
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

      resolveResult(requestId, { content: "ok", isError: false });
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

    test("prefers the chrome-extension client over a more-recently-active macOS bridge", async () => {
      // Mock `listClientsByCapability` returns mockClients in array
      // order, which mirrors production's `lastActiveAt`-desc ordering.
      // The macOS bridge is listed first (most recent heartbeat), but
      // chrome-extension clients are deterministically preferred for
      // auto-resolution; LLMs pin the bridge via `target_client_id`.
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

      resolveResult(requestId, { content: "ok", isError: false });
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

      resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });

    test("legacy callers without a sourceActorPrincipalId fall through to the most-recently-active client", async () => {
      // No `sourceActorPrincipalId` supplied — the proxy falls back to
      // the unfiltered roster and picks the first entry. Mirrors the
      // singleton-style behavior expected by registry-driven callers
      // that haven't been threaded with an actor identity. The pending
      // interaction binds to the resolved client without an actor.
      mockClients = [DEFAULT_CLIENT];

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

      resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });

    test("rejects when caller has actor but no host_browser-capable client is connected for that actor", async () => {
      // Same-user filter returns empty even though listClientsByCapability
      // would return a non-empty list (because that list is for a
      // different actor). The unfiltered fallback path runs only when
      // the caller has no actor — we don't silently broadcast to anyone
      // when the caller IS authenticated to a specific actor.
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
  // When `targetClientId` is supplied, the proxy skips auto-resolution
  // and routes directly to the named client (subject to the same-actor
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

      // Explicitly target the macOS client even though it isn't the
      // first entry in the roster — explicit targeting overrides
      // auto-resolution.
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

      resolveResult(requestId, { content: "ok", isError: false });
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

    test("no targetClientId auto-resolves with extension preferred over the bridge", async () => {
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

      // No targetClientId — auto-resolution partitions chrome-extension
      // clients ahead of other transports, then picks the first
      // same-actor entry (lastActiveAt-desc within each group).
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

      resolveResult(requestId, { content: "ok", isError: false });
      await resultPromise;
    });
  });

  // ---------------------------------------------------------------------------
  // Method-aware routing
  //
  // `Vellum.*` pseudo-methods are implemented only by the Chrome
  // extension dispatcher; the macOS bridge speaks raw CDP against
  // localhost:9222 and fails on all of them. Auto-resolution therefore
  // restricts pseudo-methods to chrome-extension clients and prefers
  // the extension over the bridge for raw CDP, instead of racing on
  // heartbeat-driven lastActiveAt ordering.
  // ---------------------------------------------------------------------------

  describe("method-aware routing", () => {
    const MACOS_CLIENT: MockClient = {
      clientId: "macos-client",
      interfaceId: "macos",
      actorPrincipalId: "user-1",
      capabilities: ["host_browser"],
    };
    const EXT_CLIENT: MockClient = {
      clientId: "ext-client",
      interfaceId: "chrome-extension",
      actorPrincipalId: "user-1",
      capabilities: ["host_browser"],
    };

    function expectExtensionRequired(result: {
      content: string;
      isError: boolean;
    }): void {
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content) as {
        code: string;
        message: string;
      };
      expect(parsed.code).toBe("extension_required");
      expect(parsed.message).toContain("Chrome extension");
    }

    test("pseudo-method routes to the extension even when the bridge is more recently active", async () => {
      mockClients = [MACOS_CLIENT, EXT_CLIENT];

      const resultPromise = proxy.request(
        { cdpMethod: "Vellum.listTabs", cdpParams: {} },
        "session-1",
        undefined,
        "user-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;
      expect(pendingInteractions.get(requestId)?.targetClientId).toBe(
        "ext-client",
      );

      resolveResult(requestId, { content: '{"tabs":[]}', isError: false });
      await resultPromise;
    });

    test("pseudo-method with only the macOS bridge connected resolves extension_required without broadcasting", async () => {
      mockClients = [MACOS_CLIENT];

      const result = await proxy.request(
        { cdpMethod: "Vellum.selectTab", cdpParams: { tabId: 42 } },
        "session-1",
        undefined,
        "user-1",
      );

      expectExtensionRequired(result);
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("pseudo-method with no clients resolves extension_required instead of the legacy rejection", async () => {
      mockClients = [];

      const result = await proxy.request(
        { cdpMethod: "Vellum.createTab", cdpParams: {} },
        "session-1",
      );

      expectExtensionRequired(result);
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("explicit targetClientId at the macOS bridge + pseudo-method resolves extension_required naming the interface", async () => {
      mockClients = [MACOS_CLIENT, EXT_CLIENT];

      const result = await proxy.request(
        { cdpMethod: "Vellum.closeTab", cdpParams: { tabId: 7 } },
        "session-1",
        undefined,
        "user-1",
        "macos-client",
      );

      expectExtensionRequired(result);
      const parsed = JSON.parse(result.content) as { message: string };
      expect(parsed.message).toContain('"macos"');
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("explicit targetClientId at the extension + pseudo-method dispatches normally", async () => {
      mockClients = [MACOS_CLIENT, EXT_CLIENT];

      const resultPromise = proxy.request(
        { cdpMethod: "Vellum.closeTab", cdpParams: { tabId: 7 } },
        "session-1",
        undefined,
        "user-1",
        "ext-client",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;
      expect(pendingInteractions.get(requestId)?.targetClientId).toBe(
        "ext-client",
      );

      resolveResult(requestId, {
        content: '{"closed":true,"tabId":7}',
        isError: false,
      });
      await resultPromise;
    });

    test("same-actor gate wins over the pseudo-method check for cross-actor explicit targets", async () => {
      mockClients = [
        {
          clientId: "other-user-ext",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-2",
          capabilities: ["host_browser"],
        },
      ];

      const result = await proxy.request(
        { cdpMethod: "Vellum.listTabs", cdpParams: {} },
        "session-1",
        undefined,
        "user-1",
        "other-user-ext",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Submitting actor does not match");
      expect(result.content).not.toContain("extension_required");
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("pseudo-method where the only extension belongs to another actor resolves extension_required", async () => {
      mockClients = [
        {
          clientId: "other-user-ext",
          interfaceId: "chrome-extension",
          actorPrincipalId: "user-2",
          capabilities: ["host_browser"],
        },
        MACOS_CLIENT,
      ];

      const result = await proxy.request(
        { cdpMethod: "Vellum.listTabs", cdpParams: {} },
        "session-1",
        undefined,
        "user-1",
      );

      expectExtensionRequired(result);
      expect(getPublishedMessages()).toHaveLength(0);
    });

    test("raw CDP with only the bridge connected still routes to the bridge", async () => {
      mockClients = [MACOS_CLIENT];

      const resultPromise = proxy.request(
        { cdpMethod: "Page.captureScreenshot", cdpParams: {} },
        "session-1",
        undefined,
        "user-1",
      );

      expect(getPublishedMessages()).toHaveLength(1);
      const requestId = (getPublishedMessages()[0] as Record<string, unknown>)
        .requestId as string;
      expect(pendingInteractions.get(requestId)?.targetClientId).toBe(
        "macos-client",
      );

      resolveResult(requestId, { content: '{"data":"..."}', isError: false });
      await resultPromise;
    });
  });
});
