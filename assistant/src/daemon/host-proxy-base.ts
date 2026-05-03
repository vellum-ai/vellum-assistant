/**
 * Shared lifecycle base for host-proxy classes (HostBashProxy, HostCuProxy,
 * HostFileProxy, HostTransferProxy, HostBrowserProxy, ...).
 *
 * Each host proxy:
 *  - dispatches a request to the desktop client via the assistant event hub,
 *  - tracks the request in a pending map keyed by `requestId`,
 *  - times the request out after a configurable interval,
 *  - cancels the request when the caller's `AbortSignal` fires,
 *  - rejects all pending requests on `dispose()`,
 *  - exposes `isAvailable()` based on the connected client's capabilities.
 *
 * Subclasses keep proxy-specific concerns (envelope shape, observation
 * formatting, per-proxy state like CU's step counter) out of the base.
 */
import { v4 as uuid } from "uuid";

import type { HostProxyCapability } from "../channels/types.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("host-proxy-base");

/**
 * `broadcastMessage` is statically typed against the discriminated
 * `ServerMessage` union. The base class assembles envelopes from
 * constructor-supplied event names and untyped extra fields, so static
 * narrowing is impossible — subclasses are responsible for passing event
 * names that match a real `ServerMessage` variant.
 */
function broadcastDynamic(envelope: Record<string, unknown>): void {
  broadcastMessage(envelope as unknown as ServerMessage);
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Reason a pending request was rejected by the base. */
export type HostProxyRejectionReason = "timeout" | "aborted" | "disposed";

/**
 * Error thrown by the base when a pending request is rejected via the
 * lifecycle paths (timeout, abort, dispose). Subclasses inspect `reason`
 * to map back to their proxy-specific error / observation shape.
 */
export class HostProxyRequestError extends AssistantError {
  constructor(
    message: string,
    public readonly reason: HostProxyRejectionReason,
  ) {
    super(message, ErrorCode.INTERNAL_ERROR);
    this.name = "HostProxyRequestError";
  }
}

interface PendingEntry<TResultPayload> {
  resolve: (payload: TResultPayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  conversationId: string;
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort: () => void;
}

export interface HostProxyBaseOptions {
  /** Capability advertised by clients that can service this proxy. */
  capabilityName: HostProxyCapability;
  /** Outbound message `type` for new requests (e.g. `"host_cu_request"`). */
  requestEventName: string;
  /** Outbound message `type` for cancellation (e.g. `"host_cu_cancel"`). */
  cancelEventName: string;
  /** Tag used to identify this proxy's requests in `pendingInteractions`. */
  resultPendingKind: string;
  /** Per-request timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Customizable disposed-rejection message (used in test assertions). */
  disposedMessage?: string;
}

export abstract class HostProxyBase<TRequest, TResultPayload> {
  protected pending = new Map<string, PendingEntry<TResultPayload>>();

  protected readonly capabilityName: HostProxyCapability;
  protected readonly requestEventName: string;
  protected readonly cancelEventName: string;
  protected readonly resultPendingKind: string;
  protected readonly timeoutMs: number;
  protected readonly disposedMessage: string;

  constructor(opts: HostProxyBaseOptions) {
    this.capabilityName = opts.capabilityName;
    this.requestEventName = opts.requestEventName;
    this.cancelEventName = opts.cancelEventName;
    this.resultPendingKind = opts.resultPendingKind;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.disposedMessage = opts.disposedMessage ?? "Host proxy disposed";
  }

  /**
   * Whether a client advertising the configured capability is connected.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability(this.capabilityName) !=
      null
    );
  }

  /**
   * Dispatch a request envelope to the connected client and return a
   * promise that resolves when the client responds (via `resolve()`),
   * rejects on timeout/abort/dispose, or rejects synchronously if the
   * broadcast itself fails.
   *
   * `extraFields` is shallow-merged into the broadcast envelope so
   * subclasses can include proxy-specific top-level fields (e.g. CU's
   * `stepNumber` / `reasoning`) without nesting them inside `input`.
   *
   * Named `dispatchRequest` rather than `request` so subclasses are free to
   * expose their own public `request(...)` with a proxy-specific signature
   * (e.g. CU passes `stepNumber` and `reasoning` to its callers).
   */
  protected dispatchRequest(
    toolName: string,
    input: TRequest,
    conversationId: string,
    signal?: AbortSignal,
    extraFields?: Record<string, unknown>,
  ): Promise<TResultPayload> {
    const requestId = uuid();

    return new Promise<TResultPayload>((resolve, reject) => {
      // Declared up-front so onAbort can close over a stable reference once
      // it's wired below.
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, toolName, kind: this.resultPendingKind },
          "Host proxy request timed out",
        );
        reject(new HostProxyRequestError("timeout", "timeout"));
      }, this.timeoutMs);

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            try {
              broadcastDynamic({
                type: this.cancelEventName,
                requestId,
                conversationId,
              });
            } catch {
              // Best-effort cancel notification — connection may already be closed.
            }
            reject(new HostProxyRequestError("aborted", "aborted"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        conversationId,
        detachAbort,
      });

      try {
        broadcastDynamic({
          type: this.requestEventName,
          requestId,
          conversationId,
          toolName,
          input,
          ...(extraFields ?? {}),
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, toolName, kind: this.resultPendingKind, err },
          "Host proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Resolve a pending request with the client-provided payload. No-op when
   * no entry is registered for `requestId` (late responses after timeout
   * or abort fall through to here).
   */
  resolve(requestId: string, payload: TResultPayload): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn(
        { requestId, kind: this.resultPendingKind },
        "No pending host proxy request for response",
      );
      return;
    }
    clearTimeout(entry.timer);
    entry.detachAbort();
    this.pending.delete(requestId);
    entry.resolve(payload);
  }

  /**
   * Whether `requestId` is still registered as pending. Useful to subclasses
   * that need to reason about the lifecycle in tests.
   */
  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Reject every pending request and clear the map. Called during graceful
   * shutdown or proxy teardown.
   */
  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      pendingInteractions.resolve(requestId);
      try {
        broadcastDynamic({
          type: this.cancelEventName,
          requestId,
          conversationId: entry.conversationId,
        });
      } catch {
        // Best-effort cancel notification — connection may already be closed.
      }
      entry.reject(new HostProxyRequestError(this.disposedMessage, "disposed"));
    }
    this.pending.clear();
  }
}
