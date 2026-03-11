import { v4 as uuid } from "uuid";

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
  "type" | "requestId" | "sessionId"
>;

const log = getLogger("host-file-proxy");

interface PendingRequest {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      // File operations should be fast — 30 second timeout.
      const timeoutSec = 30;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
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

      this.pending.set(requestId, { resolve, reject, timer });

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            this.onInternalResolve?.(requestId);
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendToClient({
        ...input,
        type: "host_file_request",
        requestId,
        sessionId,
      } as ServerMessage);
    });
  }

  resolve(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host file request for response");
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
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
      this.onInternalResolve?.(requestId);
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
