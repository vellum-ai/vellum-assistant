import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";
import { useCallback, useRef } from "react";

import {
  assistantsOauthConnectionsListQueryKey,
  assistantsOauthConnectionsListSetQueryData,
  useAssistantsOauthDisconnectByConnectionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { usePluginUninstall } from "@/hooks/use-plugin-actions";
import { useTranslation } from "@/i18n";
import { extractErrorMessage } from "@/utils/api-errors";

import { isMcpMethodKind, type ConnectionSummary } from "../connect-plan";

export interface UseIntegrationDisconnectOptions {
  /** The assistant the plugins belong to. */
  assistantId: string;
  /** The platform assistant the managed connections belong to. */
  platformAssistantId: string | null;
  /** Ends a sign-in still waiting on the server being taken away. */
  onStopAuth: (serverId: string) => void;
  /** Removes an MCP server that no plugin owns. */
  onRemoveServer: (serverId: string) => void;
  /**
   * An uninstall took the plugin's servers with it. Only the plugin queries
   * are invalidated for us, so the server list is reloaded here.
   */
  onPluginRemoved: () => void;
}

/**
 * Taking one connection away, whichever kind it is.
 *
 * A managed account is revoked at the platform; an MCP server a plugin owns
 * goes with the plugin, because the plugin is what declared it and leaving it
 * installed would put the server straight back. The caller passes the
 * integration's display name along with the row, since the toast names the
 * integration rather than the plumbing behind it.
 */
export function useIntegrationDisconnect({
  assistantId,
  platformAssistantId,
  onStopAuth,
  onRemoveServer,
  onPluginRemoved,
}: UseIntegrationDisconnectOptions) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  // The name is read when the request settles, which is after the dialog that
  // knew it has closed.
  const name = useRef("");

  const uninstall = usePluginUninstall(assistantId, {
    onRemoved: () => {
      onPluginRemoved();
      toast.success(
        t("integrationConnect.removedToast", { name: name.current }),
      );
    },
    onRemoveError: () =>
      toast.error(
        t("integrationConnect.removeFailedToast", { name: name.current }),
      ),
  });

  const connectionsOpts = {
    path: { assistant_id: platformAssistantId ?? "" },
  };
  const disconnectAccount =
    useAssistantsOauthDisconnectByConnectionCreateMutation({
      onSuccess(_data, variables) {
        toast.success(
          t("integrationConnect.disconnectedToast", { name: name.current }),
        );
        const connectionId = variables.path.connection_id;
        assistantsOauthConnectionsListSetQueryData(
          queryClient,
          connectionsOpts,
          (old) => old?.filter((entry) => entry.id !== connectionId),
        );
        void queryClient.invalidateQueries({
          queryKey: assistantsOauthConnectionsListQueryKey(connectionsOpts),
        });
      },
      onError(error) {
        toast.error(
          extractErrorMessage(
            error,
            undefined,
            t("integrationConnect.disconnectFailedToast", {
              name: name.current,
            }),
          ),
        );
      },
    });

  const mutateAccount = disconnectAccount.mutate;
  const removePlugin = uninstall.remove;
  return useCallback(
    (connection: ConnectionSummary, displayName: string) => {
      name.current = displayName;
      if (isMcpMethodKind(connection.methodKind)) {
        if (connection.serverId) {
          onStopAuth(connection.serverId);
        }
        if (connection.pluginName) {
          removePlugin(connection.pluginName);
          return;
        }
        if (connection.serverId) {
          onRemoveServer(connection.serverId);
        }
        return;
      }
      if (!connection.accountId || !platformAssistantId) {
        return;
      }
      mutateAccount({
        path: {
          assistant_id: platformAssistantId,
          connection_id: connection.accountId,
        },
      });
    },
    [
      mutateAccount,
      onRemoveServer,
      onStopAuth,
      platformAssistantId,
      removePlugin,
    ],
  );
}
