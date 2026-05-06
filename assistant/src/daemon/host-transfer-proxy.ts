import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { v4 as uuid } from "uuid";

import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("host-transfer-proxy");

/**
 * Lightweight entry for the transfers map (keyed by transferId).
 * Points back to the requestId so route handlers can correlate
 * content endpoints with the pending interaction.
 */
interface TransferEntry {
  requestId: string;
  transferId: string;
  direction: "to_host" | "to_sandbox";
  filePath: string;
  overwrite?: boolean;
  sizeBytes?: number;
  sha256?: string;
  fileBuffer?: Buffer;
  targetClientId?: string;
  /**
   * Snapshot of `targetClientId`'s `actorPrincipalId` taken at registration
   * time. Persisted so the GET/PUT content routes compare against a stable
   * value rather than the live hub — the target client's SSE subscription
   * may briefly disconnect between dispatch and content fetch/upload.
   */
  targetActorPrincipalId?: string;
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

  /** Pending transfers keyed by transferId (for content endpoint lookups). */
  private transfers = new Map<string, TransferEntry>();
  /**
   * Briefly retains size/sha256 of a just-consumed transfer so the GET-content
   * route's `resolveResponseHeaders` callback (which the HTTP adapter invokes
   * AFTER the request handler) can still set `Content-Length` and
   * `X-Transfer-SHA256` headers. Without this, the handler's `getTransferContent`
   * call deletes the entry before the header resolver runs, and the resolver
   * silently falls back to default headers — meaning the documented response
   * headers were never actually sent. Entries here self-clear on read; a 30s
   * fallback timer prevents long-term retention if the resolver never runs.
   */
  private justConsumedMetadata = new Map<
    string,
    { sizeBytes: number; sha256: string }
  >();

