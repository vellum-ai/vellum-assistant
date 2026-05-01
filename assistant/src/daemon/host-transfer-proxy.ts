import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { v4 as uuid } from "uuid";

import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("host-transfer-proxy");

interface PendingTransfer {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  requestId: string;
  transferId: string;
  conversationId: string;
  direction: "to_host" | "to_sandbox";
  filePath: string;
  overwrite?: boolean;
  sizeBytes?: number;
  sha256?: string;
  fileBuffer?: Buffer;
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort: () => void;
}

/**
 * Compute a size-adaptive timeout in milliseconds.
 *
 * Formula: max(120_000, (sizeBytes / (1024 * 1024)) * 1000 + 30_000)
 * This gives 120s minimum, plus ~1s per MB + 30s buffer for larger files.
 */
function computeTimeoutMs(sizeBytes?: number): number {
  if (sizeBytes == null) return 120_000;
  const sizeBased = (sizeBytes / (1024 * 1024)) * 1000 + 30_000;
  return Math.max(120_000, sizeBased);
}

export class HostTransferProxy {
  private static _instance: HostTransferProxy | null = null;

  /**
   * Override for tests: when set, all timeout durations use this value instead
   * of the size-adaptive computation.  Reset to `undefined` after tests.
   * @internal
   */
  static _testTimeoutOverrideMs: number | undefined;

  /**
   * Lazily-initialized singleton. Availability of an actual desktop
   * connection is checked at send time via the assistant event hub,
   * not at construction time.
   */
  static get instance(): HostTransferProxy {
    if (!HostTransferProxy._instance) {
      log.info("Creating singleton HostTransferProxy");
      HostTransferProxy._instance = new HostTransferProxy();
    }
    return HostTransferProxy._instance;
  }

