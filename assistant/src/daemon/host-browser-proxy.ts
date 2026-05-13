import { v4 as uuid } from "uuid";

import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import { enforceSameActorOrErrorResult } from "../runtime/auth/same-actor.js";
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

/**
 * Pick the host_browser-capable client to dispatch to.
 *
 * When `targetClientId` is supplied, the client with that id is looked
 * up directly in the `host_browser`-capable roster. The same-actor check
 * in `request()` still runs on the returned client when
 * `sourceActorPrincipalId` is present.
 *
 * When `sourceActorPrincipalId` is supplied (and no explicit target),
 * candidate clients are filtered down to those owned by the same actor.
 * Returns `undefined` when no same-actor client is connected; the
 * caller surfaces this as the existing "no active extension connection"
 * rejection.
 *
 * When neither is supplied (legacy callers without a resolved actor
 * identity), falls through to the most-recently-active host_browser
 * client so the registry singleton continues to work for single-client
 * setups.
 *
 * Within each branch, ties are broken by `lastActiveAt` descending —
 * the natural order returned by `listClientsByCapability`. Callers that
 * need a specific transport (e.g. Chrome Extension's `chrome.debugger`
 * over the macOS CDP bridge) must pass `targetClientId` explicitly via
 * the LLM-facing param added in #30066.
 */
function resolveTargetClient(
  sourceActorPrincipalId: string | undefined,
  targetClientId?: string,
) {
  if (targetClientId != null) {
    const clients = assistantEventHub.listClientsByCapability("host_browser");
    return clients.find((c) => c.clientId === targetClientId);
  }

  const candidates =
    assistantEventHub.listClientsByCapability("host_browser");
  if (sourceActorPrincipalId == null) {
    return candidates[0];
  }
  return candidates.find(
    (c) => c.actorPrincipalId === sourceActorPrincipalId,
  );
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

  /**
   * Whether a client with `host_browser` capability is connected.
   * Returns `true` when either the Chrome Extension or the macOS SSE
   * bridge is available — i.e. any transport can forward host-browser
   * requests.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_browser") != null
    );
  }

  /**
   * Whether a Chrome Extension client specifically is connected.
   * Returns `false` when only the macOS SSE bridge is available.
   * Unlike {@link isAvailable}, this does not consider the macOS bridge
   * a valid extension transport.
   */
  hasExtensionClient(): boolean {
    return assistantEventHub.listClientsByInterface("chrome-extension").length > 0;
  }

  /**
   * Send a host_browser request to the connected extension/macOS bridge.
   *
   * When `targetClientId` is supplied, the proxy dispatches to that specific
   * client (subject to the `host_browser` capability check and the same-actor
   * gate below). This mirrors the `target_client_id` pattern on `host_bash`,
   * `host_file_*`, and `host_cu`.
   *
   * When `sourceActorPrincipalId` is supplied, the proxy refuses to dispatch
   * to a client owned by a different actor — same-user enforcement is the
   * authoritative gate against routing one actor's CDP request onto another
   * actor's connected extension. The resolved target's `clientId` and
   * `actorPrincipalId` are then persisted alongside the pending interaction
   * so that the result-route's same-actor check can verify the submitting
   * client at result time.
   *
   * When `sourceActorPrincipalId` is undefined (legacy/internal flows
   * with no resolved actor identity), falls back to the most-recently-
   * active host_browser client without an actor filter so the registry
   * singleton continues to work for single-client setups.
   */
  request(
    input: HostBrowserInput,
    conversationId: string,
    signal?: AbortSignal,
    sourceActorPrincipalId?: string,
    targetClientId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    // Resolve the target client up front so we can persist the actor binding
    // alongside the pending interaction registration. Same shape as
    // host-cu-proxy: the result-route same-actor check compares the
    // submitting client's actor against this captured value.
    const preferredClient = resolveTargetClient(sourceActorPrincipalId, targetClientId);

    // Same-user enforcement: when the caller's actor is known, refuse to
    // dispatch to a client owned by a different actor. This covers the
    // cross-client exposure case where a web/iOS turn for actor A would
    // otherwise auto-resolve to actor B's connected extension.
    if (
      sourceActorPrincipalId != null &&
      preferredClient != null &&
      preferredClient.actorPrincipalId !== sourceActorPrincipalId
    ) {
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: preferredClient.clientId,
        op: "host_browser",
      });
      if (rejection) return Promise.resolve(rejection);
    }

    const resolvedClientId = preferredClient?.clientId;
    const targetActorPrincipalId = preferredClient?.actorPrincipalId;
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
        targetClientId: resolvedClientId,
        targetActorPrincipalId,
        rpcResolve: resolve as (v: unknown) => void,
        rpcReject: reject,
        timer,
        detachAbort,
      });

      try {
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