  /**
   * Whether a client with `host_file` capability is connected.
   * Transfers piggyback on the host_file capability.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_file") != null
    );
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
      targetClientId?: string;
    },
    signal?: AbortSignal,
    // Principal ID of the actor on whose behalf this request is initiated.
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    let resolvedTargetClientId: string | undefined = input.targetClientId;
    if (resolvedTargetClientId != null) {
      const client = assistantEventHub.getClientById(resolvedTargetClientId);
      if (!client) {
        return Promise.resolve({
          content: `No connected client with id '${resolvedTargetClientId}' supports host_file. Run \`assistant clients list --capability host_file\` to see available clients.`,
          isError: true,
        });
      }
      if (!client.capabilities.includes("host_file")) {
        return Promise.resolve({
          content: `Client '${resolvedTargetClientId}' does not support host_file. Run \`assistant clients list --capability host_file\` to see available clients.`,
          isError: true,
        });
      }
    } else {
      // Auto-resolve to the unique same-user client; reject ambiguous
      // (multi-machine) cases so a single targeted-style transfer cannot
      // fan out across the user's machines.
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_file",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return Promise.resolve(ambiguousSameUserError("host_file"));
      }
      resolvedTargetClientId =
        resolved.kind === "match" ? resolved.clientId : undefined;
    }

    if (resolvedTargetClientId != null) {
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: resolvedTargetClientId,
        op: "host_transfer",
      });
      if (rejection != null) return Promise.resolve(rejection);
    }

    const requestId = uuid();
    const transferId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      readFile(input.sourcePath)
        .then((fileBuffer) => {
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
            this.transfers.delete(transferId);
            pendingInteractions.resolve(requestId);
            log.warn(
              { requestId, transferId, direction: "to_host" },
              "Host transfer proxy request timed out",
            );
            resolve({
              content: resolvedTargetClientId
                ? `Host transfer proxy timed out waiting for response from client '${resolvedTargetClientId}'`
                : "Host transfer proxy timed out waiting for client response",
              isError: true,
            });
          }, timeoutMs);

          if (signal) {
            const onAbort = () => {
              if (pendingInteractions.get(requestId)) {
                this.transfers.delete(transferId);
                pendingInteractions.resolve(requestId);
                try {
                  broadcastMessage(
                    {
                      type: "host_transfer_cancel",
                      requestId,
                      conversationId: input.conversationId,
                      ...(resolvedTargetClientId != null
                        ? { targetClientId: resolvedTargetClientId }
                        : {}),
                    },
                    input.conversationId,
                    { targetClientId: resolvedTargetClientId },
                  );
                } catch {
                  // Best-effort cancel notification
                }
                resolve({ content: "Aborted", isError: true });
              }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            detachAbort = () => signal.removeEventListener("abort", onAbort);
          }

          this.transfers.set(transferId, {
            requestId,
            transferId,
            direction: "to_host",
            filePath: input.destPath,
            sizeBytes,
            sha256,
            fileBuffer,
            targetClientId: resolvedTargetClientId,
            targetActorPrincipalId:
              resolvedTargetClientId != null
                ? assistantEventHub.getActorPrincipalIdForClient(
                    resolvedTargetClientId,
                  )
                : undefined,
          });

          pendingInteractions.register(requestId, {
            conversationId: input.conversationId,
            kind: "host_transfer",
            targetClientId: resolvedTargetClientId,
            targetActorPrincipalId:
              resolvedTargetClientId != null
                ? assistantEventHub.getActorPrincipalIdForClient(
                    resolvedTargetClientId,
                  )
                : undefined,
            rpcResolve: resolve as (v: unknown) => void,
            rpcReject: reject,
            timer,
            detachAbort,
            metadata: { transferId },
          });

          try {
            broadcastMessage(
              {
                type: "host_transfer_request",
                requestId,
                conversationId: input.conversationId,
                direction: "to_host",
                transferId,
                destPath: input.destPath,
                sizeBytes,
                sha256,
                overwrite: input.overwrite,
                ...(resolvedTargetClientId != null
                  ? { targetClientId: resolvedTargetClientId }
                  : {}),
              },
              input.conversationId,
              { targetClientId: resolvedTargetClientId },
            );
          } catch (err) {
            this.transfers.delete(transferId);
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
      targetClientId?: string;
    },
    signal?: AbortSignal,
    // Principal ID of the actor on whose behalf this request is initiated.
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    let resolvedTargetClientId: string | undefined = input.targetClientId;
    if (resolvedTargetClientId != null) {
      const client = assistantEventHub.getClientById(resolvedTargetClientId);
      if (!client) {
        return Promise.resolve({
          content: `No connected client with id '${resolvedTargetClientId}' supports host_file. Run \`assistant clients list --capability host_file\` to see available clients.`,
          isError: true,
        });
      }
      if (!client.capabilities.includes("host_file")) {
        return Promise.resolve({
          content: `Client '${resolvedTargetClientId}' does not support host_file. Run \`assistant clients list --capability host_file\` to see available clients.`,
          isError: true,
        });
      }
    } else {
      // Auto-resolve to the unique same-user client; reject ambiguous
      // (multi-machine) cases so a single targeted-style transfer cannot
      // fan out across the user's machines.
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_file",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return Promise.resolve(ambiguousSameUserError("host_file"));
      }
      resolvedTargetClientId =
        resolved.kind === "match" ? resolved.clientId : undefined;
    }

    if (resolvedTargetClientId != null) {
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: resolvedTargetClientId,
        op: "host_transfer",
      });
      if (rejection != null) return Promise.resolve(rejection);
    }

    const requestId = uuid();
    const transferId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timeoutMs = HostTransferProxy._testTimeoutOverrideMs ?? 120_000;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.transfers.delete(transferId);
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, transferId, direction: "to_sandbox" },
          "Host transfer proxy request timed out",
        );
        resolve({
          content: resolvedTargetClientId
            ? `Host transfer proxy timed out waiting for response from client '${resolvedTargetClientId}'`
            : "Host transfer proxy timed out waiting for client response",
          isError: true,
        });
      }, timeoutMs);

      if (signal) {
        const onAbort = () => {
          if (pendingInteractions.get(requestId)) {
            this.transfers.delete(transferId);
            pendingInteractions.resolve(requestId);
            try {
              broadcastMessage(
                {
                  type: "host_transfer_cancel",
                  requestId,
                  conversationId: input.conversationId,
                  ...(resolvedTargetClientId != null
                    ? { targetClientId: resolvedTargetClientId }
                    : {}),
                },
                input.conversationId,
                { targetClientId: resolvedTargetClientId },
              );
            } catch {
              // Best-effort cancel notification
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.transfers.set(transferId, {
        requestId,
        transferId,
        direction: "to_sandbox",
        filePath: input.destPath,
        overwrite: input.overwrite,
        targetClientId: resolvedTargetClientId,
        targetActorPrincipalId:
          resolvedTargetClientId != null
            ? assistantEventHub.getActorPrincipalIdForClient(
                resolvedTargetClientId,
              )
            : undefined,
      });

      pendingInteractions.register(requestId, {
        conversationId: input.conversationId,
        kind: "host_transfer",
        targetClientId: resolvedTargetClientId,
        targetActorPrincipalId:
          resolvedTargetClientId != null
            ? assistantEventHub.getActorPrincipalIdForClient(
                resolvedTargetClientId,
              )
            : undefined,
        rpcResolve: resolve as (v: unknown) => void,
        rpcReject: reject,
        timer,
        detachAbort,
        metadata: { transferId },
      });

      try {
        broadcastMessage(
          {
            type: "host_transfer_request",
            requestId,
            conversationId: input.conversationId,
            direction: "to_sandbox",
            transferId,
            sourcePath: input.sourcePath,
            ...(resolvedTargetClientId != null
              ? { targetClientId: resolvedTargetClientId }
              : {}),
          },
          input.conversationId,
          { targetClientId: resolvedTargetClientId },
        );
      } catch (err) {
        this.transfers.delete(transferId);
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
    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction?.rpcResolve) {
      log.warn({ requestId }, "No pending host transfer request for response");
      return;
    }
    const transferId = interaction.metadata?.transferId as string | undefined;
    if (transferId) this.transfers.delete(transferId);

    if (result.isError) {
      interaction.rpcResolve({
        content: result.errorMessage ?? "Host transfer failed",
        isError: true,
      });
    } else {
      interaction.rpcResolve({
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
    // Stash size/sha256 so the GET-content route's `resolveResponseHeaders`
    // callback can still set `Content-Length` and `X-Transfer-SHA256` on the
    // response. The HTTP adapter invokes the handler (this method) BEFORE the
    // response-header resolver, so without this stash the resolver sees a
    // deleted entry and silently falls back to default headers.
    this.justConsumedMetadata.set(transferId, {
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    });
    // Fallback cleanup: if the resolver never reads (e.g., handler error after
    // consume, request abort), drop the metadata after a short grace window.
    // `unref()` so the timer never holds the process open.
    setTimeout(() => {
      this.justConsumedMetadata.delete(transferId);
    }, 30_000).unref?.();
    this.transfers.delete(transferId);
    return {
      buffer: entry.fileBuffer,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    };
  }

  /**
   * Returns and clears the size/sha256 metadata for a transfer that was just
   * consumed by `getTransferContent`. Intended for use by the GET-content
   * route's `resolveResponseHeaders` callback to populate `Content-Length` and
   * `X-Transfer-SHA256` response headers. Returns null if no metadata is
   * cached (e.g., transfer was never consumed, or already read by a previous
   * resolver call).
   */
  takeJustConsumedTransferMetadata(
    transferId: string,
  ): { sizeBytes: number; sha256: string } | null {
    const meta = this.justConsumedMetadata.get(transferId);
    if (!meta) return null;
    this.justConsumedMetadata.delete(transferId);
    return meta;
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

    if (entry.overwrite !== true && existsSync(entry.filePath)) {
      const errorMsg = `Destination file already exists: ${entry.filePath}. Set overwrite to true to replace it.`;
      const interaction = pendingInteractions.resolve(requestId);
      this.transfers.delete(transferId);
      interaction?.rpcResolve?.({ content: errorMsg, isError: true });
      return { accepted: false, error: errorMsg };
    }

    const cleanup = () => {
      pendingInteractions.resolve(requestId);
      this.transfers.delete(transferId);
    };

    try {
      await mkdir(dirname(entry.filePath), { recursive: true });
      await writeFile(entry.filePath, data);
      const interaction = pendingInteractions.get(requestId);
      cleanup();
      interaction?.rpcResolve?.({
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
      const interaction = pendingInteractions.get(requestId);
      cleanup();
      interaction?.rpcResolve?.({ content: errorMsg, isError: true });
      return { accepted: false, error: errorMsg };
    }
  }

  /** Cancel a pending transfer by requestId. */
  cancel(requestId: string): void {
    const interaction = pendingInteractions.get(requestId);
    if (!interaction) return;
    const transferId = interaction.metadata?.transferId as string | undefined;
    if (transferId) this.transfers.delete(transferId);
    pendingInteractions.resolve(requestId);
    try {
      broadcastMessage(
        {
          type: "host_transfer_cancel",
          requestId,
          conversationId: interaction.conversationId,
          ...(interaction.targetClientId != null
            ? { targetClientId: interaction.targetClientId }
            : {}),
        },
        interaction.conversationId,
        { targetClientId: interaction.targetClientId },
      );
    } catch {
      // Best-effort cancel notification
    }
    interaction.rpcResolve?.({ content: "Transfer cancelled", isError: true });
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

  /**
   * Look up the targetClientId for a given transferId without consuming the entry.
   * Routes call this to verify ownership without affecting the transfer state.
   * Returns null when untargeted (no validation needed).
   */
  getTargetClientIdForTransfer(transferId: string): string | null {
    return this.transfers.get(transferId)?.targetClientId ?? null;
  }

  /**
   * Look up the persisted `targetActorPrincipalId` for a given transferId
   * without consuming the entry. Routes call this for the same-actor
   * binding check so it's stable across brief SSE reconnects.
   */
  getTargetActorPrincipalIdForTransfer(transferId: string): string | undefined {
    return this.transfers.get(transferId)?.targetActorPrincipalId;
  }

  dispose(): void {
    for (const entry of pendingInteractions.getByKind("host_transfer")) {
      const transferId = entry.metadata?.transferId as string | undefined;
      if (transferId) this.transfers.delete(transferId);
      pendingInteractions.resolve(entry.requestId);
      try {
        broadcastMessage(
          {
            type: "host_transfer_cancel",
            requestId: entry.requestId,
            conversationId: entry.conversationId,
            ...(entry.targetClientId != null
              ? { targetClientId: entry.targetClientId }
              : {}),
          },
          entry.conversationId,
          { targetClientId: entry.targetClientId },
        );
      } catch {
        // Best-effort cancel notification
      }
      entry.rpcReject?.(
        new AssistantError(
          "Host transfer proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
    this.transfers.clear();
  }
}
