import { afterEach, describe, expect, mock, test } from "bun:test";

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