  /** Dispose the singleton. Called during graceful shutdown. */
  static disposeInstance(): void {
    if (HostTransferProxy._instance) {
      HostTransferProxy._instance.dispose();
      HostTransferProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostTransferProxy._instance = null;
  }

  /** Pending transfers keyed by requestId (for resolution from client results). */
  private pending = new Map<string, PendingTransfer>();
  /** Pending transfers keyed by transferId (for content endpoint lookups). */
  private transfers = new Map<string, PendingTransfer>();

  /**
   * Whether a client with `host_file` capability is connected.
   * Transfers piggyback on the host_file capability.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_file") != null
    );
  }

  private send(msg: ServerMessage): void {
    broadcastMessage(msg, undefined, { targetCapability: "host_file" });
  }

  /**
   * Request a file transfer from the sandbox to the host machine.
   *
   * Reads the source file, computes SHA-256, and sends a host_transfer_request
   * message with direction "to_host". The file buffer is stored so the content
   * endpoint can serve it to the client.
   */
  requestToHost(
    input: {
      sourcePath: string;
      destPath: string;
      overwrite: boolean;
      conversationId: string;
    },
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();
    const transferId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      readFile(input.sourcePath)
        .then((fileBuffer) => {
          // Check again after async read in case signal fired during I/O.
          if (signal?.aborted) {
            resolve({ content: "Aborted", isError: true });
            return;
          }

          const sizeBytes = fileBuffer.length;
          const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
          const timeoutMs =
            HostTransferProxy._testTimeoutOverrideMs ??
            computeTimeoutMs(sizeBytes);

          let detachAbort: () => void = () => {};

          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            this.transfers.delete(transferId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            log.warn(
              { requestId, transferId, direction: "to_host" },
              "Host transfer proxy request timed out",
            );
            resolve({
              content:
                "Host transfer proxy timed out waiting for client response",
              isError: true,
            });
          }, timeoutMs);

          if (signal) {
            const onAbort = () => {
              if (this.pending.has(requestId)) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                this.transfers.delete(transferId);
                detachAbort();
                pendingInteractions.resolve(requestId);
                try {
                  this.send({
                    type: "host_transfer_cancel",
                    requestId,
                    conversationId: input.conversationId,
                  });
                } catch {
                  // Best-effort cancel notification — connection may already be closed.
                }
                resolve({ content: "Aborted", isError: true });
              }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            detachAbort = () => signal.removeEventListener("abort", onAbort);
          }

          const entry: PendingTransfer = {
            resolve,
            reject,
            timer,
            requestId,
            transferId,
            conversationId: input.conversationId,
            direction: "to_host",
            filePath: input.destPath,
            sizeBytes,
            sha256,
            fileBuffer,
            detachAbort,
          };
          this.pending.set(requestId, entry);
          this.transfers.set(transferId, entry);

          try {
            this.send({
              type: "host_transfer_request",
              requestId,
              conversationId: input.conversationId,
              direction: "to_host",
              transferId,
              destPath: input.destPath,
              sizeBytes,
              sha256,
              overwrite: input.overwrite,
            });
          } catch (err) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            this.transfers.delete(transferId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            log.warn(
              { requestId, transferId, err },
              "Host transfer proxy send failed",
            );
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })
        .catch((err) => {
          log.warn(
            { requestId, sourcePath: input.sourcePath, err },
            "Failed to read source file for host transfer",
          );
          resolve({
            content: `Failed to read source file: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        });
    });
  }

  /**
   * Request a file transfer from the host machine to the sandbox.
   *
   * Sends a host_transfer_request message with direction "to_sandbox".
   * The Promise resolves when the client pushes the file content and it
   * is written to the destination path with SHA-256 verification.
   */
  requestToSandbox(
    input: {
      sourcePath: string;
      destPath: string;
      overwrite?: boolean;
      conversationId: string;
    },
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();
    const transferId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timeoutMs = HostTransferProxy._testTimeoutOverrideMs ?? 120_000;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.transfers.delete(transferId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, transferId, direction: "to_sandbox" },
          "Host transfer proxy request timed out",
        );
        resolve({
          content: "Host transfer proxy timed out waiting for client response",
          isError: true,
        });
      }, timeoutMs);

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            this.transfers.delete(transferId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            try {
              this.send({
                type: "host_transfer_cancel",
                requestId,
                conversationId: input.conversationId,
              });
            } catch {
              // Best-effort cancel notification — connection may already be closed.
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      const entry: PendingTransfer = {
        resolve,
        reject,
        timer,
        requestId,
        transferId,
        conversationId: input.conversationId,
        direction: "to_sandbox",
        filePath: input.destPath,
        overwrite: input.overwrite,
        detachAbort,
      };
      this.pending.set(requestId, entry);
      this.transfers.set(transferId, entry);

      try {
        this.send({
          type: "host_transfer_request",
          requestId,
          conversationId: input.conversationId,
          direction: "to_sandbox",
          transferId,
          sourcePath: input.sourcePath,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.transfers.delete(transferId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, transferId, err },
          "Host transfer proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Resolve a to_host transfer result from the client.
   */
  resolveTransferResult(
    requestId: string,
    result: {
      isError: boolean;
      bytesWritten?: number;
      errorMessage?: string;
    },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host transfer request for response");
      return;
    }
    clearTimeout(entry.timer);
    entry.detachAbort();
    this.pending.delete(requestId);
    this.transfers.delete(entry.transferId);

    if (result.isError) {
      entry.resolve({
        content: result.errorMessage ?? "Host transfer failed",
        isError: true,
      });
    } else {
      entry.resolve({
        content: `File transferred successfully${result.bytesWritten != null ? ` (${result.bytesWritten} bytes)` : ""}`,
        isError: false,
      });
    }
  }

  /**
   * Get the content for a to_host transfer (the GET content endpoint).
   *
   * TransferIds are single-use: the entry is removed from the transfers
   * map after the first access, so subsequent calls return null.
   */
  getTransferContent(
    transferId: string,
  ): { buffer: Buffer; sizeBytes: number; sha256: string } | null {
    const entry = this.transfers.get(transferId);
    if (
      !entry ||
      !entry.fileBuffer ||
      entry.sizeBytes == null ||
      !entry.sha256
    ) {
      return null;
    }
    // Single-use: consume the transfer from the transfers map.
    // The pending map entry stays alive for the result resolution.
    this.transfers.delete(transferId);
    return {
      buffer: entry.fileBuffer,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    };
  }

  /**
   * Receive file content from the client for a to_sandbox transfer (the PUT content endpoint).
   *
   * Writes the data to the sandbox destination path and verifies the SHA-256 hash.
   * Resolves the pending request on success.
   */
  async receiveTransferContent(
    transferId: string,
    data: Buffer,
    sha256Header: string,
  ): Promise<{ accepted: boolean; error?: string }> {
    const entry = this.transfers.get(transferId);
    if (!entry) {
      return { accepted: false, error: "Unknown or expired transfer ID" };
    }

    if (entry.direction !== "to_sandbox") {
      return {
        accepted: false,
        error: "Transfer is not a to_sandbox transfer",
      };
    }

    const computedHash = createHash("sha256").update(data).digest("hex");
    if (computedHash !== sha256Header) {
      return {
        accepted: false,
        error: `SHA-256 mismatch: expected ${sha256Header}, got ${computedHash}`,
      };
    }

    const { requestId } = entry;

    // Enforce overwrite policy before writing.
    if (entry.overwrite !== true && existsSync(entry.filePath)) {
      const errorMsg = `Destination file already exists: ${entry.filePath}. Set overwrite to true to replace it.`;
      clearTimeout(entry.timer);
      entry.detachAbort();
      this.pending.delete(requestId);
      this.transfers.delete(transferId);
      entry.resolve({ content: errorMsg, isError: true });
      return { accepted: false, error: errorMsg };
    }

    const cleanup = () => {
      clearTimeout(entry.timer);
      entry.detachAbort();
      this.pending.delete(requestId);
      this.transfers.delete(transferId);
    };

    try {
      await mkdir(dirname(entry.filePath), { recursive: true });
      await writeFile(entry.filePath, data);
      cleanup();
      entry.resolve({
        content: `File received and written to ${entry.filePath} (${data.length} bytes)`,
        isError: false,
      });
      return { accepted: true };
    } catch (err) {
      const errorMsg = `Failed to write file: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(
        { transferId, filePath: entry.filePath, err },
        "Failed to write received transfer content",
      );
      cleanup();
      entry.resolve({ content: errorMsg, isError: true });
      return { accepted: false, error: errorMsg };
    }
  }

  /** Cancel a pending transfer by requestId. */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.detachAbort();
    this.pending.delete(requestId);
    this.transfers.delete(entry.transferId);
    pendingInteractions.resolve(requestId);
    try {
      this.send({
        type: "host_transfer_cancel",
        requestId,
        conversationId: entry.conversationId,
      });
    } catch {
      // Best-effort cancel notification — connection may already be closed.
    }
    entry.resolve({ content: "Transfer cancelled", isError: true });
  }

  hasPendingTransfer(transferId: string): boolean {
    return this.transfers.has(transferId);
  }

  /**
   * Look up the requestId for a given transferId.
   * Used by route handlers to correlate transfer content endpoints with
   * pending interactions.
   */
  getRequestIdForTransfer(transferId: string): string | null {
    const entry = this.transfers.get(transferId);
    return entry?.requestId ?? null;
  }

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      pendingInteractions.resolve(requestId);
      try {
          this.send({
            type: "host_transfer_cancel",
            requestId,
            conversationId: entry.conversationId,
          });
        } catch {
          // Best-effort cancel notification — connection may already be closed.
        }
      entry.reject(
        new AssistantError(
          "Host transfer proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
    this.pending.clear();
    this.transfers.clear();
  }
}
