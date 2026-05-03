/**
 * Tests for HostTransferProxy targetClientId behaviour (Phase 1).
 *
 * Covers:
 *  - requestToHost() explicit valid targetClientId → validates, broadcasts with targetClientId
 *  - requestToHost() auto-resolve when exactly one host_file-capable client → auto-resolves
 *  - requestToHost() unknown targetClientId → early error, no broadcast
 *  - requestToHost() incapable client → early error, no broadcast
 *  - requestToSandbox() explicit valid targetClientId → same 4 cases
 *  - Abort path sends host_transfer_cancel with targetClientId
 *  - cancel(requestId) reads targetClientId from pending interaction
 *  - dispose() reads targetClientId from pending interaction
 *  - getTargetClientIdForTransfer() returns correct value after requestToHost()
 *  - Timeout message includes client ID when resolvedTargetClientId is set
 *  - Regression: no-targetClientId requestToHost / requestToSandbox (smoke tests)
 */
import { afterEach, describe, expect, jest, mock, test } from "bun:test";

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
      cap === "host_file" && mockHasClient ? { id: "mock-client" } : null,
    listClientsByCapability: (_cap: string) => mockCapableClients,
    getClientById: (clientId: string) => mockClientRegistry.get(clientId),
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
  clear: () => pendingInteractionMap.clear(),
}));

const { HostTransferProxy } = await import("../daemon/host-transfer-proxy.js");

/**
 * Poll until sentMessages reaches the expected length.
 * Needed because requestToHost() does async readFile before broadcasting.
 */
