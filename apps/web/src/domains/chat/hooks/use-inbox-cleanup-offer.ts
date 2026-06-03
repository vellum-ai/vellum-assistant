/**
 * Manages the lifecycle of the in-chat inbox-cleanup offer card.
 *
 * Phase transitions: `pending` → `visible` → `dismissed`.
 * The card becomes visible when all conditions are met (activation flag on,
 * did onboarding, the chosen first task is inbox-cleanup, greeting arrived,
 * on the onboarding conversation). Once dismissed it never reappears.
 *
 * Accept ensures Google is connected before running the inbox-cleanup skill:
 * if Google is already connected it runs immediately, otherwise it kicks off
 * the existing Google OAuth flow (same start mutation + popup as the pre-chat
 * `GoogleConnectScreen`) and only runs once the popup reports success. A
 * cancelled/failed connect re-shows the offer and sends nothing.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthStartCreateMutation,
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
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

/**
 * Stable id of the inbox-cleanup first task. Mirrors `INBOX_CLEANUP_TASK_ID`
 * from `@/domains/onboarding/choose-first-task`; duplicated as a literal here
 * because the chat domain may not import from the onboarding domain
 * (`local/no-cross-domain-imports`). The page layer (active-chat-view) derives
 * `firstTask` from the real onboarding constant before passing it in.
 */
const INBOX_CLEANUP_TASK_ID = "inbox-cleanup";

/** OAuth provider key, matching `GoogleConnectScreen`. */
const GOOGLE_PROVIDER_KEY = "google";

/** Run message that matches the inbox-cleanup skill's activation hints. */
const INBOX_CLEANUP_RUN_MESSAGE =
  "Please clean up my inbox using the inbox-cleanup skill, then give me a concrete summary of how many emails you archived and by which pass.";

interface UseInboxCleanupOfferOptions {
  didOnboarding: boolean;
  firstTask: string | null;
  activationFlowEnabled: boolean;
  messages: DisplayMessage[];
  activeConversationId: string | null;
  onboardingConversationId: string | null;
  assistantId: string | null;
  sendMessage: (content: string) => void;
}

interface UseInboxCleanupOfferReturn {
  showInboxOffer: boolean;
  handleAccept: () => void;
  handleDecline: () => void;
  accepting: boolean;
}

