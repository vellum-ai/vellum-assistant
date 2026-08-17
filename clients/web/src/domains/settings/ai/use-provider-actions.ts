import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { isDefaultProviderId } from "@/domains/settings/ai/provider-row-meta";
import { t } from "@/i18n";
import {
  configGetQueryKey,
  configLlmDefaultproviderGetQueryKey,
  configLlmDefaultproviderPutMutation,
  inferenceProviderconnectionsGetQueryKey,
  inferenceProfilesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { inferenceProviderconnectionsByNameDelete } from "@/generated/daemon/sdk.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";

export interface ProviderActions {
  /** Point the default provider at this connection. No-op when ineligible. */
  setDefault: (conn: ProviderConnection) => void;
  /** True while the set-default mutation targets `name`. */
  isSettingDefault: (name: string) => boolean;
  deleteConnection: (name: string) => Promise<void>;
}

/**
 * Row mutations for the Providers section. Set-default refreshes the
 * default-provider status, the config, and the effective profile catalog
 * (managed tiers resolve their model through the default provider); delete
 * refreshes the connection list. Errors surface as toasts.
 */
export function useProviderActions(
  assistantId: string,
  options?: { onDeleted?: (name: string) => void },
): ProviderActions {
  const queryClient = useQueryClient();
  const pathOpts = { path: { assistant_id: assistantId } };

  const setDefaultMutation = useMutation({
    ...configLlmDefaultproviderPutMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: configLlmDefaultproviderGetQueryKey(pathOpts),
      });
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey(pathOpts),
      });
      void queryClient.invalidateQueries({
        queryKey: inferenceProfilesGetQueryKey(pathOpts),
      });
    },
    onError: (error) => {
      captureError(error, { context: "settings-ai-set-default-provider" });
      toast.error(t("settings:useProviderActions.setDefaultFailedToast"));
    },
  });

  function setDefault(conn: ProviderConnection) {
    if (!isDefaultProviderId(conn.provider)) {
      return;
    }
    setDefaultMutation.mutate({
      path: { assistant_id: assistantId },
      body: { provider: conn.provider, connectionName: conn.name },
    });
  }

  function isSettingDefault(name: string): boolean {
    return (
      setDefaultMutation.isPending &&
      setDefaultMutation.variables?.body?.connectionName === name
    );
  }

  async function deleteConnection(name: string) {
    try {
      const { response } = await inferenceProviderconnectionsByNameDelete({
        path: { assistant_id: assistantId, name },
      });
      if (response?.ok || response?.status === 404) {
        // 404 means already gone; still refresh the list.
        void queryClient.invalidateQueries({
          queryKey: inferenceProviderconnectionsGetQueryKey(pathOpts),
        });
        options?.onDeleted?.(name);
      } else if (response?.status === 409) {
        toast.error(t("settings:useProviderActions.deleteInUseToast"));
      } else {
        toast.error(t("settings:useProviderActions.deleteFailedToast"));
      }
    } catch (error) {
      captureError(error, { context: "settings-ai-provider-delete" });
      toast.error(t("settings:useProviderActions.deleteFailedToast"));
    }
  }

  return { setDefault, isSettingDefault, deleteConnection };
}
