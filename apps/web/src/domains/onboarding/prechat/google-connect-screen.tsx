
import { AppImage } from "@/adapters/app-image.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { OnboardingLayout } from "@/components/app/onboarding/OnboardingLayout.js";
import { useIsNativePlatform } from "@/lib/native-auth.js";
import { PRECHAT_TOOLS } from "@/lib/onboarding/prechat-tools.js";
import type { OAuthCompleteDeepLinkPayload } from "@/lib/native-deep-link.js";
import { useOAuthCompleteDeepLinkListener } from "@/lib/use-oauth-complete-deep-link-listener.js";
import { openUrl, openUrlFinishedListener } from "@/lib/browser.js";
import { routes } from "@/lib/routes.js";
import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthStartCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { OAuthConnection } from "@/generated/api/types.gen.js";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  isOAuthCompletePayloadForRequest,
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/components/app/settings/integration-detail-modal.js";

const GOOGLE_PROVIDER_KEY = "google";

interface GoogleConnectScreenProps {
  /** The active assistant ID — available after hatching. */
  assistantId: string;
  /** The user-chosen assistant name, used in copy. */
  assistantName: string;
  /** Google tool IDs the user selected on the previous screen (e.g. "gmail", "google-calendar"). */
  selectedGoogleToolIds: string[];
  /** Called when the user successfully connects Google. */
  onConnect: (scopes: string[]) => void;
  /** Called when the user skips the Google connection. */
  onSkip: () => void;
  /** Called to navigate back to the previous screen. */
  onBack: () => void;
}

/**
 * Pre-chat onboarding screen (Variant A) that invites the user to connect
 * their Google account before starting the first conversation. Connecting
 * allows the daemon to scan email and calendar for context. Skipping
 * advances without setting connection state.
 */
export function GoogleConnectScreen({
  assistantId,
  assistantName,
  selectedGoogleToolIds,
  onConnect,
  onSkip,
  onBack,
}: GoogleConnectScreenProps) {
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{ requestId: string } | null>(null);
  const popupCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const popupClosedGraceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track active event listeners so they can be cleaned up on unmount even
  // when the OAuth flow hasn't completed (fixes listener leak).
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const storageListenerRef = useRef<((event: StorageEvent) => void) | null>(null);
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

  const startOAuth = useMutation({
    ...assistantsOauthStartCreateMutation(),
  });

  // Cleanup on unmount: close any open popup, cancel timers, and remove
  // event listeners so nothing fires after the component is gone.
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
    };
  }, []);

  /**
   * Fetch the live Google connection list and return the connected entry
   * (if any). Used both to check whether a connection was established and
   * to read back the scopes that were granted.
   */
  const fetchActiveGoogleConnection = useCallback(async (): Promise<OAuthConnection | null> => {
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

  const handleOAuthSuccess = useCallback(async () => {
    closePopupWindow();
    clearPendingRequest();
    const connection = await fetchActiveGoogleConnection();
    onConnect(connection?.scopes_granted ?? []);
  }, [clearPendingRequest, closePopupWindow, fetchActiveGoogleConnection, onConnect]);

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

  // Web: listen for the postMessage from the OAuth popup completion page.
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

  // Web: listen for the localStorage event (cross-tab completion).
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

  // Native: deep-link completion (SFSafariViewController).
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

    // Remove any stale listeners from a previous flow before adding new ones.
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
            requested_scopes: [],
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

      // openUrlFinishedListener: fires when the native browser sheet closes
      // (user cancel or deep-link redirect). If the deep-link handler already
      // cleared pendingRequestRef, this is a no-op.
      const unsubFinished = openUrlFinishedListener(() => {
        const pendingRequest = pendingRequestRef.current;
        if (!pendingRequest) return;
        void (async () => {
          const connection = await fetchActiveGoogleConnection();
          if (!pendingRequestRef.current) return;
          if (connection) {
            await handleOAuthSuccess();
          } else {
            clearPendingRequest();
          }
          removeEventListeners();
          unsubFinished();
        })();
      });
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
              const parsed = JSON.parse(storedCompletion) as unknown;
              if (isOAuthCompletePayloadForRequest(parsed, pendingRequest.requestId)) {
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

          const connection = await fetchActiveGoogleConnection();
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
          requested_scopes: [],
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
    fetchActiveGoogleConnection,
    handleOAuthCompletePayload,
    handleOAuthMessage,
    handleOAuthStorage,
    handleOAuthSuccess,
    isNative,
    removeEventListeners,
    startOAuth,
  ]);

  const _displayName = assistantName || "your assistant";
  const displayNameCapitalized = assistantName || "Your assistant";

  const selectedToolItems = useMemo(
    () => PRECHAT_TOOLS.filter((t) => selectedGoogleToolIds.includes(t.id)),
    [selectedGoogleToolIds],
  );

  const RESOURCE_LABELS: Record<string, string> = {
    gmail: "inbox",
    "google-calendar": "calendar",
    "google-drive": "drive",
  };
  const resourceParts = selectedGoogleToolIds
    .map((id) => RESOURCE_LABELS[id])
    .filter(Boolean);
  const resourcesLabel =
    resourceParts.length <= 1
      ? resourceParts[0] ?? "Google account"
      : resourceParts.slice(0, -1).join(", ") + " and " + resourceParts[resourceParts.length - 1];

  return (
    <OnboardingLayout>
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 pb-40 pt-12 text-[var(--content-default)]">
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center"
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {/* typography: off-scale — hero onboarding h1 (30px) intentionally larger than text-title-large (24px) to match macOS onboarding visual weight */}
          { }
          <h1 className="text-center text-3xl font-semibold tracking-tight">
            Connect to Google
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className="mt-4 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          {`${displayNameCapitalized} will scan your ${resourcesLabel} to learn what's on your plate. Expect something genuinely useful before your first conversation ends.`}
        </p>

        <div
          className="mt-6 flex items-stretch justify-center gap-3"
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {selectedToolItems.map((tool) => (
            <div
              key={tool.id}
              className="flex w-24 flex-col items-center gap-2.5 rounded-2xl bg-[var(--surface-lift)] px-3 pb-3 pt-4"
            >
              {tool.logoSrc ? (
                <AppImage
                  src={tool.logoSrc}
                  alt=""
                  width={28}
                  height={28}
                  className="h-7 w-7 object-contain"
                  loading="eager"
                  unoptimized
                />
              ) : null}
              {/* typography: off-scale — small label beneath icon in static card */}
              { }
              <span className="text-center text-xs leading-tight text-[var(--content-tertiary)]">
                {tool.label}
              </span>
            </div>
          ))}
        </div>

        <p
          className="mt-8 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.25s both" }}
        >
          {`${displayNameCapitalized} will never perform any actions without your permission, and you can disconnect at any time.`}
        </p>

        <div
          className="mt-8 flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.3s ease-out 0.35s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={handleConnect}
            disabled={oauthInProgress || startOAuth.isPending}
            // typography: off-scale — CTA upsize; Button primitive only exposes regular/compact so text-base forces the spec's 16px "lg" size
             
            className="h-11 text-base"
          >
            {oauthInProgress || startOAuth.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization...
              </span>
            ) : (
              "Connect Google"
            )}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            disabled={oauthInProgress || startOAuth.isPending}
            // typography: off-scale — ghost CTA paired with the primary above
             
            className="h-11 text-base"
          >
            Skip for now
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
