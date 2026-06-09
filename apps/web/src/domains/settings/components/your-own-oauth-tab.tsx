import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  createOAuthApp,
  deleteOAuthApp,
  deleteOAuthAppConnection,
  formatOAuthTimestamp,
  listOAuthAppConnections,
  listOAuthApps,
  maskClientId,
  startOAuthAppConnect,
  type OAuthApp,
  type OAuthAppConnection,
} from "@/domains/settings/api/oauth-apps";
import { fetchOAuthProviderDetail } from "@/domains/settings/api/oauth-providers";
import { captureError } from "@/lib/sentry/capture-error";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

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
      (err) => {
        if (active) {
          captureError(err, { context: "YourOwnTab.fetchOAuthProviderDetail", tags: { domain: "settings" } });
        }
      },
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
