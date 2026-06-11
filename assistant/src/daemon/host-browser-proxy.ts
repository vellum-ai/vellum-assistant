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
 * Extension-only pseudo-CDP methods (Vellum.listTabs, Vellum.selectTab,
 * Vellum.closeTab, Vellum.createTab, Vellum.findTab, Vellum.attach,
 * Vellum.detach) are implemented solely by the Chrome extension's
 * dispatcher via the chrome.tabs / chrome.debugger APIs. The macOS CDP
 * bridge speaks raw CDP against localhost:9222 only and fails on every
 * `Vellum.*` method, so routing them anywhere but the extension is a
 * guaranteed failure. Prefix check rather than an allowlist so newly
 * added pseudo-methods stay covered.
 */
function isExtensionOnlyMethod(cdpMethod: string): boolean {
  return cdpMethod.startsWith("Vellum.");
}

/**
 * Structured isError result for pseudo-methods that cannot be served
 * because no Chrome Extension client is connected (or the explicit
 * target is a different transport). The `extension_required` code is
 * deliberately NOT in ExtensionCdpClient's TRANSPORT_ERROR_CODES: it
 * classifies as `cdp_error` so the factory does not fail over to a
 * backend that cannot serve `Vellum.*` either, and the message is
 * surfaced verbatim to the caller.
 */
function extensionRequiredResult(
  cdpMethod: string,
  targetInterfaceId?: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify({
      code: "extension_required",
      message:
        `${cdpMethod} requires the Chrome extension; ` +
        (targetInterfaceId
          ? `the targeted client (interface "${targetInterfaceId}") cannot handle it.`
          : "no Chrome extension client is connected."),
    }),
    isError: true,
  };
}

/**
 * Pick the host_browser-capable client to dispatch to.
 *
 * When `targetClientId` is supplied, the client with that id is looked
 * up directly in the `host_browser`-capable roster. The same-actor check
 * in `request()` still runs on the returned client when
 * `sourceActorPrincipalId` is present.
 *
 * Candidate ordering is method-aware and deterministic. Both the Chrome
 * extension and the macOS desktop bridge register the `host_browser`
 * capability, and both receive periodic heartbeats that update
 * `lastActiveAt` — so pure recency ordering is a race between transports
 * with very different capabilities:
 *
 *  - `Vellum.*` pseudo-methods: candidates are restricted to
 *    chrome-extension clients (the only transport that implements them).
 *  - Raw CDP methods: chrome-extension clients are preferred over other
 *    host_browser clients (the macOS bridge), with `lastActiveAt`
 *    descending within each group — the natural order returned by
 *    `listClientsByCapability`. Callers that want the bridge despite a
 *    connected extension must pass `targetClientId` explicitly via the
 *    LLM-facing param added in #30066.
 *
 * When `sourceActorPrincipalId` is supplied (and no explicit target),
 * candidate clients are filtered down to those owned by the same actor.
 * Returns `undefined` when no eligible client is connected.
 */
/**
 * Whether any of `clients` is dispatchable for the caller. Without an
 * actor, any client counts (legacy single-user behavior); with one,
 * only same-actor clients count — the strict match used by
 * `resolveTargetClient`.
 */
function hasClientForActor(
  clients: ReadonlyArray<{ actorPrincipalId?: string }>,
  sourceActorPrincipalId?: string,
): boolean {
  if (sourceActorPrincipalId == null) return clients.length > 0;
  return clients.some(
    (c) => c.actorPrincipalId === sourceActorPrincipalId,
  );
}

function resolveTargetClient(
  cdpMethod: string,
  sourceActorPrincipalId: string | undefined,
  targetClientId?: string,
) {
  if (targetClientId != null) {
    const clients = assistantEventHub.listClientsByCapability("host_browser");
    return clients.find((c) => c.clientId === targetClientId);
  }

  const all = assistantEventHub.listClientsByCapability("host_browser");
  const extension = all.filter((c) => c.interfaceId === "chrome-extension");
  const candidates = isExtensionOnlyMethod(cdpMethod)
    ? extension
    : [...extension, ...all.filter((c) => c.interfaceId !== "chrome-extension")];

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
   *
   * When `sourceActorPrincipalId` is supplied, only clients owned by
   * that actor count — mirroring `resolveTargetClient`'s strict actor
   * matching so availability checks never report a client the proxy
   * would refuse to dispatch to.
   */
  isAvailable(sourceActorPrincipalId?: string): boolean {
    return hasClientForActor(
      assistantEventHub.listClientsByCapability("host_browser"),
      sourceActorPrincipalId,
    );
  }

  /**
   * Whether a Chrome Extension client specifically is connected.
   * Returns `false` when only the macOS SSE bridge is available.
   * Unlike {@link isAvailable}, this does not consider the macOS bridge
   * a valid extension transport.
   *
   * When `sourceActorPrincipalId` is supplied, only extension clients
   * owned by that actor count. On a multi-actor cloud daemon, another
   * actor's connected extension must not make this actor's
   * conversations select extension-labelled transports.
   */
  hasExtensionClient(sourceActorPrincipalId?: string): boolean {
    return hasClientForActor(
      assistantEventHub.listClientsByInterface("chrome-extension"),
      sourceActorPrincipalId,
    );
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
    const preferredClient = resolveTargetClient(
      input.cdpMethod,
      sourceActorPrincipalId,
      targetClientId,
    );

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

    // Pseudo-methods can only be served by the Chrome extension. Fail fast
    // (after the same-actor gate, which stays authoritative) instead of
    // dispatching to a transport that is guaranteed to fail — the factory's
    // pinned-extension gate is the first line of defense; this covers
    // heartbeat races and bridge-routed auto-mode sends.
    if (
      isExtensionOnlyMethod(input.cdpMethod) &&
      preferredClient?.interfaceId !== "chrome-extension"
    ) {
      return Promise.resolve(
        extensionRequiredResult(input.cdpMethod, preferredClient?.interfaceId),
      );
    }

    const resolvedClientId = preferredClient?.clientId;
    const targetActorPrincipalId = preferredClient?.actorPrincipalId;
    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timeoutSec = input.timeout_seconds ?? 30;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId, "cancelled");
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
            pendingInteractions.resolve(requestId, "cancelled");
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
          pendingInteractions.resolve(requestId, "cancelled");
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
        pendingInteractions.resolve(requestId, "cancelled");
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
      pendingInteractions.resolve(entry.requestId, "cancelled");
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
