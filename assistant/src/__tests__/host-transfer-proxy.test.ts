import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
let mockHasClient = false;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_file" && mockHasClient ? { id: "mock-client" } : null,
    listClientsByCapability: (_cap: string) =>
      mockHasClient ? [{ clientId: "mock-client", capabilities: ["host_file"] }] : [],
    getClientById: (_id: string) => null,
  },
}));

// Use the REAL pending-interactions module — the proxy self-registers here.
const pendingInteractions = await import("../runtime/pending-interactions.js");
const { HostTransferProxy } = await import("../daemon/host-transfer-proxy.js");

/**
 * Poll until `sentMessages` reaches the expected length.
 * Avoids the flaky 50ms fixed sleep — CI runners under load can take longer
 * for the async `readFile` inside `requestToHost` to resolve.
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

describe("HostTransferProxy", () => {
  let proxy: InstanceType<typeof HostTransferProxy>;
  let tempDir: string;

  function setup() {
    sentMessages.length = 0;
    mockHasClient = false;
    pendingInteractions.clear();
    proxy = new (HostTransferProxy as any)();
  }

  afterEach(async () => {
    proxy?.dispose();
    HostTransferProxy.reset();
    pendingInteractions.clear();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("requestToHost lifecycle", () => {
    test("reads source file, sends host_transfer_request with to_host direction", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      const fileContent = "hello world";
      await globalThis.Bun.write(srcPath, fileContent);

      const expectedSha256 = createHash("sha256")
        .update(Buffer.from(fileContent))
        .digest("hex");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-123",
      });

      // Wait for the async file read to complete and message to be sent
      await waitForMessages(sentMessages, 1);

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.direction).toBe("to_host");
      expect(sent.conversationId).toBe("conv-123");
      expect(sent.destPath).toBe("/host/dest.txt");
      expect(sent.sizeBytes).toBe(Buffer.from(fileContent).length);
      expect(sent.sha256).toBe(expectedSha256);
      expect(sent.overwrite).toBe(false);
      expect(typeof sent.requestId).toBe("string");
      expect(typeof sent.transferId).toBe("string");

      const requestId = sent.requestId as string;
      const transferId = sent.transferId as string;
      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      // Resolve the transfer
      proxy.resolveTransferResult(requestId, {
        isError: false,
        bytesWritten: Buffer.from(fileContent).length,
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("successfully");
      expect(result.content).toContain(String(Buffer.from(fileContent).length));
    });

    test("resolves with error when source file does not exist", async () => {
      setup();

      const result = await proxy.requestToHost({
        sourcePath: "/nonexistent/path/file.txt",
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-123",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to read source file");
    });

    test("resolves with error result from client", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-123",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;

      proxy.resolveTransferResult(requestId, {
        isError: true,
        errorMessage: "Permission denied",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Permission denied");
    });
  });

  describe("requestToSandbox lifecycle", () => {
    test("sends host_transfer_request with to_sandbox direction", async () => {
      setup();

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-456",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_transfer_request");
      expect(sent.direction).toBe("to_sandbox");
      expect(sent.conversationId).toBe("conv-456");
      expect(sent.sourcePath).toBe("/host/source.txt");
      expect(typeof sent.requestId).toBe("string");
      expect(typeof sent.transferId).toBe("string");

      const transferId = sent.transferId as string;
      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      proxy.cancel(sent.requestId as string);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Transfer cancelled");
    });
  });

  describe("receiveTransferContent", () => {
    test("writes file and verifies SHA-256 for to_sandbox transfer", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const destPath = join(tempDir, "received.txt");
      const fileData = Buffer.from("received content");
      const sha256 = createHash("sha256").update(fileData).digest("hex");

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath,
        conversationId: "conv-789",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      const receiveResult = await proxy.receiveTransferContent(
        transferId,
        fileData,
        sha256,
      );

      expect(receiveResult.accepted).toBe(true);

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("received.txt");

      // Verify the file was written
      const written = await readFile(destPath, "utf-8");
      expect(written).toBe("received content");
    });

    test("rejects with SHA-256 mismatch", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const destPath = join(tempDir, "received.txt");
      const fileData = Buffer.from("received content");

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath,
        conversationId: "conv-789",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      const receiveResult = await proxy.receiveTransferContent(
        transferId,
        fileData,
        "0000000000000000000000000000000000000000000000000000000000000000",
      );

      expect(receiveResult.accepted).toBe(false);
      expect(receiveResult.error).toContain("SHA-256 mismatch");

      // The transfer should still be pending (not resolved on mismatch)
      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      // Clean up
      proxy.cancel(sent.requestId as string);
      await resultPromise;
    });

    test("returns error for unknown transfer ID", async () => {
      setup();

      const receiveResult = await proxy.receiveTransferContent(
        "unknown-transfer-id",
        Buffer.from("data"),
        "hash",
      );

      expect(receiveResult.accepted).toBe(false);
      expect(receiveResult.error).toContain("Unknown or expired");
    });
  });

  describe("getTransferContent", () => {
    test("returns file buffer for to_host transfer", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      const fileContent = "transfer me";
      await globalThis.Bun.write(srcPath, fileContent);

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: true,
        conversationId: "conv-123",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      const content = proxy.getTransferContent(transferId);
      expect(content).not.toBeNull();
      expect(content!.buffer.toString()).toBe(fileContent);
      expect(content!.sizeBytes).toBe(Buffer.from(fileContent).length);
      expect(content!.sha256).toBe(
        createHash("sha256").update(Buffer.from(fileContent)).digest("hex"),
      );

      // Resolve the transfer to avoid hanging
      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, {
        isError: false,
        bytesWritten: content!.sizeBytes,
      });
      await resultPromise;
    });

    test("single-use: second getTransferContent returns null", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: true,
        conversationId: "conv-123",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      // First access returns content
      const content1 = proxy.getTransferContent(transferId);
      expect(content1).not.toBeNull();

      // Second access returns null (single-use)
      const content2 = proxy.getTransferContent(transferId);
      expect(content2).toBeNull();

      // Resolve the transfer to avoid hanging
      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      await resultPromise;
    });

    test("returns null for unknown transfer ID", () => {
      setup();
      const content = proxy.getTransferContent("unknown-id");
      expect(content).toBeNull();
    });
  });

  describe("takeJustConsumedTransferMetadata", () => {
    test("returns size+sha256 immediately after getTransferContent", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      const fileContent = "header metadata test";
      await globalThis.Bun.write(srcPath, fileContent);

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: true,
        conversationId: "conv-meta-1",
      });

      await waitForMessages(sentMessages, 1);
      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      const expectedSize = Buffer.from(fileContent).length;
      const expectedSha = createHash("sha256")
        .update(Buffer.from(fileContent))
        .digest("hex");

      // Handler consumes content; metadata should now be available for the
      // GET-content route's responseHeaders resolver.
      const content = proxy.getTransferContent(transferId);
      expect(content).not.toBeNull();

      const meta = proxy.takeJustConsumedTransferMetadata(transferId);
      expect(meta).toEqual({ sizeBytes: expectedSize, sha256: expectedSha });

      // Resolve the transfer to avoid hanging
      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, {
        isError: false,
        bytesWritten: expectedSize,
      });
      await resultPromise;
    });

    test("single-use: second take returns null", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "x");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: true,
        conversationId: "conv-meta-2",
      });

      await waitForMessages(sentMessages, 1);
      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      proxy.getTransferContent(transferId);
      expect(proxy.takeJustConsumedTransferMetadata(transferId)).not.toBeNull();
      expect(proxy.takeJustConsumedTransferMetadata(transferId)).toBeNull();

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      await resultPromise;
    });

    test("returns null when getTransferContent was never called", () => {
      setup();
      expect(
        proxy.takeJustConsumedTransferMetadata("never-consumed-id"),
      ).toBeNull();
    });

    test("returns null for unknown transfer ID even after a different transfer was consumed", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "x");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: true,
        conversationId: "conv-meta-3",
      });

      await waitForMessages(sentMessages, 1);
      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;

      proxy.getTransferContent(transferId);

      // Different transferId should still return null
      expect(
        proxy.takeJustConsumedTransferMetadata("other-id"),
      ).toBeNull();

      const requestId = sent.requestId as string;
      proxy.resolveTransferResult(requestId, { isError: false });
      await resultPromise;
    });
  });

  describe("timeout behavior", () => {
    /** Use a very short real timeout instead of fake timers to avoid deadlocks in Bun. */
    const SHORT_TIMEOUT_MS = 150;

    afterAll(() => {
      HostTransferProxy._testTimeoutOverrideMs = undefined;
    });

    test("resolves with timeout error for to_host when client never responds", async () => {
      HostTransferProxy._testTimeoutOverrideMs = SHORT_TIMEOUT_MS;
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      // Create a small file
      await globalThis.Bun.write(srcPath, "small");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-123",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(proxy.hasPendingTransfer(sent.transferId as string)).toBe(true);

      // Wait for the short timeout to fire
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });

    test("resolves with timeout error for to_sandbox when client never responds", async () => {
      HostTransferProxy._testTimeoutOverrideMs = SHORT_TIMEOUT_MS;
      setup();

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-123",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      expect(proxy.hasPendingTransfer(sent.transferId as string)).toBe(true);

      // Wait for the short timeout to fire
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });
  });

  describe("abort signal", () => {
    test("resolves with abort result when signal fires for to_host", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "content");

      const controller = new AbortController();
      const resultPromise = proxy.requestToHost(
        {
          sourcePath: srcPath,
          destPath: "/host/dest.txt",
          overwrite: false,
          conversationId: "conv-123",
        },
        controller.signal,
      );

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;
      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(proxy.hasPendingTransfer(transferId)).toBe(false);
    });

    test("resolves with abort result when signal fires for to_sandbox", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.requestToSandbox(
        {
          sourcePath: "/host/source.txt",
          destPath: "/sandbox/dest.txt",
          conversationId: "conv-123",
        },
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      const transferId = sent.transferId as string;
      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(proxy.hasPendingTransfer(transferId)).toBe(false);
    });

    test("sends host_transfer_cancel on abort", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.requestToSandbox(
        {
          sourcePath: "/host/source.txt",
          destPath: "/sandbox/dest.txt",
          conversationId: "conv-123",
        },
        controller.signal,
      );

      controller.abort();
      await resultPromise;

      // Second message should be the cancel
      expect(sentMessages).toHaveLength(2);
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_transfer_cancel");
    });

    test("returns immediately if signal already aborted (to_host)", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "content");

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.requestToHost(
        {
          sourcePath: srcPath,
          destPath: "/host/dest.txt",
          overwrite: false,
          conversationId: "conv-123",
        },
        controller.signal,
      );

      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0);
    });

    test("returns immediately if signal already aborted (to_sandbox)", async () => {
      setup();

      const controller = new AbortController();
      controller.abort();

      const result = await proxy.requestToSandbox(
        {
          sourcePath: "/host/source.txt",
          destPath: "/sandbox/dest.txt",
          conversationId: "conv-123",
        },
        controller.signal,
      );

      expect(result.content).toBe("Aborted");
      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0);
    });
  });

  describe("cancel", () => {
    test("cancels a pending to_sandbox transfer", async () => {
      setup();

      const resultPromise = proxy.requestToSandbox({
        sourcePath: "/host/source.txt",
        destPath: "/sandbox/dest.txt",
        conversationId: "conv-123",
      });

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      const transferId = sent.transferId as string;

      expect(proxy.hasPendingTransfer(transferId)).toBe(true);

      proxy.cancel(requestId);

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Transfer cancelled");
      expect(proxy.hasPendingTransfer(transferId)).toBe(false);

      // Should have sent cancel message
      const cancelMsg = sentMessages[1] as Record<string, unknown>;
      expect(cancelMsg.type).toBe("host_transfer_cancel");
      expect(cancelMsg.requestId).toBe(requestId);
    });
  });

  describe("isAvailable", () => {
    test("returns false when no client with host_file capability is connected", () => {
      setup();
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
    });

    test("returns true when a client with host_file capability is connected", () => {
      setup();
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
    });
  });

  describe("dispose", () => {
    test("rejects all pending requests", () => {
      setup();

      const p1 = proxy.requestToSandbox({
        sourcePath: "/host/a.txt",
        destPath: "/sandbox/a.txt",
        conversationId: "conv-123",
      });
      const p2 = proxy.requestToSandbox({
        sourcePath: "/host/b.txt",
        destPath: "/sandbox/b.txt",
        conversationId: "conv-123",
      });
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const transferIds = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.transferId as string,
      );
      expect(transferIds).toHaveLength(2);

      proxy.dispose();

      expect(proxy.hasPendingTransfer(transferIds[0]!)).toBe(false);
      expect(proxy.hasPendingTransfer(transferIds[1]!)).toBe(false);
    });

    test("sends host_transfer_cancel for each pending request on dispose", () => {
      setup();

      const p1 = proxy.requestToSandbox({
        sourcePath: "/host/a.txt",
        destPath: "/sandbox/a.txt",
        conversationId: "conv-123",
      });
      const p2 = proxy.requestToSandbox({
        sourcePath: "/host/b.txt",
        destPath: "/sandbox/b.txt",
        conversationId: "conv-123",
      });
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const requestIds = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(requestIds).toHaveLength(2);

      proxy.dispose();

      const cancelMessages = sentMessages
        .slice(2)
        .filter(
          (m) => (m as Record<string, unknown>).type === "host_transfer_cancel",
        ) as Array<Record<string, unknown>>;
      expect(cancelMessages).toHaveLength(2);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[0]);
      expect(cancelMessages.map((m) => m.requestId)).toContain(requestIds[1]);
    });
  });

  describe("resolveTransferResult with unknown requestId", () => {
    test("silently ignores unknown requestId", () => {
      setup();
      // Should not throw
      proxy.resolveTransferResult("unknown-id", {
        isError: false,
        bytesWritten: 0,
      });
    });
  });

  describe("pendingInteractions cleanup", () => {
    test("cleans up on abort", async () => {
      setup();

      const controller = new AbortController();
      const resultPromise = proxy.requestToSandbox(
        {
          sourcePath: "/host/source.txt",
          destPath: "/sandbox/dest.txt",
          conversationId: "conv-123",
        },
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

      const p1 = proxy.requestToSandbox({
        sourcePath: "/host/a.txt",
        destPath: "/sandbox/a.txt",
        conversationId: "conv-123",
      });
      const p2 = proxy.requestToSandbox({
        sourcePath: "/host/b.txt",
        destPath: "/sandbox/b.txt",
        conversationId: "conv-123",
      });
      p1.catch(() => {}); // Expected rejection on dispose
      p2.catch(() => {}); // Expected rejection on dispose

      const ids = (sentMessages as Array<Record<string, unknown>>).map(
        (m) => m.requestId as string,
      );
      expect(ids).toHaveLength(2);

      proxy.dispose();

      expect(pendingInteractions.get(ids[0])).toBeUndefined();
      expect(pendingInteractions.get(ids[1])).toBeUndefined();
    });

    test("cleans up on normal resolveTransferResult", async () => {
      setup();
      tempDir = await mkdtemp(join(tmpdir(), "htp-test-"));
      const srcPath = join(tempDir, "source.txt");
      await globalThis.Bun.write(srcPath, "content");

      const resultPromise = proxy.requestToHost({
        sourcePath: srcPath,
        destPath: "/host/dest.txt",
        overwrite: false,
        conversationId: "conv-123",
      });

      await waitForMessages(sentMessages, 1);

      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(pendingInteractions.get(requestId)).toBeDefined();

      proxy.resolveTransferResult(requestId, {
        isError: false,
        bytesWritten: 7,
      });

      await resultPromise;
      expect(pendingInteractions.get(requestId)).toBeUndefined();
    });
  });
});
