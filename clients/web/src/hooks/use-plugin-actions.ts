import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library";
import { useCallback } from "react";

import {
  usePluginsByNameDeleteMutation,
  usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { invalidatePluginQueries } from "@/lib/invalidate-plugin-queries";
import { showPluginUninstallWarnings } from "@/lib/plugin-uninstall-warnings";

/**
 * Uninstalling a plugin, for a surface that only learns which plugin at the
 * moment the user asks. A row in a list of connections names its plugin in its
 * own data, so the name belongs to the call rather than to the hook.
 */
export function usePluginUninstall(
  assistantId: string,
  options?: {
    onRemoved?: (name: string) => void;
    onRemoveError?: (name: string) => void;
  },
) {
  const { t } = useTranslation("intelligence");
  const queryClient = useQueryClient();

  const removeMutation = usePluginsByNameDeleteMutation({
    onSuccess: (result, variables) => {
      const name = variables.path.name;
      invalidatePluginQueries(queryClient, assistantId, name);
      options?.onRemoved?.(name);
      showPluginUninstallWarnings(result?.warnings, t);
    },
    onError: (_error, variables) => {
      options?.onRemoveError?.(variables.path.name);
    },
  });

  const mutate = removeMutation.mutate;
  const remove = useCallback(
    (name: string) => {
      mutate({ path: { assistant_id: assistantId, name } });
    },
    [assistantId, mutate],
  );

  return {
    remove,
    isRemoving: removeMutation.isPending,
    isRemoveError: removeMutation.isError,
  };
}

export function usePluginActions(
  assistantId: string,
  name: string,
  options?: {
    onInstalled?: () => void;
    onRemoved?: () => void;
    announceInstall?: boolean;
  },
) {
  const { t } = useTranslation("intelligence");
  const queryClient = useQueryClient();

  const installMutation = usePluginsInstallPostMutation({
    onSuccess: () => {
      invalidatePluginQueries(queryClient, assistantId, name);
      options?.onInstalled?.();
      if (options?.announceInstall !== false) {
        toast.success(
          t("pluginToast.installed", {
            name: name || t("pluginToast.pluginFallback"),
          }),
        );
      }
    },
  });
  const uninstall = usePluginUninstall(assistantId, {
    onRemoved: () => options?.onRemoved?.(),
  });

  return {
    install: () => {
      installMutation.mutate({
        path: { assistant_id: assistantId },
        body: { name },
      });
    },
    installAsync: () =>
      installMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { name },
      }),
    remove: () => {
      uninstall.remove(name);
    },
    isInstalling: installMutation.isPending,
    isRemoving: uninstall.isRemoving,
    isInstallError: installMutation.isError,
    isRemoveError: uninstall.isRemoveError,
  };
}
