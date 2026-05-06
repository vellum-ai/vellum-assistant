import { v4 as uuid } from "uuid";

import type { InterfaceId } from "../channels/types.js";
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

/** Interface priority order for host_browser: Chrome Extension first, macOS SSE bridge second. */
const HOST_BROWSER_INTERFACE_PREFERENCE: InterfaceId[] = [
  "chrome-extension",
  "macos",
];

/**
 * Pick the host_browser-capable client to dispatch to.
 *
 * When a `sourceActorPrincipalId` is supplied, candidate clients are
 * filtered down to those owned by the same actor before applying the
 * interface-preference order. Returns `undefined` when no same-actor
 * client is connected; the caller surfaces this as the existing
 * "no active extension connection" rejection.
 *
 * When `sourceActorPrincipalId` is undefined (legacy callers without a
 * resolved actor identity), falls through to the prior behavior so the
 * registry singleton continues to work as before.
 */
function resolveTargetClient(sourceActorPrincipalId: string | undefined) {
  if (sourceActorPrincipalId == null) {
    return assistantEventHub.getPreferredClientByCapability(
      "host_browser",
      HOST_BROWSER_INTERFACE_PREFERENCE,
    );
  }

  const sameActorClients = assistantEventHub
    .listClientsByCapability("host_browser")
    .filter((c) => c.actorPrincipalId === sourceActorPrincipalId);
  if (sameActorClients.length === 0) return undefined;

  // Stable sort by interface preference; lastActiveAt is the implicit
  // tiebreaker because listClientsByCapability already returns clients
  // in lastActiveAt-desc order.
  return [...sameActorClients].sort((a, b) => {
    const ai = HOST_BROWSER_INTERFACE_PREFERENCE.indexOf(a.interfaceId);
    const bi = HOST_BROWSER_INTERFACE_PREFERENCE.indexOf(b.interfaceId);
    const ea = ai === -1 ? HOST_BROWSER_INTERFACE_PREFERENCE.length : ai;
    const eb = bi === -1 ? HOST_BROWSER_INTERFACE_PREFERENCE.length : bi;
    return ea - eb;
  })[0];
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
      assistantEventHub.getPreferredClientByCapability(
        "host_browser",
        HOST_BROWSER_INTERFACE_PREFERENCE,
      ) != null
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
   * When `sourceActorPrincipalId` is supplied, the proxy refuses to dispatch
   * to a client owned by a different actor — same-user enforcement is the
   * authoritative gate against routing one actor's CDP request onto another
   * actor's connected extension. The auto-resolved target's `clientId` and
   * `actorPrincipalId` are then persisted alongside the pending interaction
   * so that the result-route's same-actor check can verify the submitting
   * client at result time.
   *
   * When `sourceActorPrincipalId` is undefined (legacy/internal flows with
   * no resolved actor identity), falls back to interface-preference
   * resolution without an actor filter, preserving prior behavior.
   */
  request(
    input: HostBrowserInput,
    conversationId: string,
    signal?: AbortSignal,
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    // Resolve the target client up front so we can persist the actor binding
    // alongside the pending interaction registration. Same shape as
    // host-cu-proxy: the result-route same-actor check compares the
    // submitting client's actor against this captured value.
    const preferredClient = resolveTargetClient(sourceActorPrincipalId);

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

    const targetClientId = preferredClient?.clientId;
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
        targetClientId,
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