export function useInboxCleanupOffer({
  didOnboarding,
  firstTask,
  activationFlowEnabled,
  messages,
  activeConversationId,
  onboardingConversationId,
  assistantId,
  sendMessage,
}: UseInboxCleanupOfferOptions): UseInboxCleanupOfferReturn {
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();

  const [phase, setPhase] = useState<"pending" | "visible" | "dismissed">(
    "pending",
  );
  const [accepting, setAccepting] = useState(false);

  // Latch ref: once an assistant message is seen, skip the .some() scan on
  // subsequent renders. Only computed while phase === "pending".
  const greetingSeenRef = useRef(false);
  const greetingConversationIdRef = useRef<string | null>(null);

  // Reset the greeting latch when the conversation changes so an assistant
  // message in one thread can't satisfy the latch for a different thread.
  // Sync refs in the commit phase per React 19's useRef caveats.
  useLayoutEffect(() => {
    if (greetingConversationIdRef.current !== activeConversationId) {
      greetingConversationIdRef.current = activeConversationId;
      greetingSeenRef.current = false;
    }
    if (!greetingSeenRef.current && phase === "pending") {
      greetingSeenRef.current = messages.some((m) => m.role === "assistant");
    }
  });

  // Track the conversation id when the card became visible so we can
  // dismiss on conversation switch without racing the didOnboarding flag.
  const visibleConversationIdRef = useRef<string | null>(null);

  // Transition from pending -> visible when all conditions are met.
  useEffect(() => {
    if (
      phase === "pending" &&
      activationFlowEnabled &&
      didOnboarding &&
      firstTask === INBOX_CLEANUP_TASK_ID &&
      greetingSeenRef.current &&
      activeConversationId === onboardingConversationId
    ) {
      visibleConversationIdRef.current = activeConversationId;
      setPhase("visible");
    }
    // `messages` is not read in the body; listed so this effect re-fires
    // when a new message arrives and greetingSeenRef may have just latched.
  }, [phase, activationFlowEnabled, didOnboarding, firstTask, messages, activeConversationId, onboardingConversationId]);

  // Dismiss if the user switches to a different conversation.
  useEffect(() => {
    if (
      phase === "visible" &&
      visibleConversationIdRef.current !== null &&
      activeConversationId !== visibleConversationIdRef.current
    ) {
      setPhase("dismissed");
    }
  }, [phase, activeConversationId]);

  const dismiss = useCallback(() => {
    setPhase("dismissed");
  }, []);

  const handleDecline = useCallback(() => {
    dismiss();
  }, [dismiss]);

  // ---------------------------------------------------------------------------
  // Google OAuth connect-if-needed (mirrors `GoogleConnectScreen`).
  // ---------------------------------------------------------------------------

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{ requestId: string } | null>(null);
  const popupCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupClosedGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const storageListenerRef = useRef<((event: StorageEvent) => void) | null>(null);
  const nativeFinishUnsubRef = useRef<(() => void) | null>(null);

  const startOAuth = useMutation({
    ...assistantsOauthStartCreateMutation(),
  });

  // `sendMessage` is read by `runInboxCleanup`; keep it in a ref so the OAuth
  // callbacks stay stable while always running the latest sender. Synced in the
  // commit phase (refs must not be written during render).
  const sendMessageRef = useRef(sendMessage);
  useLayoutEffect(() => {
    sendMessageRef.current = sendMessage;
  });

  const runInboxCleanup = useCallback(() => {
    dismiss();
    sendMessageRef.current(INBOX_CLEANUP_RUN_MESSAGE);
  }, [dismiss]);

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

  const clearPendingRequest = useCallback(() => {
    pendingRequestRef.current = null;
  }, []);

  // Cancel/failure: stop spinning, leave the offer visible to retry, send nothing.
  const cancelConnect = useCallback(() => {
    closePopupWindow();
    clearPendingRequest();
    removeEventListeners();
    setAccepting(false);
  }, [clearPendingRequest, closePopupWindow, removeEventListeners]);

  useEffect(() => {
    return () => {
      if (popupCheckIntervalRef.current) clearInterval(popupCheckIntervalRef.current);
      if (popupClosedGraceTimeoutRef.current) clearTimeout(popupClosedGraceTimeoutRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
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
      if (!assistantId) return null;
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

  // OAuth succeeded for the pending request: tear down, then run.
  const handleOAuthSuccess = useCallback(() => {
    closePopupWindow();
    clearPendingRequest();
    removeEventListeners();
    runInboxCleanup();
  }, [clearPendingRequest, closePopupWindow, removeEventListeners, runInboxCleanup]);

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
        handleOAuthSuccess();
      } else {
        cancelConnect();
      }
    },
    [cancelConnect, handleOAuthSuccess],
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

  const startGoogleConnect = useCallback(() => {
    if (!assistantId) {
      cancelConnect();
      return;
    }

    const requestId = crypto.randomUUID();

    removeEventListeners();
    messageListenerRef.current = handleOAuthMessage;
    storageListenerRef.current = handleOAuthStorage;

    if (isNative) {
      pendingRequestRef.current = { requestId };
      startOAuth.mutate(
        {
          path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
          body: {
            requested_scopes: [],
            redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}&native=1`,
          },
        },
        {
          onSuccess(data) {
            void openUrl(data.connect_url);
          },
          onError() {
            cancelConnect();
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
          const connection = await fetchActiveGoogleConnection();
          if (!pendingRequestRef.current) return;
          if (connection) {
            handleOAuthSuccess();
          } else {
            cancelConnect();
          }
          unsubFinished();
          nativeFinishUnsubRef.current = null;
        })();
      });
      nativeFinishUnsubRef.current = unsubFinished;
      return;
    }

    const popup = window.open("", "_blank", "width=500,height=600");
    if (popup === null) {
      cancelConnect();
      return;
    }

    popupRef.current = popup;
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
              if (isOAuthCompletePayloadForRequest(parsed, pendingRequest.requestId)) {
                handleOAuthCompletePayload(parsed);
                window.localStorage.removeItem(
                  oauthCompletionStorageKey(pendingRequest.requestId),
                );
                return;
              }
            } catch {
              // Fall through to poll path.
            }
          }

          const connection = await fetchActiveGoogleConnection();
          if (!pendingRequestRef.current) return;

          if (connection) {
            handleOAuthSuccess();
          } else {
            cancelConnect();
          }
        }, 1000);
      }
    }, 100);

    startOAuth.mutate(
      {
        path: { assistant_id: assistantId, provider: GOOGLE_PROVIDER_KEY },
        body: {
          requested_scopes: [],
          redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}`,
        },
      },
      {
        onSuccess(data) {
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.location.href = data.connect_url;
          } else if (pendingRequestRef.current) {
            cancelConnect();
          }
        },
        onError() {
          cancelConnect();
        },
      },
    );
  }, [
    assistantId,
    cancelConnect,
    fetchActiveGoogleConnection,
    handleOAuthCompletePayload,
    handleOAuthMessage,
    handleOAuthStorage,
    handleOAuthSuccess,
    isNative,
    removeEventListeners,
    startOAuth,
  ]);

  const handleAccept = useCallback(() => {
    if (accepting) return;
    // Keep both buttons disabled for the whole connect→run window.
    setAccepting(true);
    void (async () => {
      const connection = await fetchActiveGoogleConnection();
      if (connection) {
        runInboxCleanup();
        return;
      }
      startGoogleConnect();
    })();
  }, [accepting, fetchActiveGoogleConnection, runInboxCleanup, startGoogleConnect]);

  return {
    showInboxOffer: phase === "visible",
    handleAccept,
    handleDecline,
    accepting,
  };
}
