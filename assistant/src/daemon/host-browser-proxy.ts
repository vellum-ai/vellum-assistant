import { v4 as uuid } from "uuid";

import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";
import type { HostBrowserRequest } from "./message-types/host-browser.js";

/** Distributive omit that preserves union variant fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Clean input type for callers — transport envelope fields are added by the proxy. */
export type HostBrowserInput = DistributiveOmit<
  HostBrowserRequest,
  "type" | "requestId" | "conversationId"
>;

const log = getLogger("host-browser-proxy");

interface PendingRequest {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostBrowserProxy {
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
    input: HostBrowserInput,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      // CDP operations should be fast — 30 second default timeout matches host_file.
      const timeoutSec = input.timeout_seconds ?? 30;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.onInternalResolve?.(requestId);
        log.warn(
          { requestId, cdpMethod: input.cdpMethod },
          "Host browser proxy request timed out",
        );
        resolve({
          content: "Host browser proxy timed out waiting for client response",
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
            try {
              this.sendToClient({
                type: "host_browser_cancel",
                requestId,
              } as ServerMessage);
            } catch {
              // Best-effort cancel notification — connection may already be closed.
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendToClient({
        ...input,
        type: "host_browser_request",
        requestId,
        conversationId,
      } as ServerMessage);
    });
  }

  resolve(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host browser request for response");
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
      try {
        this.sendToClient({
          type: "host_browser_cancel",
          requestId,
        } as ServerMessage);
      } catch {
        // Best-effort cancel notification — connection may already be closed.
      }
      entry.reject(
        new AssistantError(
          "Host browser proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
    this.pending.clear();
  }
}
