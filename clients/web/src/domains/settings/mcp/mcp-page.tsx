import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
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
  revokeMcpOAuth,
  startMcpAuth,
  updateMcpServer,
  type McpServerEntry,
  type McpToolsSummaryServer,
} from "./mcp-api";
import { McpServerCard } from "./mcp-server-card";
import { McpServerDetailModal } from "./mcp-server-detail-modal";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

const MCP_SERVERS_KEY = "mcp-servers";
const MCP_TOOLS_KEY = "mcp-tools-summary";

/**
 * First message auto-sent when a user without the add-server flag clicks the
 * empty-state call to action — kicks off an assistant-guided MCP setup.
 */
const MCP_SETUP_PROMPT =
  "Help me set up an MCP server to extend you with external tools.";

function McpPageInner() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mcpAddServerEnabled = useAssistantFeatureFlagStore.use.mcpAddServer();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [configureServerId, setConfigureServerId] = useState<string | null>(null);
  const [removeServerId, setRemoveServerId] = useState<string | null>(null);
  const [pendingMutations, setPendingMutations] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [authenticatingServerId, setAuthenticatingServerId] = useState<string | null>(null);
  const [revokingServerId, setRevokingServerId] = useState<string | null>(null);

  const {
    data: serversData,
    isLoading: serversLoading,
    isError: serversError,
  } = useQuery({
    queryKey: [MCP_SERVERS_KEY, assistantId],
    queryFn: () => fetchMcpServers(assistantId),
  });

  const { data: toolsData } = useQuery({
    queryKey: [MCP_TOOLS_KEY, assistantId],
    queryFn: () => fetchMcpToolsSummary(assistantId),
  });

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [MCP_SERVERS_KEY, assistantId] });
    void queryClient.invalidateQueries({ queryKey: [MCP_TOOLS_KEY, assistantId] });
  }, [queryClient, assistantId]);

  const toolsByServer = useMemo(() => {
    const map = new Map<string, McpToolsSummaryServer>();
    if (toolsData) {
      for (const entry of toolsData.servers) {
        map.set(entry.serverId, entry);
      }
    }
    return map;
  }, [toolsData]);

  const configureServer = useMemo<McpServerEntry | null>(() => {
    if (!configureServerId || !serversData) {
      return null;
    }
    return serversData.servers.find((s) => s.id === configureServerId) ?? null;
  }, [configureServerId, serversData]);

  const handleToggleEnabled = useCallback(
    async (serverId: string, enabled: boolean) => {
      setPendingMutations((prev) => new Set(prev).add(serverId));
      try {
        await updateMcpServer(assistantId, { name: serverId, enabled });
        invalidateAll();
      } catch {
        toast.error(`Failed to ${enabled ? "enable" : "disable"} ${serverId}`);
      } finally {
        setPendingMutations((prev) => {
          const next = new Set(prev);
          next.delete(serverId);
          return next;
        });
      }
    },
    [assistantId, invalidateAll],
  );

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeServerId) {
      return;
    }
    setIsRemoving(true);
    try {
      await removeMcpServer(assistantId, removeServerId);
      invalidateAll();
      toast.success(`Removed ${removeServerId}`);
      setRemoveServerId(null);
    } catch {
      toast.error(`Failed to remove ${removeServerId}`);
    } finally {
      setIsRemoving(false);
    }
  }, [removeServerId, assistantId, invalidateAll]);

  const handleAuthenticate = useCallback(
    async (serverId: string) => {
      setAuthenticatingServerId(serverId);
      let result;
      try {
        result = await startMcpAuth(assistantId, serverId);
      } catch {
        toast.error(`Failed to start authentication for ${serverId}`);
        setAuthenticatingServerId(null);
        return;
      }
      try {
        if (result.already_authenticated) {
          toast.success(`${serverId} is already authenticated`);
          invalidateAll();
          return;
        }
        window.open(result.auth_url, "_blank", "noopener,noreferrer");
        const maxAttempts = 60;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const status = await pollMcpAuthStatus(assistantId, serverId);
          if (status.status === "complete") {
            toast.success(`${serverId} authenticated successfully`);
            invalidateAll();
            return;
          }
          if (status.status === "error") {
            toast.error(status.error ?? `Authentication failed for ${serverId}`);
            return;
          }
        }
        toast.error(`Authentication timed out for ${serverId}`);
      } catch {
        toast.error(`Authentication polling failed for ${serverId}`);
      } finally {
        setAuthenticatingServerId(null);
        invalidateAll();
      }
    },
    [assistantId, invalidateAll],
  );

  const handleRevokeOAuth = useCallback(
    async (serverId: string) => {
      setRevokingServerId(serverId);
      try {
        await revokeMcpOAuth(assistantId, serverId);
        invalidateAll();
        toast.success(`OAuth credentials revoked for ${serverId}`);
      } catch {
        toast.error(`Failed to revoke OAuth for ${serverId}`);
      } finally {
        setRevokingServerId(null);
      }
    },
    [assistantId, invalidateAll],
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
        toast.success(`Added ${config.name}`);
        setAddModalOpen(false);
      } catch {
        toast.error(`Failed to add ${config.name}`);
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
            toast.success(`${config.name} is already authenticated`);
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
              toast.success(`${config.name} authenticated successfully`);
              invalidateAll();
              return;
            }
            if (status.status === "error") {
              toast.error(status.error ?? `Authentication failed for ${config.name}`);
              return;
            }
          }
          toast.error(`Authentication timed out for ${config.name}`);
        } catch {
          authWindow?.close();
          toast.error(`Failed to start authentication for ${config.name}`);
        } finally {
          setAuthenticatingServerId(null);
          invalidateAll();
        }
      }
    },
    [assistantId, invalidateAll],
  );

  const handleSave = useCallback(
    async (serverId: string, updates: {
      name: string;
      defaultRiskLevel?: string;
      maxTools?: number;
      headers?: Record<string, string> | null;
    }) => {
      setIsSaving(true);
      try {
        await updateMcpServer(assistantId, updates);
        invalidateAll();
        toast.success(`Updated ${serverId}`);
        setConfigureServerId(null);
      } catch {
        toast.error(`Failed to update ${serverId}`);
      } finally {
        setIsSaving(false);
      }
    },
    [assistantId, invalidateAll],
  );

  const handleReload = useCallback(async () => {
    setIsReloading(true);
    try {
      await reloadMcpServers(assistantId);
      invalidateAll();
      toast.success("MCP servers reloaded");
    } catch {
      toast.error("Failed to reload MCP servers");
    } finally {
      setIsReloading(false);
    }
  }, [assistantId, invalidateAll]);

  const handleEmptyStateAction = useCallback(() => {
    if (mcpAddServerEnabled) {
      setAddModalOpen(true);
    } else {
      navigateToNewConversation(navigate, { prompt: MCP_SETUP_PROMPT });
    }
  }, [mcpAddServerEnabled, navigate]);

  const servers = serversData?.servers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-title-small text-[var(--content-default)]">MCP Servers</h2>
          <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            Manage Model Context Protocol server connections and their registered tools.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<RefreshCw className={isReloading ? "animate-spin" : ""} />}
            onClick={handleReload}
            disabled={isReloading}
            tooltip="Reload all servers"
            aria-label="Reload MCP servers"
          />
          {mcpAddServerEnabled ? (
            <Button
              variant="primary"
              size="compact"
              leftIcon={<Plus />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Server
            </Button>
          ) : null}
        </div>
      </div>

      {toolsData ? (
        <div className="flex gap-4 text-body-small-default text-[var(--content-tertiary)]">
          <span>{toolsData.totalToolCount} total {toolsData.totalToolCount === 1 ? "tool" : "tools"}</span>
          <span>~{toolsData.totalEstimatedTokens.toLocaleString()} total tokens</span>
        </div>
      ) : null}

      {serversLoading ? (
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading MCP servers...</span>
        </div>
      ) : serversError ? (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Failed to load MCP servers. Check that an assistant is running.
        </p>
      ) : servers.length === 0 ? (
        <button
          type="button"
          onClick={handleEmptyStateAction}
          disabled={!flagsHydrated}
          className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border-element)] px-4 py-12 text-center transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none"
        >
          <Cable className="h-6 w-6 text-[var(--content-disabled)]" />
          <p className="text-body-medium-default text-[var(--content-default)]">No MCP Servers</p>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {mcpAddServerEnabled
              ? "Add an MCP server to extend your assistant with external tools."
              : "Chat with your assistant to set up an MCP server."}
          </p>
        </button>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              toolsSummary={toolsByServer.get(server.id)}
              onToggleEnabled={handleToggleEnabled}
              onRemove={setRemoveServerId}
              onConfigure={setConfigureServerId}
              onAuthenticate={handleAuthenticate}
              onRevokeOAuth={handleRevokeOAuth}
              isUpdating={pendingMutations.has(server.id)}
              isAuthenticating={authenticatingServerId === server.id}
              isRevoking={revokingServerId === server.id}
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
        toolsSummary={configureServerId ? toolsByServer.get(configureServerId) : undefined}
        onClose={() => setConfigureServerId(null)}
        onSave={handleSave}
        isPending={isSaving}
      />

      <ConfirmDialog
        open={!!removeServerId}
        title="Remove MCP Server"
        message={`Are you sure you want to remove "${removeServerId}"? This will disconnect all tools provided by this server.`}
        confirmLabel="Remove"
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
