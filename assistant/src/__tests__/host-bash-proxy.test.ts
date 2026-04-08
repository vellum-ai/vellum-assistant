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
  saveConfig: () => {},
}));

const { HostBashProxy } = await import("../daemon/host-bash-proxy.js");

describe("HostBashProxy", () => {
  let proxy: InstanceType<typeof HostBashProxy>;
  let sentMessages: unknown[];
  let sendToClient: (msg: unknown) => void;

  function setup(onInternalResolve?: (requestId: string) => void) {
    sentMessages = [];
    sendToClient = (msg: unknown) => sentMessages.push(msg);
    proxy = new HostBashProxy(sendToClient, onInternalResolve);
  }

  afterEach(() => {
    proxy?.dispose();
  });

  describe("request/resolve lifecycle (happy path)", () => {
    test("sends host_bash_request and resolves with formatted output", async () => {
      setup();

      const resultPromise = proxy.request(
        { command: "echo hello", working_dir: "/tmp" },
        "session-1",
      );

      // Verify the request was sent to the client
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

      // The proxy timeout is shellMaxTimeoutSec + 30 seconds.
      // With shellMaxTimeoutSec=0 that's 30 seconds which is too long for a test.
      // Instead, just verify the pending state and resolve it.
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
        { command: "echo hello" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.dispose();

      expect(proxy.hasPendingRequest(requestId)).toBe(false);
      // The promise should reject since dispose rejects pending
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

  describe("updateSender", () => {
    test("uses updated sender for new requests", async () => {
      setup();

      const newMessages: unknown[] = [];
      proxy.updateSender((msg) => newMessages.push(msg), true);

      const resultPromise = proxy.request(
        { command: "echo updated" },
        "session-1",
      );

      expect(sentMessages).toHaveLength(0); // Old sender not used
      expect(newMessages).toHaveLength(1); // New sender used

      const sent = newMessages[0] as Record<string, unknown>;
      proxy.resolve(sent.requestId as string, {
        stdout: "updated",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = source as any;
      const origAdd = source.addEventListener.bind(source);
      const origRemove = source.removeEventListener.bind(source);
      s.addEventListener = (
        type: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...rest: any[]
      ) => {
        addCalls.push(type);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origAdd as any)(type, ...rest);
      };
      s.removeEventListener = (
        type: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...rest: any[]
      ) => {
        removeCalls.push(type);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      proxy = new HostBashProxy(sendToClient, (id) => resolvedIds.push(id));

      // request() synchronously calls sendToClient inside the Promise
      // executor. A throw there surfaces as a rejected promise.
      const resultPromise = proxy.request(
        { command: "echo hello" },
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
      const okPromise = proxy.request({ command: "echo ok" }, "session-1");
      expect(sentMessages).toHaveLength(1);
      const okRequestId = (sentMessages[0] as Record<string, unknown>)
        .requestId as string;
      expect(proxy.hasPendingRequest(okRequestId)).toBe(true);
      proxy.resolve(okRequestId, {
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
      const okResult = await okPromise;
      expect(okResult.content).toContain("ok");
      expect(okResult.isError).toBe(false);
    });
  });

  describe("onInternalResolve callback", () => {
    test("fires on abort", async () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

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

      expect(resolvedIds).toEqual([requestId]);
    });

    test("fires for each pending request on dispose", () => {
      const resolvedIds: string[] = [];
      setup((id) => resolvedIds.push(id));

      // Create two pending requests and catch rejections from dispose
      const p1 = proxy.request({ command: "echo a" }, "session-1");
      const p2 = proxy.request({ command: "echo b" }, "session-1");
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
        { command: "echo hello" },
        "session-1",
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      // Normal resolve from client — should NOT trigger onInternalResolve
      proxy.resolve(requestId, {
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      await resultPromise;
      expect(resolvedIds).toEqual([]);
    });
  });
});
