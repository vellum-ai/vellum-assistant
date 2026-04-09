import { v4 as uuid } from "uuid";

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
  private pending = new Map<string, PendingRequest>();
  private sendToClient: (msg: ServerMessage) => void;
  private onInternalResolve?: (requestId: string) => void;
  private clientConnected = false;

  constructor(
    sendToClient: (msg: ServerMessage) => void,
    onInternalResolve?: (requestId: string) => void,
  ) {
    this.sendToClient = sendToClient;
    this.onInternalResolve = onInternalResolve;
  }

  updateSender(
    sendToClient: (msg: ServerMessage) => void,
    clientConnected: boolean,
  ): void {
    this.sendToClient = sendToClient;
    this.clientConnected = clientConnected;
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

      // Declared up-front so onAbort (defined before detachAbort is assigned)
      // can close over a stable reference once it's wired below.
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        this.onInternalResolve?.(requestId);
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
            // Abort fired — nothing to detach, but call the no-op for symmetry
            // so callers can rely on detachAbort being idempotent.
            detachAbort();
            this.onInternalResolve?.(requestId);
            try {
              this.sendToClient({
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
        this.sendToClient({
          ...input,
          type: "host_file_request",
          requestId,
          conversationId,
        } as ServerMessage);
      } catch (err) {
        // Sender threw synchronously (e.g. client transport error during
        // event emission). Clean up pending state and timer so we don't
        // leak an in-flight entry that nothing will ever resolve.
        clearTimeout(timer);
        this.pending.delete(requestId);
        detachAbort();
        this.onInternalResolve?.(requestId);
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

  isAvailable(): boolean {
    return this.clientConnected;
  }

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      this.onInternalResolve?.(requestId);
      try {
        this.sendToClient({
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
