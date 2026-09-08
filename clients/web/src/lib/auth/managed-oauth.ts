import {
  assistantsOauthConnectionsList,
  assistantsOauthStartCreate,
} from "@/generated/api/sdk.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGet } from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  isOAuthCompletePayloadForRequest,
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import {
  closeOAuthPopup,
  UNOBSERVABLE_COMPLETION_WINDOW_MS,
  watchOAuthPopup,
  type OAuthPopupWatch,
  type PopupLostReason,
} from "@/lib/auth/oauth-popup-watcher";
import { resolveLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";
import { extractErrorMessage } from "@/utils/api-errors";
import {
  findNewOrChangedProviderConnection,
  getProviderConnectionSignatures,
  wait,
} from "@/utils/oauth-connection-utils";
import { routes } from "@/utils/routes";

export type ManagedOAuthProviderSummary =
  OauthProvidersGetResponses[200]["providers"][number];

export interface ManagedOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  /**
   * Full replacement set of OAuth scopes; see
   * OAuthConnectSurfaceData.requestedScopes for semantics.
   * Omit to use platform defaults.
   */
  requestedScopes?: string[];
  /**
   * The popup can no longer be observed (see `lib/auth/oauth-popup-watcher`).
   * The flow stays armed for its own completion, but it no longer blocks a
   * retry, so a caller showing a busy state should drop it here rather than
   * hold it until the promise settles.
   */
  onDetached?: () => void;
}

export type ManagedOAuthCancelReason =
  /** The user closed the popup before it reached the provider. */
  | "popup-closed"
  /**
   * The popup went unobservable and nothing completed before the window
   * lapsed. Distinct from `popup-closed`: a COOP-disowned popup reads as
   * closed while it is still open, so this reason cannot claim the user
   * cancelled. See `lib/auth/oauth-popup-watcher`.
   */
  | "timed-out";

export type ManagedOAuthErrorReason =
  | "popup-blocked"
  | "start-failed"
  | "authorization-failed"
  | "connection-not-found"
  | "scope-conflict";

export type ManagedOAuthConnectResult =
  | { status: "connected"; connection: OAuthConnection | null }
  | { status: "cancelled"; reason: ManagedOAuthCancelReason }
  | {
      status: "error";
      reason: ManagedOAuthErrorReason;
      /**
       * Diagnostic English, always present. Do not put this in front of a
       * user: `managedOAuthErrorMessage` turns a result into localized copy.
       */
      message: string;
      /** Provider-supplied failure code, when the callback carried one. */
      code?: string;
      /**
       * Server-supplied explanation, when the failure carried one. Already
       * localized by the API and more specific than any generic copy, so it
       * wins over the catalog string.
       */
      detail?: string;
    };

export interface ManagedOAuthConnectClient {
  fetchProvider: (
    assistantId: string,
    providerKey: string,
  ) => Promise<ManagedOAuthProviderSummary | null>;
  connect: (
    options: ManagedOAuthConnectOptions,
  ) => Promise<ManagedOAuthConnectResult>;
}

const CONNECTION_POLL_ATTEMPTS = 8;
const CONNECTION_POLL_DELAY_MS = 750;

async function listOAuthConnections(
  assistantId: string,
): Promise<OAuthConnection[]> {
  const { data, error, response } = await assistantsOauthConnectionsList({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(
      extractErrorMessage(error, response, "Failed to load OAuth connections."),
    );
  }
  return data;
}

async function waitForProviderConnection(
  assistantId: string,
  providerKey: string,
  baselineSignatures: ReadonlyMap<string, string>,
): Promise<OAuthConnection | null> {
  for (let attempt = 0; attempt < CONNECTION_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await wait(CONNECTION_POLL_DELAY_MS);
    }

    try {
      const connections = await listOAuthConnections(assistantId);
      const connected = findNewOrChangedProviderConnection(
        connections,
        providerKey,
        baselineSignatures,
      );
      if (connected) {
        return connected;
      }
    } catch {
      // Auth callbacks can race session refreshes; keep polling briefly.
    }
  }

  return null;
}

export async function fetchManagedOAuthProvider(
  assistantId: string,
  providerKey: string,
): Promise<ManagedOAuthProviderSummary | null> {
  const { data, error } = await oauthProvidersGet({
    path: { assistant_id: assistantId },
    query: { supports_managed_mode: "true" },
    throwOnError: false,
  });
  if (error || !data) {
    return null;
  }
  return (
    data.providers.find(
      (provider) =>
        provider.provider_key === providerKey && provider.supports_managed_mode,
    ) ?? null
  );
}

