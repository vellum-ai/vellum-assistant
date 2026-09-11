import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { McpAddServerModal } from "./mcp-add-server-modal";
import {
  addMcpServer,
  fetchMcpServers,
  fetchMcpToolsSummary,
  pollMcpAuthStatus,
  reloadMcpServers,
  removeMcpServer,
  startMcpAuth,
  updateMcpServer,
  type McpServerEntry,
} from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";
import { McpServerCard } from "./mcp-server-card";
import { McpActionButton } from "./mcp-action-button";
import { McpServerDetailModal } from "./mcp-server-detail-modal";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

function McpPageInner() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mcpAddServerEnabled = useAssistantFeatureFlagStore.use.mcpAddServer();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [configureServerId, setConfigureServerId] = useState<string | null>(
    null,
  );
  const [removeServerId, setRemoveServerId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [authenticatingServerId, setAuthenticatingServerId] = useState<
    string | null
  >(null);

  const {
    data: serversData,
    isLoading: serversLoading,
    isError: serversError,
  } = useQuery({
    queryKey: mcpQueryKeys.list(assistantId),
    queryFn: () => fetchMcpServers(assistantId),
  });

  const { data: toolsData, isPending: toolsLoading, isError: toolsError } = useQuery({
    queryKey: mcpQueryKeys.details(assistantId),
    queryFn: () => fetchMcpToolsSummary(assistantId),
    enabled: configureServerId !== null,
  });

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: mcpQueryKeys.list(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: mcpQueryKeys.details(assistantId),
    });
  }, [queryClient, assistantId]);

  const configureServer = useMemo<McpServerEntry | null>(() => {
    if (!configureServerId || !serversData) {
      return null;
    }
    return serversData.servers.find((s) => s.id === configureServerId) ?? null;
  }, [configureServerId, serversData]);

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeServerId) {
      return;
    }
    setIsRemoving(true);
    try {
      await removeMcpServer(assistantId, removeServerId);
      invalidateAll();
      toast.success(t("mcpPage.toastRemoved", { serverId: removeServerId }));
      setRemoveServerId(null);
    } catch {
      toast.error(t("mcpPage.toastRemoveFailed", { serverId: removeServerId }));
    } finally {
      setIsRemoving(false);
    }
  }, [removeServerId, assistantId, invalidateAll, t]);

  const handleAuthenticate = useCallback(
    async (serverId: string) => {
      setAuthenticatingServerId(serverId);
      let result;
      try {
        result = await startMcpAuth(assistantId, serverId);
      } catch {
        toast.error(t("mcpPage.toastAuthStartFailed", { serverId }));
        setAuthenticatingServerId(null);
        return;
      }
      try {
        if (result.already_authenticated) {
          toast.success(t("mcpPage.toastAlreadyAuthenticated", { serverId }));
          invalidateAll();
          return;
        }
        window.open(result.auth_url, "_blank", "noopener,noreferrer");
        const maxAttempts = 60;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const status = await pollMcpAuthStatus(assistantId, serverId);
          if (status.status === "complete") {
            toast.success(t("mcpPage.toastAuthenticatedSuccess", { serverId }));
            invalidateAll();
            return;
          }
          if (status.status === "error") {
            toast.error(
              status.error ?? t("mcpPage.toastAuthFailed", { serverId }),
            );
            return;
          }
        }
        toast.error(t("mcpPage.toastAuthTimedOut", { serverId }));
      } catch {
        toast.error(t("mcpPage.toastAuthPollingFailed", { serverId }));
      } finally {
        setAuthenticatingServerId(null);
        invalidateAll();
      }
    },
    [assistantId, invalidateAll, t],
  );

  const handleAdd = useCallback(
    async (config: {
      name: string;
      transportType: string;
      url?: string;
      command?: string;
      args?: string[];
      headers?: Record<string, string>;
      autoAuth?: boolean;
    }) => {
      // Pre-open a popup synchronously while we still have user activation
      // from the button click. Browsers block window.open after async calls.
      const authWindow = config.autoAuth
        ? window.open("about:blank", "_blank", "noopener")
        : null;

      setIsAdding(true);
      try {
        await addMcpServer(assistantId, config);
        invalidateAll();
        toast.success(t("mcpPage.toastAdded", { name: config.name }));
        setAddModalOpen(false);
      } catch {
        toast.error(t("mcpPage.toastAddFailed", { name: config.name }));
        authWindow?.close();
        setIsAdding(false);
        return;
      }
      setIsAdding(false);

      if (config.autoAuth) {
        setAuthenticatingServerId(config.name);
        try {
          const result = await startMcpAuth(assistantId, config.name);
          if (result.already_authenticated) {
            authWindow?.close();
            toast.success(
              t("mcpPage.toastAlreadyAuthenticated", {
                serverId: config.name,
              }),
            );
            invalidateAll();
            return;
          }
          if (authWindow) {
            authWindow.location.href = result.auth_url;
          } else {
            window.open(result.auth_url, "_blank", "noopener,noreferrer");
          }
          const maxAttempts = 60;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const status = await pollMcpAuthStatus(assistantId, config.name);
            if (status.status === "complete") {
              toast.success(
                t("mcpPage.toastAuthenticatedSuccess", {
                  serverId: config.name,
                }),
              );
              invalidateAll();
              return;
            }
            if (status.status === "error") {
              toast.error(
                status.error ??
                  t("mcpPage.toastAuthFailed", { serverId: config.name }),
              );
              return;
            }
          }
          toast.error(
            t("mcpPage.toastAuthTimedOut", { serverId: config.name }),
          );
        } catch {
          authWindow?.close();
          toast.error(
            t("mcpPage.toastAuthStartFailed", { serverId: config.name }),
          );
        } finally {
          setAuthenticatingServerId(null);
          invalidateAll();
        }
      }
    },
    [assistantId, invalidateAll, t],
  );

  const handleSave = useCallback(
    async (
      serverId: string,
      updates: {
        name: string;
        headers?: Record<string, string> | null;
      },
    ) => {
      setIsSaving(true);
      try {
        await updateMcpServer(assistantId, updates);
        invalidateAll();
        toast.success(t("mcpPage.toastUpdated", { serverId }));
        setConfigureServerId(null);
      } catch {
        toast.error(t("mcpPage.toastUpdateFailed", { serverId }));
      } finally {
        setIsSaving(false);
      }
    },
    [assistantId, invalidateAll, t],
  );

  const handleReload = useCallback(async () => {
    setIsReloading(true);
    try {
      await reloadMcpServers(assistantId);
      invalidateAll();
      toast.success(t("mcpPage.toastReloadSuccess"));
    } catch {
      toast.error(t("mcpPage.toastReloadFailed"));
    } finally {
      setIsReloading(false);
    }
  }, [assistantId, invalidateAll, t]);

  const handleEmptyStateAction = useCallback(() => {
    if (mcpAddServerEnabled) {
      setAddModalOpen(true);
    } else {
      navigateToNewConversation(navigate, {
        prompt: t("mcpPage.setupPrompt"),
      });
    }
  }, [mcpAddServerEnabled, navigate, t]);

  const servers = serversData?.servers ?? [];

  return (
    <div className="space-y-4">
      {/* `flow-root` so the floated actions are contained rather than escaping
          the header, and floated rather than laid out in a row: the subtitle
          runs up to the buttons and then wraps *under* them, instead of
          stopping short of the whole column or starting below the button. */}
      <div className="flow-root">
        <div className="float-right ml-4 flex shrink-0 items-center gap-2">
          <McpActionButton
            variant="outlined"
            icon={<RefreshCw className={isReloading ? "animate-spin" : ""} />}
            label={t("mcpPage.reloadButton")}
            onClick={handleReload}
            disabled={isReloading}
          />
          {mcpAddServerEnabled ? (
            <Button
              variant="primary"
              leftIcon={<Plus />}
              onClick={() => setAddModalOpen(true)}
            >
              {t("mcpPage.addServerButton")}
            </Button>
          ) : null}
        </div>
        <h2 className="text-title-small text-[var(--content-default)]">
          {t("mcpPage.title")}
        </h2>
        <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("mcpPage.subtitle")}
        </p>
      </div>

      {serversLoading ? (
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("mcpPage.loading")}</span>
        </div>
      ) : serversError ? (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("mcpPage.loadError")}
        </p>
      ) : servers.length === 0 ? (
        <button
          type="button"
          onClick={handleEmptyStateAction}
          disabled={!flagsHydrated}
          className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border-element)] px-4 py-12 text-center transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none"
        >
          <Cable className="h-6 w-6 text-[var(--content-disabled)]" />
          <p className="text-body-medium-default text-[var(--content-default)]">
            {t("mcpPage.emptyTitle")}
          </p>
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {mcpAddServerEnabled
              ? t("mcpPage.emptyAddSubtitle")
              : t("mcpPage.emptyChatSubtitle")}
          </p>
        </button>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              onRemove={setRemoveServerId}
              onConfigure={setConfigureServerId}
              onAuthenticate={handleAuthenticate}
              isAuthenticating={authenticatingServerId === server.id}
            />
          ))}
        </div>
      )}

      {mcpAddServerEnabled ? (
        <McpAddServerModal
          open={addModalOpen}
          onClose={() => setAddModalOpen(false)}
          onAdd={handleAdd}
          isPending={isAdding}
        />
      ) : null}

      <McpServerDetailModal
        server={configureServer}
        toolsLoading={toolsLoading}
        toolsError={toolsError}
        toolsSummary={
          toolsData?.servers.find((entry) => entry.serverId === configureServerId)
        }
        onClose={() => setConfigureServerId(null)}
        onSave={handleSave}
        isPending={isSaving}
      />

      <ConfirmDialog
        open={!!removeServerId}
        title={t("mcpPage.removeDialogTitle")}
        message={
          removeServerId
            ? t("mcpPage.removeDialogMessage", { serverId: removeServerId })
            : ""
        }
        confirmLabel={t("mcpPage.removeDialogConfirm")}
        destructive
        isPending={isRemoving}
        onConfirm={handleRemoveConfirm}
        onCancel={() => setRemoveServerId(null)}
      />
    </div>
  );
}

export function McpPage() {
  return <McpPageInner />;
}