async function waitForMessages(
  msgs: unknown[],
  expectedLength: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (msgs.length < expectedLength) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${expectedLength} message(s), got ${msgs.length}`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("HostTransferProxy — targetClientId", () => {
  let proxy: InstanceType<typeof HostTransferProxy>;

  function setup() {
    sentMessages.length = 0;
    sentMessageOptions.length = 0;
    resolvedInteractionIds.length = 0;
    pendingInteractionMap.clear();
    mockHasClient = false;
    mockCapableClients = [];
    mockClientRegistry = new Map();
    HostTransferProxy.reset();
    proxy = new (HostTransferProxy as any)();
  }

  function setupSingleClient(clientId = "client-1") {
    const entry = { clientId, capabilities: ["host_file"] };
    mockCapableClients = [entry];
    mockClientRegistry.set(clientId, entry);
  }

  afterEach(() => {
    proxy?.dispose();
    HostTransferProxy.reset();
  });

  // ── requestToHost() — explicit valid targetClientId ───────────────────

  describe("requestToHost() — explicit valid targetClientId", () => {
    test("broadcasts with targetClientId in message body and options", async () => {
      setup();
      setupSingleClient("client-mac");

      // Create a fake file for requestToHost to read
      const fileContent = "hello";
      const srcPath = `/tmp/htp-targeted-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, fileContent);

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-1",
        targetClientId: "client-mac",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.targetClientId).toBe("client-mac");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-mac");

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false, bytesWritten: 5 });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // ── requestToHost() — auto-resolve single capable client ─────────────

  describe("requestToHost() — auto-resolve when exactly one capable client", () => {
    test("auto-resolves targetClientId to the single capable client", async () => {
      setup();
      setupSingleClient("client-solo");

      const srcPath = `/tmp/htp-targeted-solo-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, "content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-2",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-solo");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-solo");

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      const result = await resultPromise;
      expect(result.isError).toBe(false);
    });
  });

  // ── requestToHost() — unknown targetClientId ─────────────────────────

  describe("requestToHost() — unknown targetClientId", () => {
    test("returns error immediately without broadcasting", async () => {
      setup();
      // No clients registered

      const result = await proxy.requestToHost({
        sourcePath: "/tmp/file.txt",
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-3",
        targetClientId: "client-ghost",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-ghost");
      expect(result.content).toContain("assistant clients list --capability host_file");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── requestToHost() — incapable client ───────────────────────────────

  describe("requestToHost() — client lacks host_file capability", () => {
    test("returns error immediately without broadcasting", async () => {
      setup();
      mockClientRegistry.set("client-no-file", {
        clientId: "client-no-file",
        capabilities: ["host_bash"],
      });

      const result = await proxy.requestToHost({
        sourcePath: "/tmp/file.txt",
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-4",
        targetClientId: "client-no-file",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-no-file");
      expect(result.content).toContain("does not support host_file");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── requestToSandbox() — explicit valid targetClientId ────────────────

  describe("requestToSandbox() — explicit valid targetClientId", () => {
    test("broadcasts with targetClientId in message body and options", async () => {
      setup();
      setupSingleClient("client-mac");

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-5",
        targetClientId: "client-mac",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.targetClientId).toBe("client-mac");

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBe("client-mac");

      // Cancel to resolve the promise
      proxy.cancel(sent.requestId as string);
      await resultPromise;
    });
  });

  // ── requestToSandbox() — auto-resolve single capable client ──────────

  describe("requestToSandbox() — auto-resolve when exactly one capable client", () => {
    test("auto-resolves targetClientId", async () => {
      setup();
      setupSingleClient("client-solo");

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-6",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-solo");

      proxy.cancel(sent.requestId as string);
      await resultPromise;
    });
  });

  // ── requestToSandbox() — unknown targetClientId ──────────────────────

  describe("requestToSandbox() — unknown targetClientId", () => {
    test("returns error immediately without broadcasting", async () => {
      setup();

      const result = await proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-7",
        targetClientId: "client-ghost",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("client-ghost");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── requestToSandbox() — incapable client ────────────────────────────

  describe("requestToSandbox() — client lacks host_file capability", () => {
    test("returns error immediately without broadcasting", async () => {
      setup();
      mockClientRegistry.set("client-no-file", {
        clientId: "client-no-file",
        capabilities: ["host_bash"],
      });

      const result = await proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-8",
        targetClientId: "client-no-file",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not support host_file");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // ── Abort path includes targetClientId in cancel (requestToHost) ──────

  describe("abort path — requestToHost sends cancel with targetClientId", () => {
    test("cancel broadcast includes targetClientId when request was targeted", async () => {
      setup();
      setupSingleClient("client-abc");

      const srcPath = `/tmp/htp-targeted-abort-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, "content");

      const controller = new AbortController();
      const resultPromise = proxy.requestToHost(
        {
          sourcePath: srcPath,
          destPath: "/host/dest.txt",
          overwrite: false,
          conversationId: "conv-9",
          targetClientId: "client-abc",
        },
        controller.signal,
      );

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-abc");

      controller.abort();
      const result = await resultPromise;
      expect(result.isError).toBe(true);

      // Second message is the cancel
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_transfer_cancel");
      expect(cancelMsg.targetClientId).toBe("client-abc");

      const cancelOpts = sentMessageOptions[1] as Record<string, unknown> | undefined;
      expect(cancelOpts?.targetClientId).toBe("client-abc");
    });
  });

  // ── cancel(requestId) reads targetClientId from pending interaction ───

  describe("cancel() reads targetClientId from pending interaction", () => {
    test("cancel broadcast includes targetClientId", async () => {
      setup();
      setupSingleClient("client-xyz");

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-10",
        targetClientId: "client-xyz",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(sent.targetClientId).toBe("client-xyz");

      proxy.cancel(requestId);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Transfer cancelled");

      // Cancel message
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_transfer_cancel");
      expect(cancelMsg.targetClientId).toBe("client-xyz");

      const cancelOpts = sentMessageOptions[1] as Record<string, unknown> | undefined;
      expect(cancelOpts?.targetClientId).toBe("client-xyz");
    });
  });

  // ── dispose() reads targetClientId from pending interaction ───────────

  describe("dispose() reads targetClientId from pending interaction", () => {
    test("dispose cancel broadcast includes targetClientId for targeted request", () => {
      setup();
      setupSingleClient("client-dispose");

      const p = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-11",
        targetClientId: "client-dispose",
      });
      p.catch(() => {}); // expected rejection on dispose

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-dispose");
      const requestId = sent.requestId as string;

      proxy.dispose();

      const cancelMessages = sentMessages
        .slice(1)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_transfer_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(1);
      expect(cancelMessages[0].requestId).toBe(requestId);
      expect(cancelMessages[0].targetClientId).toBe("client-dispose");
    });
  });

  // ── getTargetClientIdForTransfer() ────────────────────────────────────

  describe("getTargetClientIdForTransfer()", () => {
    test("returns targetClientId after requestToHost()", async () => {
      setup();
      setupSingleClient("client-peek");

      const srcPath = `/tmp/htp-targeted-peek-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, "content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-12",
        targetClientId: "client-peek",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      expect(proxy.getTargetClientIdForTransfer(transferId)).toBe("client-peek");

      // Clean up
      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      await resultPromise;
    });

    test("returns null for untargeted transfer", async () => {
      setup();
      // No clients — no auto-resolve

      const srcPath = `/tmp/htp-targeted-null-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, "hello");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-13",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      expect(proxy.getTargetClientIdForTransfer(transferId)).toBeNull();

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      await resultPromise;
    });

    test("returns null for unknown transferId", () => {
      setup();
      expect(proxy.getTargetClientIdForTransfer("nonexistent-id")).toBeNull();
    });
  });

  // ── Timeout message includes clientId ─────────────────────────────────

  describe("timeout message includes clientId when targeted", () => {
    test("timeout resolve message mentions resolvedTargetClientId for requestToSandbox", async () => {
      setup();
      setupSingleClient("client-timeout");

      jest.useFakeTimers();
      try {
        const resultPromise = proxy.requestToSandbox({
          sourcePath: "/host/source.txt",
          destPath: "/sandbox/dest.txt",
          conversationId: "conv-14",
          targetClientId: "client-timeout",
        });

        const sent = sentMessages[0] as Record<string, unknown>;
        expect(sent.targetClientId).toBe("client-timeout");

        // Advance past the 120s default timeout
        jest.advanceTimersByTime(121 * 1000);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content).toContain("client-timeout");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── Regression: no-targetClientId path is unbroken ───────────────────

  describe("regression — untargeted requestToHost completes normally", () => {
    test("no-targetClientId requestToHost resolves successfully", async () => {
      setup();
      // Multiple clients so no auto-resolve
      mockCapableClients = [
        { clientId: "client-a", capabilities: ["host_file"] },
        { clientId: "client-b", capabilities: ["host_file"] },
      ];

      const srcPath = `/tmp/htp-regression-tohost-${Date.now()}.txt`;
      await globalThis.Bun.write(srcPath, "regression content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-reg-1",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.targetClientId).toBeUndefined();

      const opts = sentMessageOptions[0] as Record<string, unknown> | undefined;
      expect(opts?.targetClientId).toBeUndefined();

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false, bytesWritten: 18 });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("successfully");
    });
  });

  describe("regression — untargeted requestToSandbox completes normally", () => {
    test("no-targetClientId requestToSandbox resolves via cancel", async () => {
      setup();
      // Multiple clients so no auto-resolve
      mockCapableClients = [
        { clientId: "client-a", capabilities: ["host_file"] },
        { clientId: "client-b", capabilities: ["host_file"] },
      ];

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-reg-2",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.targetClientId).toBeUndefined();

      proxy.cancel(sent.requestId as string);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Transfer cancelled");
    });
  });
});
