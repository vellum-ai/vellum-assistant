/**
 * Managed Google OAuth connect for the check-in onboarding page.
 *
 * SPIKE — checkin-onboarding flow.
 *
 * Lifted from the connect logic in
 * `@/domains/onboarding/screens/google-connect-screen.tsx`, but parameterized
 * with `requestedScopes` (so the check-in page can ask for ONLY
 * `calendar.events` — the minimum to create an event — instead of the full
 * Gmail+Calendar+Drive bundle) and an `onConnect(scopes)` callback. The
 * existing GoogleConnectScreen is deliberately left untouched to avoid any
 * regression on the live pre-chat Google connect; dedup is a follow-up.
 *
 * Handles the web popup flow, the native (SFSafariViewController) flow, and the
 * three completion channels (postMessage, storage event, native deep link)
 * plus a popup-closed connection poll as a fallback.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  assistantsOauthConnectionsListOptions,
  useAssistantsOauthStartCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useOAuthCompleteDeepLinkListener } from "@/hooks/use-oauth-complete-deep-link-listener";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  isOAuthCompletePayloadForRequest,
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { wait } from "@/utils/oauth-connection-utils";
import { routes } from "@/utils/routes";

const GOOGLE_PROVIDER_KEY = "google";

// Fallback connection poll: the OAuth callback can land a moment before the
// backend has persisted the connection row, so a single fetch races it. Mirror
// the managed-oauth helper and retry briefly before giving up.
const CONNECTION_POLL_ATTEMPTS = 8;
const CONNECTION_POLL_DELAY_MS = 750;

/** Minimum Google scope needed to create a calendar event (read/write events). */
export const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/**
 * Identity scopes required for the managed OAuth flow to finalize a connection.
 * Without them the platform can't resolve the Google account (no access to the
 * userinfo endpoint / id token) and the grant fails with `identity_failed` — no
 * connection row is created. These are part of the managed app's default scope
 * set, which is why the full-bundle connect works; a calendar-only override
 * drops them. Cheap from a consent standpoint (email + basic identity) and
 * still far narrower than Gmail/Drive.
 */
const GOOGLE_IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * The minimal working scope set for the check-in connect: account identity plus
 * calendar-event read/write. No Gmail, no Drive, no full-calendar read.
 */
export const GOOGLE_CALENDAR_CONNECT_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
];

interface UseGoogleCalendarConnectOptions {
  assistantId: string;
  /** Scopes to request. Defaults to identity + calendar-events (the minimum
   *  that produces a working managed connection). */
  requestedScopes?: string[];
  /** Called with the scopes actually granted once the connection lands. */
  onConnect: (scopes: string[]) => void;
}

interface UseGoogleCalendarConnectResult {
  handleConnect: () => void;
  oauthInProgress: boolean;
}

