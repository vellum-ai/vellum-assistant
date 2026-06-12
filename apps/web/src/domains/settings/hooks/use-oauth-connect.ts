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
  oauthCompletionStorageKey,
  parseOAuthCompletePayload,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { extractErrorMessage } from "@/utils/api-errors";
import {
  getProviderConnectionSignatures,
  hasNewOrChangedProviderConnection,
  wait,
} from "@/utils/oauth-connection-utils";
import { routes } from "@/utils/routes";
import type { QueryKey } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

interface UseOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  displayName: string;
  managedAvailable: boolean;
  connectionsQueryKey: QueryKey;
  allConnections: OAuthConnection[] | undefined;
}

interface UseOAuthConnectResult {
  handleConnect: () => void;
  oauthInProgress: boolean;
  startOAuthPending: boolean;
}

/**
 * Orchestrates the OAuth connect flow for both web (popup) and native
 * (SFSafariViewController) platforms. Manages popup lifecycle, message/storage
 * event listeners, native deep link completion, and connection polling.
 */
export function useOAuthConnect({
  assistantId,
  providerKey,
  displayName,
  managedAvailable,
  connectionsQueryKey,
  allConnections,
}: UseOAuthConnectOptions): UseOAuthConnectResult {
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{
    requestId: string;
    provider: string;
    baselineConnectionSignatures: ReadonlyMap<string, string>;
  } | null>(null);
  const popupCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const popupClosedGraceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  const clearPendingRequest = () => {
    pendingRequestRef.current = null;
    setOAuthInProgress(false);
  };

  const closePopupWindow = () => {
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
  };

  const handleOAuthCompletePayload = useCallback(
    (payload: OAuthCompletePayload) => {
      if (payload.type !== "vellum:oauth-complete") {
        return;
      }

      if (
        !pendingRequestRef.current ||
        payload.requestId !== pendingRequestRef.current.requestId
      ) {
        return;
      }

      const { oauthStatus, oauthCode } = payload;

      closePopupWindow();
      clearPendingRequest();

      if (oauthStatus === "connected") {
        toast.success(`${displayName} account connected.`);
        queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      } else {
        const errorMsg = oauthCode
          ? `Error: ${oauthCode}`
          : "Authorization failed";
        toast.error(`${displayName} ${errorMsg}`);
      }
    },
    [connectionsQueryKey, displayName, queryClient],
  );

  const waitForProviderConnection = useCallback(
    async (
      baselineSignatures: ReadonlyMap<string, string>,
    ): Promise<boolean> => {
      if (!managedAvailable) return false;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0) {
          await wait(750);
        }

        try {
          queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
          const connections = await queryClient.fetchQuery({
            ...assistantsOauthConnectionsListOptions({
              path: { assistant_id: assistantId },
            }),
            staleTime: 0,
          });

          if (
            hasNewOrChangedProviderConnection(
              connections,
              providerKey,
              baselineSignatures,
            )
          ) {
            return true;
          }
        } catch {
          // Keep polling briefly; auth/session refreshes can race the callback.
        }
      }

      return false;
    },
    [assistantId, connectionsQueryKey, managedAvailable, providerKey, queryClient],
  );

  // Web: listen for postMessage / storage completion from popup
  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) {
        return;
      }

      const payload = getOAuthCompleteMessagePayload(
        event,
        window.location.origin,
        pendingRequest.requestId,
      );
      if (payload) {
        handleOAuthCompletePayload(payload);
      }
    };

    const handleOAuthStorage = (event: StorageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) {
        return;
      }

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
    };

    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleOAuthStorage);
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleOAuthStorage);
    };
  }, [handleOAuthCompletePayload]);

  // Native: deep link completion from SFSafariViewController
  const handleOAuthDeepLink = useCallback(
    (payload: OAuthCompleteDeepLinkPayload) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) {
        return;
      }
      if (payload.requestId !== pendingRequest.requestId) {
        return;
      }
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

  // Native: browserFinished fallback for cancelled sheets
  useEffect(() => {
    return openUrlFinishedListener(() => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) {
        return;
      }

      void (async () => {
        const providerConnected = await waitForProviderConnection(
          pendingRequest.baselineConnectionSignatures,
        );
        if (!pendingRequestRef.current) {
          return;
        }
        clearPendingRequest();
        if (providerConnected) {
          toast.success(`${displayName} account connected.`);
        }
      })();
    });
  }, [waitForProviderConnection, displayName]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (popupCheckIntervalRef.current) {
        clearInterval(popupCheckIntervalRef.current);
      }
      if (popupClosedGraceTimeoutRef.current) {
        clearTimeout(popupClosedGraceTimeoutRef.current);
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };
  }, []);

  const startOAuth = useAssistantsOauthStartCreateMutation();

  const handleConnect = () => {
    if (!managedAvailable) return;

    const requestId = crypto.randomUUID();

    if (isNative) {
      setOAuthInProgress(true);
      const cachedConnections =
        queryClient.getQueryData<OAuthConnection[]>(connectionsQueryKey) ??
        allConnections;
      pendingRequestRef.current = {
        requestId,
        provider: providerKey,
        baselineConnectionSignatures: getProviderConnectionSignatures(
          cachedConnections,
          providerKey,
        ),
      };
      startOAuth.mutate(
        {
          path: { assistant_id: assistantId, provider: providerKey },
          body: {
            requested_scopes: [],
            redirect_after_connect: `${routes.account.oauth.popupComplete}?requestId=${requestId}&native=1`,
          },
        },
        {
          onSuccess(data) {
            void openUrl(data.connect_url);
          },
          onError(error) {
            clearPendingRequest();
            const detail = extractErrorMessage(
              error,
              undefined,
              `Failed to start ${displayName} authorization.`,
            );
            toast.error(detail);
          },
        },
      );
      return;
    }

    const popup = window.open("", "_blank", "width=500,height=600");

    if (popup === null) {
      toast.error("Popup blocked. Please enable popups and try again.");
      return;
    }

    popupRef.current = popup;
    setOAuthInProgress(true);
    const cachedConnections =
      queryClient.getQueryData<OAuthConnection[]>(connectionsQueryKey) ??
      allConnections;
    pendingRequestRef.current = {
      requestId,
      provider: providerKey,
      baselineConnectionSignatures: getProviderConnectionSignatures(
        cachedConnections,
        providerKey,
      ),
    };

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
          if (!pendingRequest) {
            return;
          }

          const storedCompletion = window.localStorage.getItem(
            oauthCompletionStorageKey(pendingRequest.requestId),
          );
          if (storedCompletion) {
            const parsed = parseOAuthCompletePayload(storedCompletion);
            if (parsed && parsed.requestId === pendingRequest.requestId) {
              handleOAuthCompletePayload(parsed);
              window.localStorage.removeItem(
                oauthCompletionStorageKey(pendingRequest.requestId),
              );
              return;
            }
          }

          const providerConnected = await waitForProviderConnection(
            pendingRequest.baselineConnectionSignatures,
          );
          if (!pendingRequestRef.current) {
            return;
          }
          if (providerConnected) {
            closePopupWindow();
            clearPendingRequest();
            toast.success(`${displayName} account connected.`);
            return;
          }

          closePopupWindow();
          clearPendingRequest();
          toast.error(
            `${displayName} connection failed: authorization popup closed.`,
          );
        }, 1000);
      }
    }, 100);

    startOAuth.mutate(
      {
        path: { assistant_id: assistantId, provider: providerKey },
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
            toast.error(`${displayName} connection failed: popup closed.`);
          }
        },
        onError(error) {
          closePopupWindow();
          clearPendingRequest();
          const detail = extractErrorMessage(
            error,
            undefined,
            `Failed to start ${displayName} authorization.`,
          );
          toast.error(detail);
        },
      }
    );
  };

  return {
    handleConnect,
    oauthInProgress,
    startOAuthPending: startOAuth.isPending,
  };
}