async function startManagedOAuth(
  assistantId: string,
  providerKey: string,
  requestId: string,
  native: boolean,
  requestedScopes: string[] | undefined,
): Promise<string> {
  const redirectAfterConnect = `${routes.account.oauth.popupComplete}?requestId=${requestId}${native ? "&native=1" : ""}`;
  const { data, error, response } = await assistantsOauthStartCreate({
    path: { assistant_id: assistantId, provider: providerKey },
    body: {
      requested_scopes: requestedScopes ?? [],
      redirect_after_connect: redirectAfterConnect,
    },
    throwOnError: false,
  });

  if (error || !data?.connect_url) {
    throw new Error(
      extractErrorMessage(error, response, "Failed to start authorization."),
    );
  }

  return data.connect_url;
}

function readStoredCompletion(requestId: string): OAuthCompletePayload | null {
  const storedCompletion = window.localStorage.getItem(
    oauthCompletionStorageKey(requestId),
  );
  if (!storedCompletion) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(storedCompletion);
    return isOAuthCompletePayloadForRequest(parsed, requestId) ? parsed : null;
  } catch {
    return null;
  }
}

function runManagedOAuthConnect(
  {
    assistantId,
    providerKey,
    providerLabel,
    requestedScopes,
  }: ManagedOAuthConnectOptions,
  notifyDetached: () => void,
): Promise<ManagedOAuthConnectResult> {
  const requestId = crypto.randomUUID();
  const native = isNativePlatform();
  let detached = false;
  const onDetach = () => {
    if (detached) {
      return;
    }
    detached = true;
    // Releases the dedupe slot and notifies every caller sharing this flow,
    // including the ones that joined after it started.
    notifyDetached();
  };

  return new Promise((resolve) => {
    let popup: Window | null = null;
    let settled = false;
    let platformAssistantId: string | null = null;
    let baselineSignatures = getProviderConnectionSignatures([], providerKey);
    /**
     * Whether the pre-authorization connections snapshot actually loaded. An
     * empty map from a *failed* fetch is not the same as one from an account
     * with no connections: it would make an existing row look new, so a
     * cancelled connect would report the user's already-connected account as
     * the one they just authorized.
     */
    let baselineEstablished = false;
    /**
     * A request-specific completion has been accepted and is being reconciled.
     * `settled` only flips once that async reconciliation finishes, so without
     * this the lost-popup poll could still detach underneath an authorization
     * that already succeeded.
     */
    let completionAccepted = false;
    let popupWatch: OAuthPopupWatch | null = null;
    let unobservableDeadline: ReturnType<typeof setTimeout> | null = null;
    let nativeFinishUnsub: (() => void) | null = null;

    const clearUnobservableDeadline = () => {
      if (unobservableDeadline) {
        clearTimeout(unobservableDeadline);
        unobservableDeadline = null;
      }
    };

    const cleanup = () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleOAuthStorage);
      window.removeEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleOAuthDeepLink,
      );
      nativeFinishUnsub?.();
      nativeFinishUnsub = null;
      popupWatch?.stop();
      popupWatch = null;
      clearUnobservableDeadline();
      closeOAuthPopup(popup);
      popup = null;
    };

    const finish = (result: ManagedOAuthConnectResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      window.localStorage.removeItem(oauthCompletionStorageKey(requestId));
      resolve(result);
    };

    const pollForConnection = () =>
      platformAssistantId
        ? waitForProviderConnection(
            platformAssistantId,
            providerKey,
            baselineSignatures,
          )
        : Promise.resolve(null);

    const finishConnectedAfterPoll = async () => {
      const connection = await pollForConnection();
      if (connection) {
        finish({ status: "connected", connection });
        return;
      }
      finish({
        status: "error",
        reason: "connection-not-found",
        message: `${providerLabel} connection finished, but no connected account was found.`,
      });
    };

    const handleOAuthCompletePayload = (payload: OAuthCompletePayload) => {
      // The payload is request-specific, so the flow has its answer. Claim it
      // synchronously and disarm the detached deadline before the async
      // reconciliation below, or the deadline can resolve `timed-out` mid-poll
      // and the lost-popup poll can detach, both discarding the outcome.
      completionAccepted = true;
      clearUnobservableDeadline();
      if (payload.oauthStatus === "connected") {
        void finishConnectedAfterPoll();
        return;
      }
      finish({
        status: "error",
        reason: "authorization-failed",
        message: payload.oauthCode
          ? `${providerLabel} authorization failed: ${payload.oauthCode}`
          : `${providerLabel} authorization failed.`,
        code: payload.oauthCode ?? undefined,
      });
    };

    function handleOAuthMessage(event: MessageEvent) {
      const payload = getOAuthCompleteMessagePayload(
        event,
        window.location.origin,
        requestId,
      );
      if (payload) {
        handleOAuthCompletePayload(payload);
      }
    }

    function handleOAuthStorage(event: StorageEvent) {
      const payload = getOAuthCompleteStoragePayload(event, requestId);
      if (payload) {
        handleOAuthCompletePayload(payload);
      }
    }

    function handleOAuthDeepLink(
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) {
      const payload = event.detail;
      if (payload.requestId !== requestId) {
        return;
      }
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    }

    /**
     * The popup handle went dark. Reconcile before deciding what that meant.
     *
     * `reason === "unobservable"` cannot be reported as a cancellation: a COOP
     * response disowns the handle mid-flow, so the popup is very likely still
     * open with the user part-way through it. The flow detaches instead. It
     * keeps its completion channels armed so finishing the original popup
     * still lands, while releasing its dedupe slot and telling the caller to
     * stop blocking, so a retry opens a genuinely new popup.
     *
     * A detached flow settles only on its own `requestId` (the popup-complete
     * page mirrors its payload to `localStorage`, which still reaches us
     * across the severed browsing-context group). It deliberately stops
     * polling for a new provider connection, because that signal is
     * provider-scoped and would misattribute a retry's grant to this flow.
     */
    const handlePopupLost = async (reason: PopupLostReason) => {
      const storedCompletion = readStoredCompletion(requestId);
      if (storedCompletion) {
        handleOAuthCompletePayload(storedCompletion);
        return;
      }
      // Polling is the only evidence of completion on this path, so it needs a
      // baseline it can compare against. `finishConnectedAfterPoll` may still
      // poll without one: there the payload already proved the flow completed
      // and the poll is only looking up the row.
      const connection = baselineEstablished ? await pollForConnection() : null;
      // A completion can arrive on any channel while that poll is retrying,
      // and `onDetach` below is not guarded by `finish`: it would reset a
      // still-mounted card, release the dedupe slot, and leave a stray
      // deadline running underneath an outcome that is already decided.
      if (settled || completionAccepted) {
        return;
      }
      if (connection) {
        finish({ status: "connected", connection });
        return;
      }

      if (reason === "closed" || !platformAssistantId) {
        finish({ status: "cancelled", reason: "popup-closed" });
        return;
      }

      onDetach();
      unobservableDeadline = setTimeout(() => {
        unobservableDeadline = null;
        finish({ status: "cancelled", reason: "timed-out" });
      }, UNOBSERVABLE_COMPLETION_WINDOW_MS);
    };

    const start = async () => {
      window.addEventListener("message", handleOAuthMessage);
      window.addEventListener("storage", handleOAuthStorage);
      window.addEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleOAuthDeepLink,
      );

      if (!native) {
        popup = window.open("", "_blank", "width=500,height=600");
        if (popup === null) {
          finish({
            status: "error",
            reason: "popup-blocked",
            message: "Popup blocked. Please enable popups and try again.",
          });
          return;
        }
        popupWatch = watchOAuthPopup({
          popup,
          onLost: (reason) => {
            if (!settled) {
              void handlePopupLost(reason);
            }
          },
        });
      } else {
        // Dismissing `SFSafariViewController` is an observable close, not a
        // disowned handle, so the native path reports the unambiguous reason.
        nativeFinishUnsub = openUrlFinishedListener(() => {
          void handlePopupLost("closed");
        });
      }

      try {
        platformAssistantId =
          await resolveLocalAssistantPlatformIdentity(assistantId);
        const baselineConnections = await listOAuthConnections(
          platformAssistantId,
        )
          .then((connections) => {
            baselineEstablished = true;
            return connections;
          })
          .catch(() => []);
        baselineSignatures = getProviderConnectionSignatures(
          baselineConnections,
          providerKey,
        );
        const connectUrl = await startManagedOAuth(
          platformAssistantId,
          providerKey,
          requestId,
          native,
          requestedScopes,
        );

        if (native) {
          await openUrl(connectUrl);
          return;
        }

        // Still our own `about:blank` here, so `closed` is trustworthy.
        if (!popup || popup.closed) {
          finish({ status: "cancelled", reason: "popup-closed" });
          return;
        }
        popupWatch?.markHandedToProvider();
        popup.location.href = connectUrl;
      } catch (error) {
        finish({
          status: "error",
          reason: "start-failed",
          message:
            error instanceof Error
              ? error.message
              : `Failed to start ${providerLabel} authorization.`,
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    };

    void start();
  });
}