export function useGoogleCalendarConnect({
  assistantId,
  requestedScopes = GOOGLE_CALENDAR_CONNECT_SCOPES,
  onConnect,
}: UseGoogleCalendarConnectOptions): UseGoogleCalendarConnectResult {
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{ requestId: string } | null>(null);
  const popupCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const popupClosedGraceTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(
    null,
  );
  const storageListenerRef = useRef<((event: StorageEvent) => void) | null>(
    null,
  );
  const nativeFinishUnsubRef = useRef<(() => void) | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  const clearPendingRequest = useCallback(() => {
    pendingRequestRef.current = null;
    setOAuthInProgress(false);
  }, []);

  const removeEventListeners = useCallback(() => {
    if (messageListenerRef.current) {
      window.removeEventListener("message", messageListenerRef.current);
      messageListenerRef.current = null;
    }
    if (storageListenerRef.current) {
      window.removeEventListener("storage", storageListenerRef.current);
      storageListenerRef.current = null;
    }
  }, []);

  const closePopupWindow = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;
    if (popupCheckIntervalRef.current) {
      clearInterval(popupCheckIntervalRef.current);
      popupCheckIntervalRef.current = null;
    }
    if (popupClosedGraceTimeoutRef.current) {
      clearTimeout(popupClosedGraceTimeoutRef.current);
      popupClosedGraceTimeoutRef.current = null;
    }
  }, []);

  const startOAuth = useAssistantsOauthStartCreateMutation();

  useEffect(() => {
    return () => {
      if (popupCheckIntervalRef.current)
        clearInterval(popupCheckIntervalRef.current);
      if (popupClosedGraceTimeoutRef.current)
        clearTimeout(popupClosedGraceTimeoutRef.current);
      if (popupRef.current && !popupRef.current.closed)
        popupRef.current.close();
      if (messageListenerRef.current) {
        window.removeEventListener("message", messageListenerRef.current);
      }
      if (storageListenerRef.current) {
        window.removeEventListener("storage", storageListenerRef.current);
      }
      if (nativeFinishUnsubRef.current) {
        nativeFinishUnsubRef.current();
        nativeFinishUnsubRef.current = null;
      }
    };
  }, []);

  const fetchActiveGoogleConnection =
    useCallback(async (): Promise<OAuthConnection | null> => {
      try {
        const connections = await queryClient.fetchQuery({
          ...assistantsOauthConnectionsListOptions({
            path: { assistant_id: assistantId },
          }),
          staleTime: 0,
        });
        return (
          (connections as OAuthConnection[]).find(
            (c) => c.provider === GOOGLE_PROVIDER_KEY && c.connected,
          ) ?? null
        );
      } catch {
        return null;
      }
    }, [assistantId, queryClient]);

  const waitForActiveGoogleConnection =
    useCallback(async (): Promise<OAuthConnection | null> => {
      for (let attempt = 0; attempt < CONNECTION_POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await wait(CONNECTION_POLL_DELAY_MS);
        const connection = await fetchActiveGoogleConnection();
        if (connection) return connection;
      }
      return null;
    }, [fetchActiveGoogleConnection]);

  const handleOAuthSuccess = useCallback(async () => {
    closePopupWindow();
    clearPendingRequest();
    const connection = await fetchActiveGoogleConnection();
    onConnect(connection?.scopes_granted ?? []);
  }, [
    clearPendingRequest,
    closePopupWindow,
    fetchActiveGoogleConnection,
    onConnect,
  ]);

  const handleOAuthCompletePayload = useCallback(
    (payload: OAuthCompletePayload) => {
      if (payload.type !== "vellum:oauth-complete") return;
      if (
        !pendingRequestRef.current ||
        payload.requestId !== pendingRequestRef.current.requestId
      ) {
        return;
      }
      if (payload.oauthStatus === "connected") {
        void handleOAuthSuccess();
      } else {
        closePopupWindow();
        clearPendingRequest();
      }
    },
    [clearPendingRequest, closePopupWindow, handleOAuthSuccess],
  );

  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      const payload = getOAuthCompleteMessagePayload(
        event,
        window.location.origin,
        pendingRequest.requestId,
      );
      if (payload) handleOAuthCompletePayload(payload);
    },
    [handleOAuthCompletePayload],
  );

  const handleOAuthStorage = useCallback(
    (event: StorageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      const payload = getOAuthCompleteStoragePayload(
        event,
        pendingRequest.requestId,
      );
      if (payload) {
        handleOAuthCompletePayload(payload);
        window.localStorage.removeItem(
          oauthCompletionStorageKey(pendingRequest.requestId),
        );
      }
    },
    [handleOAuthCompletePayload],
  );

  const handleOAuthDeepLink = useCallback(
    (payload: OAuthCompleteDeepLinkPayload) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;
      if (payload.requestId !== pendingRequest.requestId) return;
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    },
    [handleOAuthCompletePayload],
  );
  useOAuthCompleteDeepLinkListener(handleOAuthDeepLink);

  const handleConnect = useCallback(() => {
    const requestId = crypto.randomUUID();

    removeEventListeners();
    messageListenerRef.current = handleOAuthMessage;
    storageListenerRef.current = handleOAuthStorage;

    if (isNative) {
      setOAuthInProgress(true);
      pendingRequestRef.current = { requestId };
      startOAuth.mutate(
        {
          path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
          body: {
            requested_scopes: requestedScopes,
            redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}&native=1`,
          },
        },
        {
          onSuccess(data) {
            void openUrl(data.connect_url);
          },
          onError() {
            clearPendingRequest();
          },
        },
      );

      window.addEventListener("message", handleOAuthMessage);
      window.addEventListener("storage", handleOAuthStorage);

      if (nativeFinishUnsubRef.current) nativeFinishUnsubRef.current();
      const unsubFinished = openUrlFinishedListener(() => {
        const pendingRequest = pendingRequestRef.current;
        if (!pendingRequest) {
          unsubFinished();
          nativeFinishUnsubRef.current = null;
          return;
        }
        void (async () => {
          const connection = await waitForActiveGoogleConnection();
          if (!pendingRequestRef.current) return;
          if (connection) {
            await handleOAuthSuccess();
          } else {
            clearPendingRequest();
          }
          removeEventListeners();
          unsubFinished();
          nativeFinishUnsubRef.current = null;
        })();
      });
      nativeFinishUnsubRef.current = unsubFinished;
      return;
    }

    const popup = window.open("", "_blank", "width=500,height=600");
    if (popup === null) {
      removeEventListeners();
      return;
    }

    popupRef.current = popup;
    setOAuthInProgress(true);
    pendingRequestRef.current = { requestId };

    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleOAuthStorage);

    popupCheckIntervalRef.current = setInterval(() => {
      if (
        popupRef.current &&
        popupRef.current.closed &&
        pendingRequestRef.current &&
        !popupClosedGraceTimeoutRef.current
      ) {
        popupClosedGraceTimeoutRef.current = setTimeout(async () => {
          popupClosedGraceTimeoutRef.current = null;
          const pendingRequest = pendingRequestRef.current;
          if (!pendingRequest) return;

          const storedCompletion = window.localStorage.getItem(
            oauthCompletionStorageKey(pendingRequest.requestId),
          );
          if (storedCompletion) {
            try {
              const parsed: unknown = JSON.parse(storedCompletion);
              if (
                isOAuthCompletePayloadForRequest(
                  parsed,
                  pendingRequest.requestId,
                )
              ) {
                handleOAuthCompletePayload(parsed);
                window.localStorage.removeItem(
                  oauthCompletionStorageKey(pendingRequest.requestId),
                );
                removeEventListeners();
                return;
              }
            } catch {
              // Fall through to poll path.
            }
          }

          const connection = await waitForActiveGoogleConnection();
          if (!pendingRequestRef.current) return;

          if (connection) {
            await handleOAuthSuccess();
          } else {
            closePopupWindow();
            clearPendingRequest();
          }
          removeEventListeners();
        }, 1000);
      }
    }, 100);

    startOAuth.mutate(
      {
        path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
        body: {
          requested_scopes: requestedScopes,
          redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}`,
        },
      },
      {
        onSuccess(data) {
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.location.href = data.connect_url;
          } else if (pendingRequestRef.current) {
            closePopupWindow();
            clearPendingRequest();
            removeEventListeners();
          }
        },
        onError() {
          closePopupWindow();
          clearPendingRequest();
          removeEventListeners();
        },
      },
    );
  }, [
    assistantId,
    clearPendingRequest,
    closePopupWindow,
    handleOAuthCompletePayload,
    handleOAuthMessage,
    handleOAuthStorage,
    handleOAuthSuccess,
    isNative,
    removeEventListeners,
    requestedScopes,
    startOAuth,
    waitForActiveGoogleConnection,
  ]);

  return {
    handleConnect,
    oauthInProgress: oauthInProgress || startOAuth.isPending,
  };
}
