import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  oauthAppsByAppIdConnectionsGetOptions,
  oauthAppsByAppIdConnectionsGetQueryKey,
  oauthAppsGetOptions,
  oauthAppsGetQueryKey,
  oauthProvidersByProviderKeyGetOptions,
  useOauthAppsByAppIdConnectPostMutation,
  useOauthAppsByIdDeleteMutation,
  useOauthAppsPostMutation,
  useOauthConnectionsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  OauthAppsByAppIdConnectionsGetResponses,
  OauthAppsGetResponses,
} from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

type OAuthApp = OauthAppsGetResponses[200]["apps"][number];
type OAuthAppConnection =
  OauthAppsByAppIdConnectionsGetResponses[200]["connections"][number];

function maskClientId(clientId: string): string {
  if (clientId.length > 16) {
    return `${clientId.slice(0, 12)}…${clientId.slice(-4)}`;
  }
  if (clientId.length > 8) {
    return `${clientId.slice(0, 8)}…`;
  }
  return clientId;
}

function formatOAuthTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

interface YourOwnTabProps {
  assistantId: string;
  providerKey: string;
  displayName: string;
  logoUrl: string | null;
}

export function YourOwnTab({
  assistantId,
  providerKey,
  displayName,
  logoUrl,
}: YourOwnTabProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();

  // --- Server state via TanStack Query ---

  const appsQuery = useQuery({
    ...oauthAppsGetOptions({
      path: { assistant_id: assistantId },
      query: { provider_key: providerKey },
    }),
    select: (data) => data.apps,
  });

  const providerDetailQuery = useQuery({
    ...oauthProvidersByProviderKeyGetOptions({
      path: { assistant_id: assistantId, providerKey },
    }),
    select: (data) => data.oauth_callback_url,
  });

  const apps = appsQuery.data ?? [];
  const oauthCallbackUrl = providerDetailQuery.data ?? null;

  const connectionsQueries = useQueries({
    queries: apps.map((app) => ({
      ...oauthAppsByAppIdConnectionsGetOptions({
        path: { assistant_id: assistantId, appId: app.id },
      }),
      select: (data: OauthAppsByAppIdConnectionsGetResponses[200]) =>
        data.connections,
    })),
  });

  const connectionsMap: Record<string, OAuthAppConnection[]> = {};
  apps.forEach((app, i) => {
    connectionsMap[app.id] = connectionsQueries[i]?.data ?? [];
  });

  // --- Mutations ---

  const appsQueryKey = oauthAppsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { provider_key: providerKey },
  });

  const createAppMutation = useOauthAppsPostMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: appsQueryKey });
      setClientId("");
      setClientSecret("");
      setIsShowingAddAppForm(false);
      toast.success(
        t("yourOwnOauthTab.appAddedToast", { name: displayName }),
      );
    },
    onError: (err) => {
      toast.error(err.message || t("yourOwnOauthTab.createFailedToast"));
    },
  });

  const deleteAppMutation = useOauthAppsByIdDeleteMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: appsQueryKey });
      toast.success(t("yourOwnOauthTab.appDeletedToast"));
    },
    onError: (err) => {
      toast.error(err.message || t("yourOwnOauthTab.deleteFailedToast"));
    },
  });

  const connectMutation = useOauthAppsByAppIdConnectPostMutation({
    onSuccess: (data) => {
      if ("auth_url" in data) {
        window.location.href = data.auth_url;
      }
    },
    onError: (err) => {
      toast.error(err.message || t("yourOwnOauthTab.connectFailedToast"));
    },
  });

  const disconnectMutation = useOauthConnectionsByIdDeleteMutation();

  // --- Ephemeral UI state ---

  const [isShowingAddAppForm, setIsShowingAddAppForm] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [callbackUrlCopied, setCallbackUrlCopied] = useState(false);
  const [appPendingDeletion, setAppPendingDeletion] = useState<OAuthApp | null>(
    null,
  );
  const [connectionPendingDisconnect, setConnectionPendingDisconnect] =
    useState<{ appId: string; connection: OAuthAppConnection } | null>(null);

  // --- Derived loading states from mutations (via the UI pattern) ---

  const creatingApp = createAppMutation.isPending;
  const deletingAppId = deleteAppMutation.isPending
    ? (deleteAppMutation.variables?.path?.id ?? null)
    : null;
  const connectingAppId = connectMutation.isPending
    ? (connectMutation.variables?.path?.appId ?? null)
    : null;
  const disconnectingId = disconnectMutation.isPending
    ? (disconnectMutation.variables?.path?.id ?? null)
    : null;

  // --- Handlers ---

  const handleCreateApp = () => {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (!trimmedId || !trimmedSecret) {
      return;
    }
    createAppMutation.mutate({
      path: { assistant_id: assistantId },
      body: {
        provider_key: providerKey,
        client_id: trimmedId,
        client_secret: trimmedSecret,
      },
    });
  };

  const confirmDeleteApp = () => {
    const app = appPendingDeletion;
    setAppPendingDeletion(null);
    if (!app) {
      return;
    }
    deleteAppMutation.mutate({
      path: { assistant_id: assistantId, id: app.id },
    });
  };

  const handleConnect = (app: OAuthApp) => {
    connectMutation.mutate({
      path: { assistant_id: assistantId, appId: app.id },
      body: { callback_transport: "gateway", scopes: [] },
    });
  };

  const confirmDisconnect = () => {
    const pending = connectionPendingDisconnect;
    setConnectionPendingDisconnect(null);
    if (!pending) {
      return;
    }
    disconnectMutation.mutate(
      { path: { assistant_id: assistantId, id: pending.connection.id } },
      {
        onSuccess: () => {
          const connectionQueryKey = oauthAppsByAppIdConnectionsGetQueryKey({
            path: { assistant_id: assistantId, appId: pending.appId },
          });
          void queryClient.invalidateQueries({ queryKey: connectionQueryKey });
          void queryClient.invalidateQueries({ queryKey: appsQueryKey });
          toast.success(
            t("yourOwnOauthTab.disconnectedToast", { name: displayName }),
          );
        },
        onError: (err) => {
          toast.error(
            err.message || t("yourOwnOauthTab.disconnectFailedToast"),
          );
        },
      },
    );
  };

  // --- Render ---

  if (appsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  const shouldShowForm = apps.length === 0 || isShowingAddAppForm;

  return (
    <div className="flex flex-col gap-4">
      {shouldShowForm ? (
        <Card.Root>
          <Card.Body className="flex flex-col gap-3">
            <div className="space-y-1">
              <p className="text-body-medium-default text-[var(--content-default)]">
                {apps.length === 0
                  ? t("yourOwnOauthTab.addOwnApp", { name: displayName })
                  : t("yourOwnOauthTab.addAnotherApp", { name: displayName })}
              </p>
              <p className="text-body-small-default leading-relaxed text-[var(--content-tertiary)]">
                {t("yourOwnOauthTab.credentialsNote")}
              </p>
            </div>
            {oauthCallbackUrl ? (
              <div className="space-y-1">
                <p className="text-body-small-default text-[var(--content-secondary)]">
                  {t("yourOwnOauthTab.redirectUrl")}
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
                      copyToClipboard(oauthCallbackUrl, {
                        successMessage: t("yourOwnOauthTab.copiedToast"),
                        errorMessage: t("yourOwnOauthTab.copyFailedToast"),
                        onCopied: () => {
                          setCallbackUrlCopied(true);
                          setTimeout(() => setCallbackUrlCopied(false), 2000);
                        },
                      });
                    }}
                    aria-label={
                      callbackUrlCopied
                        ? t("yourOwnOauthTab.copiedAria")
                        : t("yourOwnOauthTab.copyRedirectAria")
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
                  {t("yourOwnOauthTab.redirectHint")}
                </p>
              </div>
            ) : null}
            <Input
              label={t("yourOwnOauthTab.clientId")}
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={t("yourOwnOauthTab.clientIdPlaceholder")}
              fullWidth
            />
            <Input
              label={t("yourOwnOauthTab.clientSecret")}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={t("yourOwnOauthTab.clientSecretPlaceholder")}
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
                  {t("yourOwnOauthTab.cancel")}
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
                {t("yourOwnOauthTab.addApp")}
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
                    {t("yourOwnOauthTab.addedOn", {
                      date: formatOAuthTimestamp(app.created_at),
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="dangerOutline"
                  size="compact"
                  onClick={() => setAppPendingDeletion(app)}
                  disabled={isDeleting}
                  aria-label={t("yourOwnOauthTab.deleteAppAria", {
                    id: maskClientId(app.client_id),
                  })}
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
                    const accountLabel =
                      connection.account_info ??
                      t("yourOwnOauthTab.accountFallback", {
                        name: displayName,
                      });
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
                          {accountLabel}
                        </span>
                        <Button
                          type="button"
                          variant="dangerOutline"
                          size="compact"
                          onClick={() =>
                            setConnectionPendingDisconnect({
                              appId: app.id,
                              connection,
                            })
                          }
                          disabled={isDisconnecting}
                          aria-label={t("yourOwnOauthTab.disconnectAria", {
                            account: accountLabel,
                          })}
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
                {isConnecting
                  ? t("yourOwnOauthTab.waitingAuthorization")
                  : t("yourOwnOauthTab.connectAccount")}
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
          {t("yourOwnOauthTab.addAnotherAppButton")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={appPendingDeletion !== null}
        title={t("yourOwnOauthTab.deleteAppTitle")}
        message={
          appPendingDeletion
            ? t("yourOwnOauthTab.deleteAppMessage", {
                id: maskClientId(appPendingDeletion.client_id),
              })
            : ""
        }
        confirmLabel={t("yourOwnOauthTab.delete")}
        destructive
        onConfirm={confirmDeleteApp}
        onCancel={() => setAppPendingDeletion(null)}
      />
      <ConfirmDialog
        open={connectionPendingDisconnect !== null}
        title={t("yourOwnOauthTab.disconnectTitle", { name: displayName })}
        message={
          connectionPendingDisconnect
            ? t("yourOwnOauthTab.disconnectMessage", {
                account:
                  connectionPendingDisconnect.connection.account_info ??
                  t("yourOwnOauthTab.accountFallback", { name: displayName }),
              })
            : ""
        }
        confirmLabel={t("yourOwnOauthTab.disconnect")}
        destructive
        onConfirm={confirmDisconnect}
        onCancel={() => setConnectionPendingDisconnect(null)}
      />
    </div>
  );
}
