import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const mockConfig = {
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

const sentMessages: unknown[] = [];
const sentMessageOptions: unknown[] = [];
let mockHasClient = false;
type MockClient = {
  clientId: string;
  capabilities: string[];
  actorPrincipalId?: string;
};
let mockCapableClients: Array<MockClient> = [];
let mockClientRegistry: Map<string, MockClient> = new Map();

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
      cap === "host_bash" && mockHasClient ? { id: "mock-client" } : null,
    listClientsByCapability: (_cap: string) => mockCapableClients,
    getClientById: (clientId: string) => mockClientRegistry.get(clientId),
    getActorPrincipalIdForClient: (clientId: string) =>
      mockClientRegistry.get(clientId)?.actorPrincipalId,
  },
}));

// Use the REAL pending-interactions module — the proxy self-registers here.
const pendingInteractions = await import("../runtime/pending-interactions.js");
const { HostBashProxy } = await import("../daemon/host-bash-proxy.js");

describe("HostBashProxy", () => {
  let proxy: InstanceType<typeof HostBashProxy>;

  function setup() {
    sentMessages.length = 0;
    sentMessageOptions.length = 0;
    mockHasClient = false;
    mockCapableClients = [];
    mockClientRegistry = new Map();
    pendingInteractions.clear();
    proxy = new (HostBashProxy as any)();
  }

  function setupSingleClient(
    clientId: string = "client-1",
    actorPrincipalId: string = "user-A",
  ) {
    const entry: MockClient = {
      clientId,
      capabilities: ["host_bash"],
      actorPrincipalId,
    };
    mockCapableClients = [entry];
    mockClientRegistry.set(clientId, entry);
  }

  function setupMultipleClients(clientIds: string[]) {
    mockCapableClients = clientIds.map((id) => ({
      clientId: id,
      capabilities: ["host_bash"],
      actorPrincipalId: "user-A",
    }));
    for (const entry of mockCapableClients) {
      mockClientRegistry.set(entry.clientId, entry);
    }
  }

  afterEach(() => {
    proxy?.dispose();
    HostBashProxy.reset();
    pendingInteractions.clear();
  });

  describe("request/resolve lifecycle (happy path)", () => {
    test("sends host_bash_request and resolves with formatted output", async () => {
      setup();

      const resultPromise = proxy.request(
        { command: "echo hello", working_dir: "/tmp" },
        "session-1",
      );

      // Verify the request was sent via broadcastMessage
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      expect(sent.conversationId).toBe("session-1");
      expect(sent.command).toBe("echo hello");
      expect(sent.working_dir).toBe("/tmp");
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      // Simulate client response
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.content).toContain("hello");
      expect(result.isError).toBe(false);
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("forwards env field in host_bash_request message", async () => {
      setup();

      const resultPromise = proxy.request(
        {
          command: "echo locked",
          env: { VELLUM_UNTRUSTED_SHELL: "1" },
        },
        "session-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      expect(sent.env).toEqual({ VELLUM_UNTRUSTED_SHELL: "1" });

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "locked\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
    });

    test("omits env field when not provided", async () => {
      setup();

      const resultPromise = proxy.request(
        { command: "echo normal" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.env).toBeUndefined();

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "normal\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
    });

    test("formats error output correctly", async () => {
      setup();

      const resultPromise = proxy.request({ command: "false" }, "session-1");

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolveResult(requestId, {
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not found");
    });

    test("formats timed-out output correctly", async () => {
      setup();

      const resultPromise = proxy.request(
        { command: "sleep 999", timeout_seconds: 10 },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolveResult(requestId, {
        stdout: "partial",
        stderr: "",
        exitCode: null,
        timedOut: true,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("command_timeout");
    });
  });

  describe("timeout", () => {
    test("resolves with timeout error when proxy timeout fires", async () => {
      setup();
      // Override config to use a very short timeout for testing
      mockConfig.timeouts.shellMaxTimeoutSec = 0;

      const resultPromise = proxy.request(
        { command: "echo slow" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      // Resolve to avoid test hanging
      proxy.resolveResult(requestId, {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;

      // Restore
      mockConfig.timeouts.shellMaxTimeoutSec = 600;
    });
  });

  describe("abort signal", () => {
    test("resolves with abort result when signal fires", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toContain("Aborted");
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });

    test("sends host_bash_cancel to client on abort", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        { command: "echo hello" },
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
      expect(cancelMsg.type).toBe("host_bash_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
    });

    test("returns immediately if signal already aborted", async () => {
      setup();

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        { command: "echo hello" },
        "session-1",
        controller.signal,
      );

      expect(result.content).toContain("Aborted");
      expect(sentMessages).toHaveLength(0); // No message sent
    });
  });

  describe("isAvailable", () => {
    test("returns false when no client with host_bash capability is connected", () => {
      setup();
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true when a client with host_bash capability is connected", () => {
      setup();
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests", () => {
      setup();

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.dispose();

      expect(pendingInteractions.get(requestId)).toBeUndefined();
      expect(resultPromise).rejects.toThrow("Host bash proxy disposed");
    });

    test("sends host_bash_cancel for each pending request on dispose", () => {
      setup();

      const p1 = proxy.request({ command: "echo a" }, "session-1");
      const p2 = proxy.request({ command: "echo b" }, "session-1");
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
          (m) => (m as Record<string, unknown>).type === "host_bash_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[0]);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[1]);
    });
  });

  describe("late resolve after abort", () => {
    test("resolveResult is a no-op after abort (entry already deleted)", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      controller.abort();
      const result = await resultPromise;
      expect(result.content).toContain("Aborted");

      // Late resolveResult should be silently ignored (no throw, no double-resolve)
      proxy.resolveResult(requestId, {
        stdout: "late",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  describe("resolveResult with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw
      proxy.resolveResult("unknown-id", {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
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

    test("removes abort listener from signal after resolveResult completes", async () => {
      setup();
      const controller = new AbortController();
      const spy = spySignal(controller.signal);

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        spy.signal,
      );

      expect(spy.addCalls).toEqual(["abort"]);
      expect(spy.removeCalls).toEqual([]);

      const requestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      await resultPromise;

      expect(spy.removeCalls).toEqual(["abort"]);

      controller.abort();
      expect(sentMessages).toHaveLength(1);
    });

    test("removes abort listener from signal on timer timeout", async () => {
      setup();

      jest.useFakeTimers();
      try {
        const controller = new AbortController();
        const spy = spySignal(controller.signal);

        const resultPromise = proxy.request(
          { command: "echo slow", timeout_seconds: 30 },
          "session-1",
          spy.signal,
        );

        expect(spy.addCalls).toEqual(["abort"]);
        expect(spy.removeCalls).toEqual([]);

        // Proxy timeout is timeout_seconds + 3 = 33s. Advance past it.
        jest.advanceTimersByTime(34 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("Host bash proxy timed out");

        expect(spy.removeCalls).toEqual(["abort"]);

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
        { command: "echo hello" },
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

      const p1 = proxy.request({ command: "echo a" }, "session-1");
      const p2 = proxy.request({ command: "echo b" }, "session-1");
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
        { command: "echo hello" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveResult(requestId, {
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });

  describe("target client routing", () => {
    test("auto-resolves when exactly one capable client is connected", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      // Options passed to broadcastMessage should also have targetClientId
      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-abc");

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("uses explicit targetClientId when it is valid", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");
      // Also register a second client so we're sure explicit targeting works
      const entry2: MockClient = {
        clientId: "client-xyz",
        capabilities: ["host_bash"],
        actorPrincipalId: "user-A",
      };
      mockCapableClients.push(entry2);
      mockClientRegistry.set("client-xyz", entry2);

      const resultPromise = proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-abc");

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });

    test("returns error for explicit targetClientId that is not connected", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-unknown" },
        "session-1",
        undefined,
        "user-A",
      );

      // Should return error without broadcasting
      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-unknown");
      expect(result.content).toContain(
        "assistant clients list --capability host_bash",
      );
      expect(sentMessages).toHaveLength(0);
    });

    test("returns error for explicit targetClientId that is connected but lacks host_bash", async () => {
      setup();
      // Register a client without host_bash capability
      mockClientRegistry.set("client-no-bash", {
        clientId: "client-no-bash",
        capabilities: [],
        actorPrincipalId: "user-A",
      });

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-no-bash" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-no-bash");
      expect(result.content).toContain("does not support host_bash");
      expect(sentMessages).toHaveLength(0);
    });

    test("rejects ambiguously when multiple same-user capable clients are connected and no targetClientId", async () => {
      // Regression: previously fell through to untargeted broadcast, fanning
      // a single targeted-style request out across every same-user machine.
      setup();
      setupMultipleClients(["client-1", "client-2", "client-3"]);

      const result = await proxy.request(
        { command: "echo hello" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("target_client_id");
      // No broadcast happened
      expect(sentMessages).toHaveLength(0);
    });

    test("falls through to broadcast when zero capable clients (existing timeout path)", async () => {
      setup();
      // mockCapableClients is empty (default), so capableClients.length === 0

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
      );

      // Should still broadcast (no early return)
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      // targetClientId is undefined when no clients present
      expect(sent.targetClientId).toBeUndefined();

      // Manually resolve to clean up
      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
    });

    test("includes targetClientId in timeout error message when client was resolved", async () => {
      setup();
      setupSingleClient("client-mac", "user-A");

      jest.useFakeTimers();
      try {
        const resultPromise = proxy.request(
          { command: "echo slow", timeout_seconds: 30 },
          "session-1",
          undefined,
          "user-A",
        );

        // Proxy timeout = 33s; advance past it
        jest.advanceTimersByTime(34 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("client-mac");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("same-user binding (sourceActorPrincipalId)", () => {
    const SAME_USER_REJECTION =
      "Submitting actor does not match the target client's actor for this request. The targeted client's authenticated user must submit the result.";

    test("same-user targeted request succeeds", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const resultPromise = proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      expect(sent.targetClientId).toBe("client-abc");
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      await resultPromise;
    });

    test("cross-user targeted request rejected", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
        undefined,
        "user-B",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(SAME_USER_REJECTION);
      // No broadcast and no pending registration
      expect(sentMessages).toHaveLength(0);
    });

    test("target client missing actorPrincipalId rejected", async () => {
      setup();
      // Register a client without an actorPrincipalId (legacy/service-token).
      const entry: MockClient = {
        clientId: "client-abc",
        capabilities: ["host_bash"],
      };
      mockCapableClients = [entry];
      mockClientRegistry.set("client-abc", entry);

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(SAME_USER_REJECTION);
      expect(sentMessages).toHaveLength(0);
    });

    test("source missing actorPrincipalId rejected when targeting", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
        undefined,
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(SAME_USER_REJECTION);
      expect(sentMessages).toHaveLength(0);
    });

    test("untargeted local flow unchanged when no auto-resolve match", async () => {
      setup();
      // No capable clients connected — untargeted path runs.

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      expect(sent.targetClientId).toBeUndefined();

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      await resultPromise;
    });

    test("auto-resolve to same-user client succeeds", async () => {
      setup();
      setupSingleClient("client-abc", "user-A");

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        undefined,
        "user-A",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      await resultPromise;
    });

    test("auto-resolve to different-user client falls through to untargeted", async () => {
      setup();
      // Single capable client owned by user-B; caller is user-A.
      setupSingleClient("client-abc", "user-B");

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
        undefined,
        "user-A",
      );

      // Auto-resolve must NOT pick the cross-user client; the untargeted
      // broadcast path runs instead.
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      expect(sent.targetClientId).toBeUndefined();

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBeUndefined();

      const requestId = sent.requestId as string;
      proxy.resolveResult(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      await resultPromise;
    });
  });
});
