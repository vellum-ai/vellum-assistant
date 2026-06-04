import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Card } from "@vellum/design-library/components/card";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { Button } from "@vellum/design-library/components/button";
import { Input } from "@vellum/design-library/components/input";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { useOAuthCompleteDeepLinkListener } from "@/hooks/use-oauth-complete-deep-link-listener";
import { routes } from "@/utils/routes";
import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthConnectionsListQueryKey,
  assistantsOauthDisconnectByConnectionCreateMutation,
  assistantsOauthStartCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import {
  createOAuthApp,
  deleteOAuthApp,
  deleteOAuthAppConnection,
  formatOAuthTimestamp,
  listOAuthApps,
  listOAuthAppConnections,
  maskClientId,
  startOAuthAppConnect,
  type OAuthApp,
  type OAuthAppConnection,
} from "@/domains/settings/api/oauth-apps";

import { fetchOAuthProviderDetail } from "@/domains/settings/api/oauth-providers";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  type OAuthCompletePayload,
  oauthCompletionStorageKey,
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
} from "@/lib/auth/oauth-popup";

import type { PlatformGateState } from "@/hooks/use-platform-gate";
import { extractErrorMessage } from "@/utils/api-errors";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerConnectionSignature(connection: OAuthConnection): string {
  return JSON.stringify({
    status: connection.status,
    connected: connection.connected,
    account_label: connection.account_label,
    scopes_granted: [...connection.scopes_granted].sort(),
    expires_at: connection.expires_at,
  });
}

export function getProviderConnectionSignatures(
  connections: readonly OAuthConnection[] | undefined,
  providerKey: string,
): Map<string, string> {
  return new Map(
    (connections ?? [])
      .filter((connection) => connection.provider === providerKey)
      .map((connection) => [
        connection.id,
        providerConnectionSignature(connection),
      ]),
  );
}

export function hasNewOrChangedProviderConnection(
  connections: readonly OAuthConnection[],
  providerKey: string,
  baselineSignatures: ReadonlyMap<string, string>,
): boolean {
  return connections.some(
    (connection) =>
      connection.provider === providerKey &&
      connection.connected &&
      baselineSignatures.get(connection.id) !==
        providerConnectionSignature(connection),
  );
}

type ModalTab = "managed" | "your-own";

interface IntegrationDetailModalProps {
  assistantId: string;
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  platformGate: PlatformGateState;
  onClose: () => void;
}

/**
 * Mirrors the macOS desktop `IntegrationDetailModal`: provider header,
 * Managed / Your Own segmented tabs, an empty state that prompts the
 * user to connect an account, and a connection list with a per-row
 * disconnect action.
 */
