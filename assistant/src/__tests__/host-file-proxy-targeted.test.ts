/**
 * Tests for HostFileProxy Phase 2 targetClientId behaviour.
 *
 * Covers:
 *  - Explicit targetClientId validation (valid, unknown, incapable)
 *  - Auto-resolve when exactly one host_file-capable client is connected
 *  - Untargeted broadcast when multiple capable clients are connected
 *  - targetClientId propagated into cancel messages (abort + dispose)
 *  - Timeout message includes clientId when resolvedTargetClientId is set
 */
import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
const sentMessageOptions: unknown[] = [];
const resolvedInteractionIds: string[] = [];
let mockHasClient = false;
type MockClient = {
  clientId: string;
  capabilities: string[];
  actorPrincipalId?: string;
};
let mockCapableClients: Array<MockClient> = [];
let mockClientRegistry: Map<string, MockClient> = new Map();

// Pre-existing Phase 2 routing tests use a single user identity. The same-user
// check added in PR 3 is exercised separately in `host-file-proxy.test.ts`.
const TEST_PRINCIPAL = "test-user";

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (
    msg: unknown,
    _conversationId?: string,
    options?: unknown,
  ) => {
    sentMessages.push(msg);
    sentMessageOptions.push(options);
  },
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_file" && mockHasClient ? { id: "mock-client" } : null,
    listClientsByCapability: (_cap: string) => mockCapableClients,
    getClientById: (clientId: string) => mockClientRegistry.get(clientId),
    getActorPrincipalIdForClient: (clientId: string) =>
      mockClientRegistry.get(clientId)?.actorPrincipalId,
  },
}));

const pendingInteractionMap = new Map<string, Record<string, unknown>>();
mock.module("../runtime/pending-interactions.js", () => ({
  register: (requestId: string, interaction: Record<string, unknown>) => {
    pendingInteractionMap.set(requestId, interaction);
  },
  resolve: (requestId: string) => {
    const interaction = pendingInteractionMap.get(requestId);
    pendingInteractionMap.delete(requestId);
    resolvedInteractionIds.push(requestId);
    return interaction;
  },
  get: (requestId: string) => pendingInteractionMap.get(requestId),
  getByKind: (_kind: string) =>
    Array.from(pendingInteractionMap.entries())
      .filter(([, v]) => v.kind === _kind)
      .map(([requestId, v]) => ({ requestId, ...v })),
  getByConversation: () => [],
  removeByConversation: () => {},
}));

const { HostFileProxy } = await import("../daemon/host-file-proxy.js");

