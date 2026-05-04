import { v4 as uuid } from "uuid";

import type { InterfaceId } from "../channels/types.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
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

/** Interface priority order for host_browser: Chrome Extension first, macOS SSE bridge second. */
const HOST_BROWSER_INTERFACE_PREFERENCE: InterfaceId[] = [
  "chrome-extension",
  "macos",
];

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

  /**
   * Whether a client with `host_browser` capability is connected.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getPreferredClientByCapability(
        "host_browser",
        HOST_BROWSER_INTERFACE_PREFERENCE,
      ) != null
    );
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
      const timeoutSec = input.timeout_seconds ?? 30;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, cdpMethod: input.cdpMethod },
          "Host browser proxy request timed out",
        );
        resolve({
          content:
            "Host browser proxy timed out waiting for extension response (check SSE connectivity and /v1/host-browser-result callback failures such as 404/401).",
          isError: true,
        });
      }, timeoutSec * 1000);

      if (signal) {
        const onAbort = () => {
          if (pendingInteractions.get(requestId)) {
            pendingInteractions.resolve(requestId);
            try {
              broadcastMessage({
                type: "host_browser_cancel",
                requestId,
              });
            } catch {
              // Best-effort cancel notification
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      pendingInteractions.register(requestId, {
        conversationId,
        kind: "host_browser",
        rpcResolve: resolve,
        rpcReject: reject,
        timer,
        detachAbort,
      });

      try {
        const preferredClient = assistantEventHub.getPreferredClientByCapability(
          "host_browser",
          HOST_BROWSER_INTERFACE_PREFERENCE,
        );
        if (!preferredClient) {
          pendingInteractions.resolve(requestId);
          reject(
            new Error(
              "host_browser send failed: no active extension connection",
            ),
          );
          return;
        }

        broadcastMessage(
          { ...input, type: "host_browser_request", requestId, conversationId },
          conversationId,
          { targetClientId: preferredClient.clientId },
        );
      } catch (err) {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, cdpMethod: input.cdpMethod, err },
          "Host browser proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Process a client result and resolve the RPC. Called by route handlers.
   */
  resolveResult(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction?.rpcResolve) {
      log.debug(
        { requestId },
        "Ignoring host_browser_result for unknown or already-resolved request",
      );
      return;
    }
    interaction.rpcResolve({
      content: response.content,
      isError: response.isError,
    });
  }

  dispose(): void {
    for (const entry of pendingInteractions.getByKind("host_browser")) {
      pendingInteractions.resolve(entry.requestId);
      try {
        broadcastMessage({
          type: "host_browser_cancel",
          requestId: entry.requestId,
        });
      } catch {
        // Best-effort cancel notification
      }
      entry.rpcReject?.(
        new AssistantError(
          "Host browser proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
  }
}
