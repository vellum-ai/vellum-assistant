import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library";

import {
  usePluginsByNameDeleteMutation,
  usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { invalidatePluginQueries } from "@/lib/invalidate-plugin-queries";
import { showPluginUninstallWarnings } from "@/lib/plugin-uninstall-warnings";

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
  const removeMutation = usePluginsByNameDeleteMutation({
    onSuccess: (result) => {
      invalidatePluginQueries(queryClient, assistantId, name);
      options?.onRemoved?.();
      showPluginUninstallWarnings(result?.warnings, t);
    },
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
      removeMutation.mutate({
        path: { assistant_id: assistantId, name },
      });
    },
    isInstalling: installMutation.isPending,
    isRemoving: removeMutation.isPending,
    isInstallError: installMutation.isError,
    isRemoveError: removeMutation.isError,
  };
}
