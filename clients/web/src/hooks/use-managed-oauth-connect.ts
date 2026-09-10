import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthConnectionsListQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import {
  getOAuthCompleteStoragePayload,
  oauthCompletionStorageKey,
  parseOAuthCompletePayload,
} from "@/lib/auth/oauth-popup";

import {
  startManagedOAuth,
  type ManagedOAuthError,
} from "@/lib/auth/managed-oauth";
import { managedOAuthErrorMessage } from "@/lib/auth/managed-oauth-copy";
import {
  CONNECTION_CONFIRM_WINDOW_MS,
  CONNECTION_POLL_INTERVAL_MS,
  CONNECTION_POLL_WINDOW_MS,
} from "@/lib/auth/oauth-connect-timing";
import { resolveLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";
import {
  oauthConnectAttemptKey,
  useOAuthConnectAttemptStore,
} from "@/stores/oauth-connect-attempt-store";
import {
  findNewOrChangedProviderConnection,
  getProviderConnectionSignatures,
} from "@/utils/oauth-connection-utils";

/**
 * Managed OAuth connect, driven by the connections list.
 *
 * A connection exists when the platform says it exists. Everything else is a
 * way to hear about it sooner, in latency order: the completion page's
 * `localStorage` write, which crosses a browsing-context group that
 * `Cross-Origin-Opener-Policy` has severed; a refetch when the user returns to
 * this window, which is when the authorization window closed either way; and a
 * poll as the backstop.
 *
 * The authorization window is opened and then forgotten. A document carrying
 * COOP disowns the opener's handle, after which `closed` reads `true` while the
 * window is still open and `close()` does nothing, so the handle can report
 * neither success nor cancellation. Cancellation is a gesture instead: the
 * caller's dismiss control. Closing the window, switching tabs and walking away
 * say nothing, and are read as nothing.
 */

/**
 * `localStorage` throws where a privacy or cookie policy blocks site data, and
 * the completion page already treats writing it as best effort. The event
 * transports and the connections poll carry the flow without it.
 */
function readStoredCompletion(requestId: string): string | null {
  try {
    return window.localStorage.getItem(oauthCompletionStorageKey(requestId));
  } catch {
    return null;
  }
}

function clearStoredCompletion(requestId: string): void {
  try {
    window.localStorage.removeItem(oauthCompletionStorageKey(requestId));
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

export type ManagedOAuthConnectStatus = "idle" | "attempting" | "connected";

export interface UseManagedOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  /** Provider name for user-facing copy. */
  providerLabel: string;
  /**
   * Full replacement set of OAuth scopes; see
   * OAuthConnectSurfaceData.requestedScopes for semantics.
   * Omit to use platform defaults.
   */
  requestedScopes?: string[];
}

export interface UseManagedOAuthConnectResult {
  /** Pass scopes to request a subset for this attempt; omit for the default. */
  connect: (overrideScopes?: string[]) => void;
  /** The user's own cancellation. Nothing else ends an attempt. */
  dismiss: () => void;
  status: ManagedOAuthConnectStatus;
  /** The connection this attempt produced, once one appears. */
  connection: OAuthConnection | null;
  errorMessage: string | null;
}

export function useManagedOAuthConnect({
  assistantId,
  providerKey,
  providerLabel,
  requestedScopes,
}: UseManagedOAuthConnectOptions): UseManagedOAuthConnectResult {
  const queryClient = useQueryClient();
  const key = oauthConnectAttemptKey(assistantId, providerKey);
  const attempt = useOAuthConnectAttemptStore.use.attempts()[key];
  const startAttempt = useOAuthConnectAttemptStore.use.startAttempt();
  const readyAttempt = useOAuthConnectAttemptStore.use.readyAttempt();
  const confirmAttempt = useOAuthConnectAttemptStore.use.confirmAttempt();
  const clearAttempt = useOAuthConnectAttemptStore.use.clearAttempt();

  const [connection, setConnection] = useState<OAuthConnection | null>(null);
  /** A callback-confirmed success whose account the list never reported. */
  const [confirmedWithoutConnection, setConfirmedWithoutConnection] =
    useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const platformAssistantId = attempt?.platformAssistantId;

  const invalidateConnections = useCallback(
    (forAssistantId: string | undefined) =>
      forAssistantId === undefined
        ? Promise.resolve()
        : queryClient.invalidateQueries({
            queryKey: assistantsOauthConnectionsListQueryKey({
              path: { assistant_id: forAssistantId },
            }),
          }),
    [queryClient],
  );

  // Only observed while an authorization is open. The list has other readers
  // (the settings integrations tab), and TanStack shares one query between
  // them, so this adds the poll rather than a second request.
  const { data: connections } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: platformAssistantId ?? "" },
    }),
    enabled: Boolean(platformAssistantId),
    refetchInterval: () =>
      attempt && Date.now() - attempt.startedAt < CONNECTION_POLL_WINDOW_MS
        ? CONNECTION_POLL_INTERVAL_MS
        : false,
    staleTime: 0,
  });

  // The connection the platform reports is the outcome. A grant only counts
  // when it differs from the pre-authorization baseline, so connecting a
  // second account reads as new and re-opening an already-connected account
  // does not.
  useEffect(() => {
    if (!attempt?.baselineSignatures || !connections) {
      return;
    }
    const granted = findNewOrChangedProviderConnection(
      connections,
      providerKey,
      attempt.baselineSignatures,
    );
    if (!granted) {
      return;
    }
    clearAttempt(key);
    setConnection(granted);
  }, [attempt, clearAttempt, connections, key, providerKey]);

  // The callback answered for this request, so the authorization succeeded
  // whether or not the list ever shows the account. Report it rather than
  // waiting on a row that may not be coming, and leave `connection` null so
  // callers do not invent details the platform never gave.
  const confirmedAt = attempt?.confirmedAt;
  useEffect(() => {
    if (!confirmedAt) {
      return;
    }
    const remaining = confirmedAt + CONNECTION_CONFIRM_WINDOW_MS - Date.now();
    const timer = setTimeout(
      () => {
        clearAttempt(key);
        setConnection(null);
        setConfirmedWithoutConnection(true);
      },
      Math.max(remaining, 0),
    );
    return () => clearTimeout(timer);
  }, [clearAttempt, confirmedAt, key]);

  const failAttempt = useCallback(
    (error: ManagedOAuthError) => {
      clearAttempt(key);
      setErrorMessage(managedOAuthErrorMessage(error, providerLabel));
    },
    [clearAttempt, key, providerLabel],
  );

  // A success only invalidates, because the list is what decides. A failure is
  // terminal: the provider said no, and no amount of refetching changes that.
  const handleCompletion = useCallback(
    (oauthStatus: string | null | undefined, oauthCode?: string | null) => {
      if (!attempt) {
        return;
      }
      if (oauthStatus === "connected") {
        confirmAttempt(key, attempt.requestId);
        void invalidateConnections(attempt.platformAssistantId);
        return;
      }
      failAttempt({
        reason: "authorization-failed",
        code: oauthCode ?? undefined,
      });
    },
    [attempt, confirmAttempt, failAttempt, invalidateConnections, key],
  );

  // Two transports for the same payload. On the web the completion page mirrors
  // it to `localStorage`, whose `storage` event reaches every other same-origin
  // context whatever browsing-context group it sits in. Native has no shared
  // `localStorage` with the in-app browser, so it arrives as a deep link.
  useEffect(() => {
    if (!attempt) {
      return;
    }
    const handleStorage = (event: StorageEvent) => {
      const payload = getOAuthCompleteStoragePayload(event, attempt.requestId);
      if (!payload) {
        return;
      }
      clearStoredCompletion(attempt.requestId);
      handleCompletion(payload.oauthStatus, payload.oauthCode);
    };
    const handleDeepLink = (
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) => {
      if (event.detail.requestId !== attempt.requestId) {
        return;
      }
      handleCompletion(event.detail.oauthStatus, event.detail.oauthCode);
    };
    // The `storage` event fires once, and only into contexts listening at that
    // moment. A connect started from a modal that closed before the callback
    // page wrote its result leaves the payload sitting there, so claim it on
    // subscribe rather than waiting for an event that has already passed.
    const stored = readStoredCompletion(attempt.requestId);
    const storedPayload = stored ? parseOAuthCompletePayload(stored) : null;
    if (storedPayload && storedPayload.requestId === attempt.requestId) {
      clearStoredCompletion(attempt.requestId);
      handleCompletion(storedPayload.oauthStatus, storedPayload.oauthCode);
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener(
      OAUTH_COMPLETE_DEEP_LINK_EVENT,
      handleDeepLink as EventListener,
    );
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleDeepLink as EventListener,
      );
    };
  }, [attempt, handleCompletion]);

  // Dismissing the native browser sheet is the native equivalent of returning
  // to this window: a reason to look again, not a cancellation.
  useEffect(() => {
    if (!attempt) {
      return;
    }
    return openUrlFinishedListener(() => {
      void invalidateConnections(attempt.platformAssistantId);
    });
  }, [attempt, invalidateConnections]);

  const connect = useCallback(
    (overrideScopes?: string[]) => {
      // The store outlives the calling component, so a remounted card reads the
      // open attempt back and cannot start a second one.
      if (
        useOAuthConnectAttemptStore.getState().attempts[key] ||
        !assistantId ||
        !providerKey
      ) {
        return;
      }
      setErrorMessage(null);
      setConnection(null);
      setConfirmedWithoutConnection(false);

      const requestId = crypto.randomUUID();
      const native = isNativePlatform();
      // Opened before any await: a `window.open` that follows one has lost the
      // click's transient activation and is blocked.
      const popup = native
        ? null
        : window.open("", "_blank", "width=500,height=600");
      if (!native && popup === null) {
        failAttempt({ reason: "popup-blocked" });
        return;
      }

      // Claimed before the setup requests run, so a double click or a remount
      // during them cannot open a second authorization into the same slot.
      startAttempt(key, { requestId, startedAt: Date.now() });

      // The setup requests outlive a dismissal. Once the slot belongs to a
      // later attempt, this one may neither hand its window to the provider
      // nor clear the slot out from under its replacement.
      const stillOurs = () =>
        useOAuthConnectAttemptStore.getState().attempts[key]?.requestId ===
        requestId;

      void (async () => {
        try {
          const resolvedAssistantId =
            await resolveLocalAssistantPlatformIdentity(assistantId);
          // Read through the query cache, so the snapshot compared against is
          // the same one the list will serve. A separately fetched baseline can
          // disagree with cached data by a token refresh alone, and that
          // difference reads as a brand new grant.
          //
          // A failure is not an empty baseline either: every existing row would
          // look new, and an account connected last week would be reported as
          // the one just authorized. Let it throw.
          const baselineSignatures = getProviderConnectionSignatures(
            await queryClient.fetchQuery({
              ...assistantsOauthConnectionsListOptions({
                path: { assistant_id: resolvedAssistantId },
              }),
              staleTime: 0,
            }),
            providerKey,
          );
          const connectUrl = await startManagedOAuth(
            resolvedAssistantId,
            providerKey,
            requestId,
            native,
            overrideScopes ?? requestedScopes,
          );

          if (!stillOurs()) {
            popup?.close();
            return;
          }
          readyAttempt(key, requestId, {
            platformAssistantId: resolvedAssistantId,
            baselineSignatures,
          });

          if (native) {
            await openUrl(connectUrl);
            return;
          }
          // Handed over and forgotten. Under COOP this handle stops reporting
          // anything true about the window.
          popup?.location.replace(connectUrl);
        } catch (error) {
          popup?.close();
          if (!stillOurs()) {
            return;
          }
          failAttempt({
            reason: "start-failed",
            detail: error instanceof Error ? error.message : undefined,
          });
        }
      })();
    },
    [
      assistantId,
      failAttempt,
      key,
      providerKey,
      queryClient,
      readyAttempt,
      requestedScopes,
      startAttempt,
    ],
  );

  const dismiss = useCallback(() => {
    clearAttempt(key);
  }, [clearAttempt, key]);

  return {
    connect,
    dismiss,
    status:
      connection || confirmedWithoutConnection
        ? "connected"
        : attempt
          ? "attempting"
          : "idle",
    connection,
    errorMessage,
  };
}