describe("HostFileProxy — targetClientId (Phase 2)", () => {
  let proxy: InstanceType<typeof HostFileProxy>;

  function setup() {
    sentMessages.length = 0;
    sentMessageOptions.length = 0;
    resolvedInteractionIds.length = 0;
    pendingInteractionMap.clear();
    mockHasClient = false;
    mockCapableClients = [];
    mockClientRegistry = new Map();
    proxy = new (HostFileProxy as any)();
  }

  function setupSingleClient(clientId = "client-1") {
    const entry: MockClient = {
      clientId,
      capabilities: ["host_file"],
      actorPrincipalId: TEST_PRINCIPAL,
    };
    mockCapableClients = [entry];
    mockClientRegistry.set(clientId, entry);
  }

  function setupMultipleClients(clientIds: string[]) {
    mockCapableClients = clientIds.map((id) => ({
      clientId: id,
      capabilities: ["host_file"],
      actorPrincipalId: TEST_PRINCIPAL,
    }));
    for (const entry of mockCapableClients) {
      mockClientRegistry.set(entry.clientId, entry);
    }
  }

  afterEach(() => {
    proxy?.dispose();
    HostFileProxy.reset();
  });

  // ── Explicit targetClientId — valid ──────────────────────────────────

  describe("explicit targetClientId — valid client with host_file", () => {
    test("resolves to that client and broadcasts with targetClientId option", async () => {
      setup();
      setupSingleClient("client-mac");
      // Also add a second client so explicit targeting is meaningful
      const entry2 = { clientId: "client-linux", capabilities: ["host_file"] };
      mockCapableClients.push(entry2);
      mockClientRegistry.set("client-linux", entry2);

      const resultPromise = proxy.request(
        {
          operation: "read",
          path: "/home/user/notes.txt",
          targetClientId: "client-mac",
        },
        "session-1",
        undefined,
        undefined,
        TEST_PRINCIPAL,
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_file_request");
      expect(sent.targetClientId).toBe("client-mac");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-mac");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, { content: "file contents", isError: false });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // ── Explicit targetClientId — unknown client ─────────────────────────

  describe("explicit targetClientId — unknown client", () => {
    test("returns error result immediately without broadcasting", async () => {
      setup();
      setupSingleClient("client-mac");

      const result = await proxy.request(
        {
          operation: "read",
          path: "/tmp/file.txt",
          targetClientId: "client-unknown",
        },
        "session-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-unknown");
      expect(result.content).toContain(
        "assistant clients list --capability host_file",
      );
      // No pending entry should have been created
      expect(sentMessages).toHaveLength(0);
    });

    test("does not create a pending entry for unknown client", async () => {
      setup();

      const result = await proxy.request(
        {
          operation: "write",
          path: "/tmp/out.txt",
          content: "data",
          targetClientId: "client-ghost",
        },
        "session-1",
      );

      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── Explicit targetClientId — incapable client ───────────────────────

  describe("explicit targetClientId — connected but lacks host_file", () => {
    test("returns error result immediately without broadcasting", async () => {
      setup();
      // Register a client that exists but does not have host_file
      mockClientRegistry.set("client-no-file", {
        clientId: "client-no-file",
        capabilities: ["host_bash"],
      });

      const result = await proxy.request(
        {
          operation: "read",
          path: "/tmp/test.txt",
          targetClientId: "client-no-file",
        },
        "session-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-no-file");
      expect(result.content).toContain("does not support host_file");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── Auto-resolve single capable client ───────────────────────────────

  describe("auto-resolve single capable client", () => {
    test("resolves target when exactly one host_file-capable client is connected", async () => {
      setup();
      setupSingleClient("client-solo");

      const resultPromise = proxy.request(
        { operation: "read", path: "/tmp/file.txt" },
        "session-1",
        undefined,
        undefined,
        TEST_PRINCIPAL,
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-solo");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-solo");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, { content: "ok", isError: false });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // ── No target — multiple capable clients ─────────────────────────────

  describe("no explicit target — multiple capable clients", () => {
    test("broadcasts without targetClientId (untargeted)", async () => {
      setup();
      setupMultipleClients(["client-1", "client-2"]);

      const resultPromise = proxy.request(
        { operation: "read", path: "/tmp/file.txt" },
        "session-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_file_request");
      expect(sent.targetClientId).toBeUndefined();

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBeUndefined();

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, { content: "ok", isError: false });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // ── targetClientId in cancel (abort signal) ──────────────────────────

  describe("targetClientId in cancel — abort signal", () => {
    test("cancel broadcast includes targetClientId when request was targeted", async () => {
      setup();
      setupSingleClient("client-abc");

      const controller = new AbortController();
      const resultPromise = proxy.request(
        { operation: "read", path: "/tmp/file.txt" },
        "session-1",
        controller.signal,
        undefined,
        TEST_PRINCIPAL,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(sent.targetClientId).toBe("client-abc");

      controller.abort();
      await resultPromise;

      // Second message is the cancel
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_file_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
      expect(cancelMsg.targetClientId).toBe("client-abc");

      const cancelOpts = sentMessageOptions[1] as
        | Record<string, unknown>
        | undefined;
      expect(cancelOpts?.targetClientId).toBe("client-abc");
    });
  });

  // ── targetClientId in cancel (dispose) ───────────────────────────────

  describe("targetClientId in cancel — dispose", () => {
    test("dispose cancel broadcast includes targetClientId for targeted request", () => {
      setup();
      setupSingleClient("client-xyz");

      const p = proxy.request(
        { operation: "read", path: "/tmp/file.txt" },
        "session-1",
        undefined,
        undefined,
        TEST_PRINCIPAL,
      );
      p.catch(() => {}); // expected rejection on dispose

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-xyz");
      const requestId = sent.requestId as string;

      proxy.dispose();

      const cancelMessages = sentMessages
        .slice(1)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_file_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(1);
      expect(cancelMessages[0].requestId).toBe(requestId);
      expect(cancelMessages[0].targetClientId).toBe("client-xyz");
    });
  });

  // ── Timeout message includes clientId ────────────────────────────────

  describe("timeout message includes clientId", () => {
    test("timeout resolve message mentions resolvedTargetClientId", async () => {
      setup();
      setupSingleClient("client-mac");

      jest.useFakeTimers();
      try {
        const resultPromise = proxy.request(
          { operation: "read", path: "/tmp/slow.txt" },
          "session-1",
          undefined,
          undefined,
          TEST_PRINCIPAL,
        );

        const sent = sentMessages[0] as Record<string, unknown>;
        expect(sent.targetClientId).toBe("client-mac");

        // Advance past the 30s internal timeout
        jest.advanceTimersByTime(31 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("client-mac");
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