/**
 * In-flight managed-OAuth connects keyed by
 * `${assistantId}::${providerKey}::${normalizedScopes}`. The map lives at
 * module scope so the guard survives React remounts; the `oauth_connect`
 * card's local `"connecting"` state does not (JARVIS-1286).
 *
 * The map enforces two properties: repeats with the same scope set share the
 * one in-flight popup, and requests with a mismatched scope set are rejected
 * while another flow for the provider is in flight. Connection polling
 * (`waitForProviderConnection`) is provider-scoped, so two concurrent polling
 * flows for one provider could not attribute a granted token to the right
 * flow; at most one polling flow per provider keeps it unambiguous. A flow
 * that detaches (see `handlePopupLost`) stops polling and releases its slot,
 * so the flow that replaces it is still the only one watching the provider.
 */
interface InFlightManagedOAuthConnect {
  promise: Promise<ManagedOAuthConnectResult>;
  /**
   * Every caller sharing this flow. A remount or a second entry point joins an
   * existing flow, and each of them is showing its own busy state, so detach
   * has to reach all of them rather than only whoever started it.
   */
  detachSubscribers: Set<() => void>;
}

const inFlightManagedOAuthConnects = new Map<
  string,
  InFlightManagedOAuthConnect
>();

/**
 * Order-insensitive scope-set fingerprint for the dedupe key. Undefined and
 * empty both mean platform defaults, so they normalize to the same value.
 */
