import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@vellumai/design-library/components/toast";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { hasDuplicateCatalogInstance, mcpDisplayName } from "../integration-items";
import {
  addMcpServer,
  fetchMcpServers,
  fetchMcpToolsSummary,
  reloadMcpServers,
  removeMcpServer,
  updateMcpServer,
} from "./mcp-api";
import {
  connectMcpCatalogEntry,
  fetchMcpCatalog,
  type McpCatalogEntry,
} from "./mcp-catalog-api";
import { invalidateMcpQueries, mcpQueryKeys } from "./mcp-query-keys";
import { useMcpConnect } from "./use-mcp-connect";

export type McpCustomConfig = Parameters<typeof addMcpServer>[1] & {
  autoAuth?: boolean;
};

export function useMcpConnections(assistantId: string) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const auth = useMcpConnect(assistantId);
  const [addOpen, setAddOpen] = useState(false);
  const [configureServerId, setConfigureServerId] = useState<string | null>(
    null,
  );
  const [removeServerId, setRemoveServerId] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: mcpQueryKeys.catalog(assistantId),
    queryFn: () => fetchMcpCatalog(assistantId),
    enabled: isOrgReady,
    staleTime: 60_000,
  });
  const list = useQuery({
    queryKey: mcpQueryKeys.list(assistantId),
    queryFn: () => fetchMcpServers(assistantId),
    enabled: isOrgReady,
  });
  const configureServer =
    list.data?.servers.find((server) => server.id === configureServerId) ??
    null;
  const serverDisplayName = (serverId: string) => {
    const server = list.data?.servers.find((entry) => entry.id === serverId);
    return server ? mcpDisplayName(server, catalog.data?.entries) : serverId;
  };
  const serverInstanceDisplayName = (serverId: string) => {
    const servers = list.data?.servers ?? [];
    const server = servers.find((entry) => entry.id === serverId);
    const name = serverDisplayName(serverId);
    return server && hasDuplicateCatalogInstance(server, servers)
      ? t("mcpCatalog.instanceName", { name, id: serverId })
      : name;
  };
  const details = useQuery({
    queryKey: mcpQueryKeys.details(assistantId),
    queryFn: () => fetchMcpToolsSummary(assistantId),
    enabled: isOrgReady && configureServer !== null,
  });

  const invalidate = () => invalidateMcpQueries(queryClient, assistantId);
  const add = useMutation({
    mutationFn: (config: McpCustomConfig) => addMcpServer(assistantId, config),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
    },
    onError: (error) => {
      captureError(error, { context: "mcp.add" });
      toast.error(t("mcpConnect.addFailed"));
    },
  });
  const save = useMutation({
    mutationFn: (updates: Parameters<typeof updateMcpServer>[1]) =>
      updateMcpServer(assistantId, updates),
    onSuccess: () => {
      invalidate();
      setConfigureServerId(null);
    },
    onError: (error) => {
      captureError(error, { context: "mcp.update" });
      toast.error(t("mcpConnect.saveFailed"));
    },
  });
  const remove = useMutation({
    mutationFn: (serverId: string) => removeMcpServer(assistantId, serverId),
    onMutate: (serverId) => ({ displayName: serverDisplayName(serverId) }),
    onSuccess: (_data, serverId, context) => {
      if (auth.attempt?.serverId === serverId) {
        auth.stopWaiting();
      }
      invalidate();
      setRemoveServerId(null);
      setConfigureServerId(null);
      toast.success(
        t("mcpPage.toastRemoved", { serverId: context.displayName }),
      );
    },
    onError: (error, serverId, context) => {
      captureError(error, { context: "mcp.remove" });
      toast.error(
        t("mcpPage.toastRemoveFailed", {
          serverId: context?.displayName ?? serverDisplayName(serverId),
        }),
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => reloadMcpServers(assistantId),
    onSuccess: invalidate,
    onError: (error) => {
      captureError(error, { context: "mcp.reload" });
      toast.error(t("mcpPage.toastReloadFailed"));
    },
  });
  const addCustom = (config: McpCustomConfig) => {
    if (config.autoAuth) {
      auth.connect(config.name, async () => {
        await add.mutateAsync(config);
      });
    } else {
      add.mutate(config);
    }
  };

  const connectCatalog = (
    entry: McpCatalogEntry,
    setupAcknowledged = false,
  ) => {
    if (!catalog.data?.supportsConnect) {
      return;
    }
    auth.connect(entry.displayName, async () => {
      const result = await connectMcpCatalogEntry(assistantId, {
        catalogId: entry.id,
        serverKey: entry.serverKey,
        definitionDigest: entry.definitionDigest,
        setupAcknowledged,
      });
      invalidate();
      return result.serverId;
    });
  };

  return {
    catalog,
    connectCatalog,
    connectServer: (serverId: string) =>
      auth.connect(serverId, undefined, serverDisplayName(serverId)),
    serverDisplayName,
    serverInstanceDisplayName,
    list,
    details,
    auth,
    add,
    save,
    remove,
    reload,
    addCustom,
    addOpen,
    setAddOpen,
    configureServer,
    configureServerId,
    setConfigureServerId,
    removeServerId,
    setRemoveServerId,
  };
}