export function IntegrationDetailModal({
  assistantId,
  providerKey,
  displayName,
  description,
  logoUrl,
  platformGate,
  onClose,
}: IntegrationDetailModalProps) {
  const queryClient = useQueryClient();
  const isNative = useIsNativePlatform();
  const managedAvailable = platformGate === "full";
  const [activeTab, setActiveTab] = useState<ModalTab>(
    platformGate === "gated" ? "your-own" : "managed",
  );
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(
    null,
  );
  const [connectionPendingDisconnect, setConnectionPendingDisconnect] =
    useState<OAuthConnection | null>(null);

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<{
    requestId: string;
    provider: string;
    baselineConnectionSignatures: ReadonlyMap<string, string>;
  } | null>(null);
  const popupCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const popupClosedGraceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  const clearPendingRequest = useCallback(() => {
    pendingRequestRef.current = null;
    setOAuthInProgress(false);
  }, []);

  // Web-only: close the OAuth popup window we opened and tear down the
  // close-watcher interval / grace timeout. No-op on Capacitor iOS, where
  // OAuth runs in `SFSafariViewController` and `popupRef` is never set.
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

  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: assistantId },
  });

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
    [
      clearPendingRequest,
      closePopupWindow,
      connectionsQueryKey,
      displayName,
      queryClient,
    ],
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

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

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

  // Native completion path. `SFSafariViewController` has no `window.opener`
  // and a sandboxed `localStorage`, so the postMessage / storage handlers
  // above never fire on Capacitor iOS. Two listeners cover the native
  // flow:
  //
  //   1. Deep link (`vellum:oauth-complete-deeplink`). The
  //      `popup-complete` page redirects to a custom URL scheme, iOS
  //      dismisses the sheet, and `DeepLinkRouter` forwards the parsed
  //      payload as a window event. This is the reliable, status-aware
  //      path: success / provider-error are distinguishable, so we can
  //      surface accurate toasts and skip the post-dismiss poll.
  //   2. `browserFinished` fallback. Fires when the user cancels the
  //      sheet (no deep link), and also covers older native binaries
  //      shipped before the deep-link router was wired (the URL-scheme
  //      navigation still dismisses the sheet via iOS, but the JS
  //      listener may be absent). When it fires after a deep link
  //      already cleared `pendingRequestRef`, this branch no-ops.
  //      A negative poll stays silent — we cannot distinguish a true
  //      cancellation from a slow server-side callback, and a
  //      misleading error toast on every dismiss is worse than
  //      silence (cf. `AdjustPlanModal`).
  //
  // Both listeners are no-ops on web.
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
  }, [clearPendingRequest, waitForProviderConnection, displayName]);

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

  const { data: allConnections, isLoading: connectionsLoading } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: managedAvailable,
  });

  const providerConnections: OAuthConnection[] = (allConnections ?? []).filter(
    (c) => c.provider === providerKey && c.connected,
  );

  const startOAuth = useMutation({
    ...assistantsOauthStartCreateMutation(),
  });

  const disconnectOAuth = useMutation({
    ...assistantsOauthDisconnectByConnectionCreateMutation(),
    onSuccess(_data, variables) {
      toast.success(`${displayName} account disconnected.`);
      const connectionId = variables.path.connection_id;
      queryClient.setQueryData(
        connectionsQueryKey,
        (old: OAuthConnection[] | undefined) =>
          old?.filter((c) => c.id !== connectionId),
      );
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      setPendingDisconnectId(null);
    },
    onError(error) {
      const detail = extractErrorMessage(
        error,
        undefined,
        `Failed to disconnect ${displayName} account.`,
      );
      toast.error(detail);
      setPendingDisconnectId(null);
    },
  });

  const handleConnect = useCallback(() => {
    if (!managedAvailable) return;

    const requestId = crypto.randomUUID();

    if (isNative) {
      // Capacitor iOS: WKWebView's `window.open` returns null, so we cannot
      // use the synchronous-popup pattern. Instead we mutate first to get
      // the provider URL, then open it in `SFSafariViewController` via
      // `openUrl`. The `?native=1` flag on `redirect_after_connect` tells
      // `popup-complete/page.tsx` to redirect to a custom URL scheme on
      // completion, which iOS routes back into the app via `appUrlOpen`
      // (handled by `DeepLinkRouter`). The `browserFinished` listener
      // serves as a fallback for cancellation and for older native
      // binaries that pre-date the deep-link router.
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

    // Start polling for popup closure. This continues even after navigation
    // to the provider URL. A successful completion page can postMessage and
    // close in quick succession, so give that message a short grace period
    // before treating closure as user cancellation.
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
            try {
              handleOAuthCompletePayload(
                JSON.parse(storedCompletion) as OAuthCompletePayload,
              );
              window.localStorage.removeItem(
                oauthCompletionStorageKey(pendingRequest.requestId),
              );
              return;
            } catch {
              // Fall through to the normal closed-popup error.
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
  }, [
    assistantId,
    providerKey,
    displayName,
    allConnections,
    connectionsQueryKey,
    queryClient,
    clearPendingRequest,
    closePopupWindow,
    handleOAuthCompletePayload,
    waitForProviderConnection,
    startOAuth,
    isNative,
    managedAvailable,
  ]);

  const handleDisconnect = (connection: OAuthConnection) => {
    setConnectionPendingDisconnect(connection);
  };

  const confirmDisconnect = () => {
    const connection = connectionPendingDisconnect;
    setConnectionPendingDisconnect(null);
    if (!connection) {
      return;
    }
    setPendingDisconnectId(connection.id);
    disconnectOAuth.mutate({
      path: { assistant_id: assistantId, connection_id: connection.id },
    });
  };

  const subtitle = description
    ? `Configure ${displayName} OAuth for ${description}`
    : `Configure ${displayName} OAuth`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-modal-title"
        className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-[var(--surface-lift)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-base)] px-5 py-4 dark:border-[var(--border-base)]">
          <div className="flex items-center gap-3">
            <IntegrationIcon
              providerKey={providerKey}
              displayName={displayName}
              logoUrl={logoUrl}
              size={32}
            />
            <div>
              <h2
                id="integration-modal-title"
                className="text-title-small text-[var(--content-default)]"
              >
                {displayName} OAuth
              </h2>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {subtitle}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<X />}
            aria-label="Close"
            onClick={onClose}
          />
        </div>

        <div className="space-y-4 px-5 py-4">
          {platformGate !== "gated" && (
            <div
              role="tablist"
              aria-label="OAuth mode"
              className="flex w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] p-0.5 dark:border-[var(--border-base)] dark:bg-[var(--surface-base)]/40"
            >
              <TabButton
                active={activeTab === "managed"}
                onClick={() => setActiveTab("managed")}
              >
                Managed
              </TabButton>
              <TabButton
                active={activeTab === "your-own"}
                onClick={() => setActiveTab("your-own")}
              >
                Your Own
              </TabButton>
            </div>
          )}

          {activeTab === "managed" && platformGate !== "gated" ? (
            platformGate === "disabled" ? (
              <Notice tone="info">
                Log in to the Vellum platform to manage OAuth connections.
              </Notice>
            ) : (
              <ManagedTab
                displayName={displayName}
                providerKey={providerKey}
                logoUrl={logoUrl}
                connections={providerConnections}
                connectionsLoading={connectionsLoading}
                startPending={startOAuth.isPending}
                oauthInProgress={oauthInProgress}
                disconnectingId={
                  disconnectOAuth.isPending ? pendingDisconnectId : null
                }
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            )
          ) : (
            <YourOwnTab
              assistantId={assistantId}
              providerKey={providerKey}
              displayName={displayName}
              logoUrl={logoUrl}
            />
          )}
        </div>

        <div className="flex justify-end border-t border-[var(--border-base)] px-5 py-3 dark:border-[var(--border-base)]">
          <Button variant="outlined" size="compact" onClick={onClose}>
            Confirm
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={connectionPendingDisconnect !== null}
        title={`Disconnect ${displayName}?`}
        message={
          connectionPendingDisconnect
            ? `Disconnect ${connectionPendingDisconnect.account_label ?? `${displayName} Account`}? You can reconnect later.`
            : ""
        }
        confirmLabel="Disconnect"
        destructive
        onConfirm={confirmDisconnect}
        onCancel={() => setConnectionPendingDisconnect(null)}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 cursor-pointer rounded-[5px] px-3 py-1.5 text-body-medium-default transition-colors ${
        active
          ? "bg-white text-[var(--content-default)] shadow-sm dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:text-[var(--content-default)] dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]"
      }`}
    >
      {children}
    </button>
  );
}

interface ManagedTabProps {
  displayName: string;
  providerKey: string;
  logoUrl: string | null;
  connections: OAuthConnection[];
  connectionsLoading: boolean;
  startPending: boolean;
  oauthInProgress: boolean;
  disconnectingId: string | null;
  onConnect: () => void;
  onDisconnect: (connection: OAuthConnection) => void;
}

function ManagedTab({
  displayName,
  providerKey,
  logoUrl,
  connections,
  connectionsLoading,
  startPending,
  oauthInProgress,
  disconnectingId,
  onConnect,
  onDisconnect,
}: ManagedTabProps) {
  if (connectionsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  if (connections.length === 0) {
    if (startPending || oauthInProgress) {
      return (
        <div className="flex flex-col items-center gap-3 py-10">
          <IntegrationIcon
            providerKey={providerKey}
            displayName={displayName}
            logoUrl={logoUrl}
            size={48}
          />
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <IntegrationIcon
          providerKey={providerKey}
          displayName={displayName}
          logoUrl={logoUrl}
          size={48}
        />
        <p className="text-body-medium-default text-[var(--content-secondary)]">
          Connect Account to continue
        </p>
        <Button
          variant="primary"
          size="compact"
          leftIcon={<Plus />}
          onClick={onConnect}
          disabled={startPending || oauthInProgress}
        >
          Connect Account
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-base)]">
      <ul className="divide-y divide-[var(--border-base)]">
        {connections.map((connection) => {
          const isDisconnecting = disconnectingId === connection.id;
          return (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <IntegrationIcon
                providerKey={providerKey}
                displayName={displayName}
                logoUrl={logoUrl}
                size={20}
              />
              <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                {connection.account_label ?? `${displayName} Account`}
              </span>
              <Button
                variant="dangerOutline"
                size="compact"
                iconOnly={isDisconnecting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                onClick={() => onDisconnect(connection)}
                disabled={isDisconnecting}
                aria-label={`Disconnect ${connection.account_label ?? `${displayName} account`}`}
              />
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
        {startPending || oauthInProgress ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        ) : (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<ExternalLink />}
            onClick={onConnect}
            disabled={startPending || oauthInProgress}
          >
            Connect account
          </Button>
        )}
      </div>
    </div>
  );
}

interface YourOwnTabProps {
  assistantId: string;
  providerKey: string;
  displayName: string;
  logoUrl: string | null;
}

function YourOwnTab({
  assistantId,
  providerKey,
  displayName,
  logoUrl,
}: YourOwnTabProps) {
  const [apps, setApps] = useState<OAuthApp[]>([]);
  const [connectionsMap, setConnectionsMap] = useState<
    Record<string, OAuthAppConnection[]>
  >({});
  const [loadingApps, setLoadingApps] = useState(true);
  const [isShowingAddAppForm, setIsShowingAddAppForm] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [creatingApp, setCreatingApp] = useState(false);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState<string | null>(null);
  const [callbackUrlCopied, setCallbackUrlCopied] = useState(false);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [connectingAppId, setConnectingAppId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [appPendingDeletion, setAppPendingDeletion] = useState<OAuthApp | null>(
    null,
  );
  const [connectionPendingDisconnect, setConnectionPendingDisconnect] =
    useState<{ appId: string; connection: OAuthAppConnection } | null>(null);

  const loadConnectionsForApp = useCallback(
    async (appId: string) => {
      try {
        const connections = await listOAuthAppConnections(assistantId, appId);
        setConnectionsMap((prev) => ({ ...prev, [appId]: connections }));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load connections";
        toast.error(message);
      }
    },
    [assistantId],
  );

  const loadApps = useCallback(async () => {
    setLoadingApps(true);
    try {
      const result = await listOAuthApps(assistantId, providerKey);
      setApps(result);
      await Promise.all(result.map((app) => loadConnectionsForApp(app.id)));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load OAuth apps";
      toast.error(message);
    } finally {
      setLoadingApps(false);
    }
  }, [assistantId, providerKey, loadConnectionsForApp]);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  useEffect(() => {
    let active = true;
    void fetchOAuthProviderDetail(assistantId, providerKey).then(
      (detail) => {
        if (active) setOauthCallbackUrl(detail.oauth_callback_url);
      },
      () => {},
    );
    return () => { active = false; };
  }, [assistantId, providerKey]);

  const shouldShowForm = apps.length === 0 || isShowingAddAppForm;

  const handleCreateApp = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      return;
    }
    setCreatingApp(true);
    try {
      const trimmedId = clientId.trim();
      const trimmedSecret = clientSecret.trim();
      const app = await createOAuthApp(assistantId, {
        provider_key: providerKey,
        client_id: trimmedId,
        client_secret: trimmedSecret,
      });
      setApps((prev) => [...prev, app]);
      setConnectionsMap((prev) => ({ ...prev, [app.id]: [] }));
      setClientId("");
      setClientSecret("");
      setIsShowingAddAppForm(false);
      toast.success(`${displayName} OAuth app added.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create OAuth app";
      toast.error(message);
    } finally {
      setCreatingApp(false);
    }
  };

  const handleDeleteApp = (app: OAuthApp) => {
    setAppPendingDeletion(app);
  };

  const confirmDeleteApp = async () => {
    const app = appPendingDeletion;
    setAppPendingDeletion(null);
    if (!app) {
      return;
    }
    setDeletingAppId(app.id);
    try {
      await deleteOAuthApp(assistantId, app.id);
      setApps((prev) => prev.filter((a) => a.id !== app.id));
      setConnectionsMap((prev) => {
        const next = { ...prev };
        delete next[app.id];
        return next;
      });
      toast.success("OAuth app deleted.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete OAuth app";
      toast.error(message);
    } finally {
      setDeletingAppId(null);
    }
  };

  const handleConnect = async (app: OAuthApp) => {
    setConnectingAppId(app.id);
    try {
      const { authUrl } = await startOAuthAppConnect(assistantId, app.id);
      window.location.href = authUrl;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start OAuth flow";
      toast.error(message);
      setConnectingAppId(null);
    }
  };

  const handleDisconnect = (
    appId: string,
    connection: OAuthAppConnection,
  ) => {
    setConnectionPendingDisconnect({ appId, connection });
  };

  const confirmDisconnect = async () => {
    const pending = connectionPendingDisconnect;
    setConnectionPendingDisconnect(null);
    if (!pending) {
      return;
    }
    const { appId, connection } = pending;
    setDisconnectingId(connection.id);
    try {
      await deleteOAuthAppConnection(assistantId, connection.id);
      setConnectionsMap((prev) => ({
        ...prev,
        [appId]: (prev[appId] ?? []).filter((c) => c.id !== connection.id),
      }));
      toast.success(`${displayName} account disconnected.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disconnect account";
      toast.error(message);
    } finally {
      setDisconnectingId(null);
    }
  };

  if (loadingApps) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {shouldShowForm ? (
        <Card.Root>
          <Card.Body className="flex flex-col gap-3">
          <div className="space-y-1">
            <p className="text-body-medium-default text-[var(--content-default)]">
              {apps.length === 0
                ? `Add your own ${displayName} OAuth app`
                : `Add another ${displayName} OAuth app`}
            </p>
            <p className="text-body-small-default leading-relaxed text-[var(--content-tertiary)]">
              Credentials are stored encrypted on the assistant and are never
              sent to Vellum.
            </p>
          </div>
          {oauthCallbackUrl ? (
            <div className="space-y-1">
              <p className="text-body-small-default text-[var(--content-secondary)]">
                Redirect URL
              </p>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={oauthCallbackUrl}
                  readOnly
                  fullWidth
                />
                <Button
                  type="button"
                  variant="outlined"
                  size="compact"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(oauthCallbackUrl)
                      .then(() => {
                        setCallbackUrlCopied(true);
                        toast.success("Copied to clipboard!");
                        setTimeout(() => setCallbackUrlCopied(false), 2000);
                      });
                  }}
                  aria-label={
                    callbackUrlCopied ? "Copied" : "Copy redirect URL"
                  }
                  iconOnly={
                    callbackUrlCopied ? (
                      <Check aria-hidden />
                    ) : (
                      <Copy aria-hidden />
                    )
                  }
                />
              </div>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Add this URL to your OAuth app&apos;s redirect settings.
              </p>
            </div>
          ) : null}
          <Input
            label="Client ID"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Enter your client ID"
            fullWidth
          />
          <Input
            label="Client Secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Enter your client secret"
            fullWidth
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            {apps.length > 0 ? (
              <Button
                type="button"
                variant="outlined"
                size="compact"
                onClick={() => {
                  setIsShowingAddAppForm(false);
                  setClientId("");
                  setClientSecret("");
                }}
                disabled={creatingApp}
              >
                Cancel
              </Button>
            ) : null}
            <Button
              type="button"
              size="compact"
              onClick={handleCreateApp}
              disabled={
                creatingApp || !clientId.trim() || !clientSecret.trim()
              }
              leftIcon={
                creatingApp ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Plus aria-hidden />
                )
              }
            >
              Add App
            </Button>
          </div>
          </Card.Body>
        </Card.Root>
      ) : null}

      {apps.map((app) => {
        const connections = connectionsMap[app.id] ?? [];
        const isDeleting = deletingAppId === app.id;
        const isConnecting = connectingAppId === app.id;
        return (
          <Card.Root key={app.id}>
            <Card.Body className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-body-medium-default text-[var(--content-default)]">
                  {maskClientId(app.client_id)}
                </p>
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  Added {formatOAuthTimestamp(app.created_at)}
                </p>
              </div>
              <Button
                type="button"
                variant="dangerOutline"
                size="compact"
                onClick={() => handleDeleteApp(app)}
                disabled={isDeleting}
                aria-label={`Delete OAuth app ${maskClientId(app.client_id)}`}
                iconOnly={
                  isDeleting ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Trash2 aria-hidden />
                  )
                }
              />
            </div>

            {connections.length > 0 ? (
              <ul className="divide-y divide-[var(--border-base)] overflow-hidden rounded-md border border-[var(--border-base)] dark:divide-[var(--border-base)] dark:border-[var(--border-base)]">
                {connections.map((connection) => {
                  const isDisconnecting = disconnectingId === connection.id;
                  return (
                    <li
                      key={connection.id}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <IntegrationIcon
                        providerKey={providerKey}
                        displayName={displayName}
                        logoUrl={logoUrl}
                        size={18}
                      />
                      <span className="min-w-0 flex-1 truncate text-body-medium-lighter text-[var(--content-default)]">
                        {connection.account_info ?? `${displayName} Account`}
                      </span>
                      <Button
                        type="button"
                        variant="dangerOutline"
                        size="compact"
                        onClick={() => handleDisconnect(app.id, connection)}
                        disabled={isDisconnecting}
                        aria-label={`Disconnect ${connection.account_info ?? `${displayName} account`}`}
                        iconOnly={
                          isDisconnecting ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Trash2 aria-hidden />
                          )
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <Button
              type="button"
              size="compact"
              onClick={() => handleConnect(app)}
              disabled={isConnecting}
              className="w-full"
              leftIcon={
                isConnecting ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <ExternalLink aria-hidden />
                )
              }
            >
              {isConnecting ? "Waiting for authorization..." : "Connect account"}
            </Button>
            </Card.Body>
          </Card.Root>
        );
      })}

      {apps.length > 0 && !isShowingAddAppForm ? (
        <Button
          type="button"
          variant="outlined"
          size="compact"
          onClick={() => setIsShowingAddAppForm(true)}
          className="w-full border-dashed"
          leftIcon={<Plus aria-hidden />}
        >
          Add Another App
        </Button>
      ) : null}
      <ConfirmDialog
        open={appPendingDeletion !== null}
        title="Delete OAuth app"
        message={
          appPendingDeletion
            ? `Delete OAuth app '${maskClientId(appPendingDeletion.client_id)}'? This will disconnect all linked accounts.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void confirmDeleteApp();
        }}
        onCancel={() => setAppPendingDeletion(null)}
      />
      <ConfirmDialog
        open={connectionPendingDisconnect !== null}
        title={`Disconnect ${displayName}?`}
        message={
          connectionPendingDisconnect
            ? `Disconnect ${connectionPendingDisconnect.connection.account_info ?? `${displayName} Account`}? You can reconnect later.`
            : ""
        }
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          void confirmDisconnect();
        }}
        onCancel={() => setConnectionPendingDisconnect(null)}
      />
    </div>
  );
}
