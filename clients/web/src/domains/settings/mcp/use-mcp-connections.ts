import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@vellumai/design-library/components/toast";

import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import {
  addMcpServer,
  fetchMcpServers,
  fetchMcpToolsSummary,
  removeMcpServer,
  updateMcpServer,
} from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";
import { useMcpConnect } from "./use-mcp-connect";

export type McpCustomConfig = Parameters<typeof addMcpServer>[1] & {
  autoAuth?: boolean;
};

export function useMcpConnections(assistantId: string) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const auth = useMcpConnect(assistantId);
  const [addOpen, setAddOpen] = useState(false);
  const [configureServerId, setConfigureServerId] = useState<string | null>(
    null,
  );
  const [removeServerId, setRemoveServerId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: mcpQueryKeys.list(assistantId),
    queryFn: () => fetchMcpServers(assistantId),
  });
  const configureServer =
    list.data?.servers.find((server) => server.id === configureServerId) ??
    null;
  const details = useQuery({
    queryKey: mcpQueryKeys.details(assistantId),
    queryFn: () => fetchMcpToolsSummary(assistantId),
    enabled: configureServer !== null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: mcpQueryKeys.list(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: mcpQueryKeys.details(assistantId),
    });
  };
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
    onSuccess: (_data, serverId) => {
      if (auth.attempt?.serverId === serverId) {
        auth.stopWaiting();
      }
      invalidate();
      setRemoveServerId(null);
      setConfigureServerId(null);
      toast.success(t("mcpPage.toastRemoved", { serverId }));
    },
    onError: (error, serverId) => {
      captureError(error, { context: "mcp.remove" });
      toast.error(t("mcpPage.toastRemoveFailed", { serverId }));
    },
  });
  const addCustom = (config: McpCustomConfig) => {
    if (config.autoAuth) {
      auth.connect(
        config.name,
        async () => {
          await add.mutateAsync(config);
        },
        config.name,
      );
    } else {
      add.mutate(config);
    }
  };

  return {
    list,
    details,
    auth,
    add,
    save,
    remove,
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
