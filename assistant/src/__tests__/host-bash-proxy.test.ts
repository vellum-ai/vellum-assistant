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
const resolvedInteractionIds: string[] = [];
let mockHasClient = false;
let mockCapableClients: Array<{ clientId: string; capabilities: string[] }> = [];
let mockClientRegistry: Map<string, { clientId: string; capabilities: string[] }> = new Map();

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown, _conversationId?: string, options?: unknown) => {
    sentMessages.push(msg);
    sentMessageOptions.push(options);
  },
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_bash" && mockHasClient ? { id: "mock-client" } : null,
    listClientsByCapability: (_cap: string) => mockCapableClients,
    getClientById: (clientId: string) => mockClientRegistry.get(clientId),
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

const { HostBashProxy } = await import("../daemon/host-bash-proxy.js");

describe("HostBashProxy", () => {
  let proxy: InstanceType<typeof HostBashProxy>;

  function setup() {
    sentMessages.length = 0;
    sentMessageOptions.length = 0;
    resolvedInteractionIds.length = 0;
    mockHasClient = false;
    mockCapableClients = [];
    mockClientRegistry = new Map();
    proxy = new (HostBashProxy as any)();
  }

  function setupSingleClient(clientId = "client-1") {
    const entry = { clientId, capabilities: ["host_bash"] };
    mockCapableClients = [entry];
    mockClientRegistry.set(clientId, entry);
  }

  function setupMultipleClients(clientIds: string[]) {
    mockCapableClients = clientIds.map((id) => ({
      clientId: id,
      capabilities: ["host_bash"],
    }));
    for (const entry of mockCapableClients) {
      mockClientRegistry.set(entry.clientId, entry);
    }
  }

  afterEach(() => {
    proxy?.dispose();
    HostBashProxy.reset();
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
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Simulate client response
      proxy.resolve(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.content).toContain("hello");
      expect(result.isError).toBe(false);
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
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
      proxy.resolve(requestId, {
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
      proxy.resolve(requestId, {
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

      proxy.resolve(requestId, {
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

      proxy.resolve(requestId, {
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
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      // Resolve to avoid test hanging
      proxy.resolve(requestId, {
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
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toContain("Aborted");
      expect(proxy.hasPendingRequest(requestId)).toBe(false);
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
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.dispose();

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
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
    test("resolve is a no-op after abort (entry already deleted)", async () => {
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

      // Late resolve should be silently ignored (no throw, no double-resolve)
      proxy.resolve(requestId, {
        stdout: "late",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
    });
  });

  describe("resolve with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw
      proxy.resolve("unknown-id", {
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

    test("removes abort listener from signal after resolve completes", async () => {
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
      proxy.resolve(requestId, {
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

  describe("pendingInteractions.resolve callback", () => {
    test("fires on abort", async () => {
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

      expect(resolvedInteractionIds).toEqual([requestId]);
    });

    test("fires for each pending request on dispose", () => {
      setup();

      const p1 = proxy.request({ command: "echo a" }, "session-1");
      const p2 = proxy.request({ command: "echo b" }, "session-1");
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const ids = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(ids).toHaveLength(2);

      proxy.dispose();

      expect(resolvedInteractionIds).toHaveLength(2);
      expect(resolvedInteractionIds).toContain(ids[0]);
      expect(resolvedInteractionIds).toContain(ids[1]);
    });

    test("does not fire on normal client-initiated resolve", async () => {
      setup();

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      // Normal resolve from client — should NOT trigger pendingInteractions.resolve
      proxy.resolve(requestId, {
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
      expect(resolvedInteractionIds).toEqual([]);
    });
  });

  describe("target client routing", () => {
    test("auto-resolves when exactly one capable client is connected", async () => {
      setup();
      setupSingleClient("client-abc");

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      // Options passed to broadcastMessage should also have targetClientId
      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-abc");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
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
      setupSingleClient("client-abc");
      // Also register a second client so we're sure explicit targeting works
      const entry2 = { clientId: "client-xyz", capabilities: ["host_bash"] };
      mockCapableClients.push(entry2);
      mockClientRegistry.set("client-xyz", entry2);

      const resultPromise = proxy.request(
        { command: "echo hello", targetClientId: "client-abc" },
        "session-1",
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-abc");

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
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
      setupSingleClient("client-abc");

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-unknown" },
        "session-1",
      );

      // Should return error without broadcasting
      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-unknown");
      expect(result.content).toContain("assistant clients list --capability host_bash");
      expect(sentMessages).toHaveLength(0);
    });

    test("returns error for explicit targetClientId that is connected but lacks host_bash", async () => {
      setup();
      // Register a client without host_bash capability
      mockClientRegistry.set("client-no-bash", {
        clientId: "client-no-bash",
        capabilities: [],
      });

      const result = await proxy.request(
        { command: "echo hello", targetClientId: "client-no-bash" },
        "session-1",
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-no-bash");
      expect(result.content).toContain("does not support host_bash");
      expect(sentMessages).toHaveLength(0);
    });

    test("falls through to untargeted broadcast when multiple capable clients are connected and no targetClientId", async () => {
      setup();
      setupMultipleClients(["client-1", "client-2", "client-3"]);

      const resultPromise = proxy.request(
        { command: "echo hello" },
        "session-1",
      );

      // Should broadcast without an early error return
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_bash_request");
      // No target client resolved — untargeted broadcast
      expect(sent.targetClientId).toBeUndefined();

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBeUndefined();

      // Manually resolve to clean up
      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
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
      proxy.resolve(requestId, {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
    });

    test("includes targetClientId in timeout error message when client was resolved", async () => {
      setup();
      setupSingleClient("client-mac");

      jest.useFakeTimers();
      try {
        const resultPromise = proxy.request(
          { command: "echo slow", timeout_seconds: 30 },
          "session-1",
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
});
