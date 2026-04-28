import { v4 as uuid } from "uuid";

import { getChromeExtensionRegistry } from "../runtime/chrome-extension-registry.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
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
   * Lazily-initialized singleton wired to the ChromeExtensionRegistry.
   * Returns `undefined` when no extension connection is available.
   */
  static get instance(): HostBrowserProxy | undefined {
    const conn = getChromeExtensionRegistry().getAny();
    if (!conn) {
      if (HostBrowserProxy._instance) {
        HostBrowserProxy._instance.dispose();
        HostBrowserProxy._instance = null;
      }
      return undefined;
    }

    if (!HostBrowserProxy._instance) {
      log.info(
        "Creating singleton HostBrowserProxy wired to extension registry",
      );
      const sender = HostBrowserProxy.createRegistrySender();
      HostBrowserProxy._instance = new HostBrowserProxy(sender, (requestId) => {
        pendingInteractions.resolve(requestId);
      });
      HostBrowserProxy._instance.updateSender(sender, true);
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

  /** Test helper: reset the singleton so each test starts fresh. */
  static resetInstanceForTests(): void {
    HostBrowserProxy._instance = null;
  }

  private static createRegistrySender(): (msg: ServerMessage) => void {
    return (msg: ServerMessage): void => {
      const conn = getChromeExtensionRegistry().getAny();
      if (!conn) {
        throw new Error(
          "host_browser send failed: no active extension connection in registry",
        );
      }

      if (
        msg.type === "host_browser_request" &&
        "requestId" in msg &&
        typeof msg.requestId === "string"
      ) {
        pendingInteractions.register(msg.requestId, {
          conversation: null,
          conversationId: "host-browser-singleton",
          kind: "host_browser",
        });
      }

      const ok = getChromeExtensionRegistry().send(conn.guardianId, msg);
      if (!ok) {
        if (
          msg.type === "host_browser_request" &&
          "requestId" in msg &&
          typeof msg.requestId === "string"
        ) {
          pendingInteractions.resolve(msg.requestId);
        }
        throw new Error(
          `host_browser send failed: extension connection for guardian ${conn.guardianId} went away`,
        );
      }
    };
  }

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

      // Declared up-front so onAbort (defined before detachAbort is assigned)
      // can close over a stable reference once it's wired below.
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        this.onInternalResolve?.(requestId);
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
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, { resolve, reject, timer, detachAbort });

      try {
        this.sendToClient({
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
        this.onInternalResolve?.(requestId);
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