function normalizeRequestedScopes(scopes: string[] | undefined): string {
  return scopes && scopes.length > 0 ? [...scopes].sort().join(" ") : "";
}

/**
 * Connect a managed OAuth provider, deduping concurrent connects for the same
 * assistant + provider.
 *
 * A live-voice transcript re-renders constantly, so the `oauth_connect` card
 * remounts mid-flow and resets its per-instance `"connecting"` guard. Without a
 * cross-instance guard a second trigger opened a *second* popup and stacked a
 * second `storage`/`message` listener bound to a fresh `requestId`; only the
 * popup the user actually completed wrote its own `requestId`'s key, so every
 * other in-flight connect hung on "Waiting…" forever and the surface never
 * flipped to "Connected" even though the account did connect (JARVIS-1286).
 *
 * Returning the already-running promise means repeat triggers latch onto the
 * one popup + one listener set that will actually resolve. The dedupe key
 * includes the normalized scope set, so a remounted identical card (same
 * scopes) reuses the in-flight connect. A request with a mismatched scope set
 * is rejected outright while another flow for the provider is in flight:
 * connection polling is provider-scoped and cannot tell two concurrent flows'
 * tokens apart, so at most one polling flow per provider may exist. A
 * detached flow has stopped polling, so it no longer holds the slot.
 */
export function connectManagedOAuthProvider(
  options: ManagedOAuthConnectOptions,
): Promise<ManagedOAuthConnectResult> {
  const providerPrefix = `${options.assistantId}::${options.providerKey}::`;
  const dedupeKey = `${providerPrefix}${normalizeRequestedScopes(options.requestedScopes)}`;
  const existing = inFlightManagedOAuthConnects.get(dedupeKey);
  if (existing) {
    if (options.onDetached) {
      existing.detachSubscribers.add(options.onDetached);
    }
    return existing.promise;
  }

  for (const key of inFlightManagedOAuthConnects.keys()) {
    if (key.startsWith(providerPrefix)) {
      return Promise.resolve({
        status: "error",
        reason: "scope-conflict",
        message: `Another ${options.providerLabel} connection is already in progress with different scopes. Complete or dismiss it first, then try again.`,
      });
    }
  }

  const detachSubscribers = new Set<() => void>();
  if (options.onDetached) {
    detachSubscribers.add(options.onDetached);
  }

  // Only clear the entry if it is still this one. A later connect for the same
  // key can only start after this one released the slot, but the identity
  // check keeps that invariant explicit and race-proof.
  const releaseDedupeSlot = () => {
    if (inFlightManagedOAuthConnects.get(dedupeKey) === entry) {
      inFlightManagedOAuthConnects.delete(dedupeKey);
    }
  };

  const notifyDetached = () => {
    releaseDedupeSlot();
    // Snapshot first: a subscriber may start a fresh connect from its own
    // callback, and that must not mutate the set being iterated.
    for (const subscriber of [...detachSubscribers]) {
      subscriber();
    }
    detachSubscribers.clear();
  };

  const entry: InFlightManagedOAuthConnect = {
    promise: runManagedOAuthConnect(options, notifyDetached),
    detachSubscribers,
  };
  inFlightManagedOAuthConnects.set(dedupeKey, entry);
  void entry.promise.finally(releaseDedupeSlot);
  return entry.promise;
}

export const defaultManagedOAuthConnectClient: ManagedOAuthConnectClient = {
  fetchProvider: fetchManagedOAuthProvider,
  connect: connectManagedOAuthProvider,
};
