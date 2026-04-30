import { v4 as uuid } from "uuid";

import { assistantEventHub, broadcastMessage } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { readImageBase64 } from "../tools/shared/filesystem/image-read.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";
import type { HostFileRequest } from "./message-types/host-file.js";

/** Distributive omit that preserves union variant fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Clean input type for callers — transport envelope fields are added by the proxy. */
export type HostFileInput = DistributiveOmit<
  HostFileRequest,
  "type" | "requestId" | "conversationId"
>;

const log = getLogger("host-file-proxy");

interface PendingRequest {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  operation: HostFileInput["operation"];
  path: string;
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort: () => void;
}

export class HostFileProxy {
  private static _instance: HostFileProxy | null = null;

  /**
   * Lazily-initialized singleton. Availability of an actual desktop
   * connection is checked at send time via the assistant event hub,
   * not at construction time.
   */
  static get instance(): HostFileProxy {
    if (!HostFileProxy._instance) {
      log.info("Creating singleton HostFileProxy");
      HostFileProxy._instance = new HostFileProxy();
    }
    return HostFileProxy._instance;
  }

  /** Dispose the singleton. Called during graceful shutdown. */
  static disposeInstance(): void {
    if (HostFileProxy._instance) {
      HostFileProxy._instance.dispose();
      HostFileProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostFileProxy._instance = null;
  }

  private pending = new Map<string, PendingRequest>();

  /**
   * Whether a client with `host_file` capability is connected.
   * Note: host_file covers both file operations and transfers.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_file") != null
    );
  }

  private send(msg: ServerMessage): void {
    broadcastMessage(msg);
  }

  request(
    input: HostFileInput,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      // File operations should be fast — 30 second timeout.
      const timeoutSec = 30;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, operation: input.operation },
          "Host file proxy request timed out",
        );
        resolve({
          content: "Host file proxy timed out waiting for client response",
          isError: true,
        });
      }, timeoutSec * 1000);

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            try {
              this.send({
                type: "host_file_cancel",
                requestId,
              } as ServerMessage);
            } catch {
              // Best-effort cancel notification — connection may already be closed.
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        operation: input.operation,
        path: input.path,
        detachAbort,
      });

      try {
        this.send({
          ...input,
          type: "host_file_request",
          requestId,
          conversationId,
        } as ServerMessage);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, operation: input.operation, err },
          "Host file proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  resolve(
    requestId: string,
    response: { content: string; isError: boolean; imageData?: string },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host file request for response");
      return;
    }
    clearTimeout(entry.timer);
    entry.detachAbort();
    this.pending.delete(requestId);
    if (
      entry.operation === "read" &&
      !response.isError &&
      typeof response.imageData === "string" &&
      response.imageData.length > 0
    ) {
      entry.resolve(readImageBase64(response.imageData, entry.path));
      return;
    }
    entry.resolve({ content: response.content, isError: response.isError });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      pendingInteractions.resolve(requestId);
      try {
        this.send({
          type: "host_file_cancel",
          requestId,
        } as ServerMessage);
      } catch {
        // Best-effort cancel notification — connection may already be closed.
      }
      entry.reject(
        new AssistantError(
          "Host file proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
    this.pending.clear();
  }
}
