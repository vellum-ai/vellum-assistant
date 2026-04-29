import { v4 as uuid } from "uuid";

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getClientRegistry } from "../runtime/client-registry.js";
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
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort: () => void;
}

export class HostBrowserProxy {
  private static _instance: HostBrowserProxy | null = null;

  /**
   * Lazily-initialized singleton. Always creates the instance on first
   * access — availability of an actual extension connection is checked
   * at send time, not at construction time.
   */
  static get instance(): HostBrowserProxy {
    if (!HostBrowserProxy._instance) {
      log.info("Creating singleton HostBrowserProxy");
      HostBrowserProxy._instance = new HostBrowserProxy();
    }
    return HostBrowserProxy._instance;
  }

  /** Dispose the singleton. Called during graceful shutdown. */
  static disposeInstance(): void {
    if (HostBrowserProxy._instance) {
      HostBrowserProxy._instance.dispose();
      HostBrowserProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostBrowserProxy._instance = null;
  }

  private pending = new Map<string, PendingRequest>();

  /**
   * Whether a client with `host_browser` capability is connected.
   */
  isAvailable(): boolean {
    return (
      getClientRegistry().getMostRecentByCapability("host_browser") != null
    );
  }

  /**
   * Publish a ServerMessage through the assistant event hub.
   */
  private sendToExtension(msg: ServerMessage): void {
    void assistantEventHub.publish(buildAssistantEvent(msg)).catch((err) => {
      log.warn({ err }, "failed to publish host_browser event to hub");
    });
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

      // Declared up-front so onAbort (defined before detachAbort is assigned)
      // can close over a stable reference once it's wired below.
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        log.warn(
          { requestId, cdpMethod: input.cdpMethod },
          "Host browser proxy request timed out",
        );
        resolve({
          content:
            "Host browser proxy timed out waiting for extension response (check browser-relay connectivity and /v1/host-browser-result callback failures such as 404/401).",
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
            try {
              this.sendToExtension({
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
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, { resolve, reject, timer, detachAbort });

      try {
        if (!this.isAvailable()) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          detachAbort();
          reject(
            new Error(
              "host_browser send failed: no active extension connection",
            ),
          );
          return;
        }

        this.sendToExtension({
          ...input,
          type: "host_browser_request",
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
        log.warn(
          { requestId, cdpMethod: input.cdpMethod, err },
          "Host browser proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  resolve(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // Benign race, not an error. A late result frame with no matching
      // pending entry means one of:
      //   - the proxy-side setTimeout has already resolved the caller;
      //   - the caller's AbortSignal fired and the entry was torn down;
      //   - a duplicate result frame was delivered (e.g. retry after a
      //     transient WS drop).
      // Log at debug so operators don't chase false-positive "timeout"
      // alerts on what is actually a cleanly-handled race.
      log.debug(
        { requestId },
        "Ignoring host_browser_result for unknown or already-resolved request",
      );
      return;
    }
    clearTimeout(entry.timer);
    entry.detachAbort();
    this.pending.delete(requestId);
    entry.resolve({ content: response.content, isError: response.isError });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      try {
        this.sendToExtension({
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
