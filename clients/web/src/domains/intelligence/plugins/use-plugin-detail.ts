import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
    hasLocalEdits as computeHasLocalEdits,
    type PluginDrift,
    usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
    pluginsByNameGetOptions,
    pluginsByNameGetQueryKey,
    pluginsByNameInspectGetQueryKey,
    pluginsGetQueryKey,
    pluginsSearchGetQueryKey,
    usePluginsByNameDeleteMutation,
    usePluginsByNameUpgradePostMutation,
    usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { toast } from "@vellumai/design-library";

/** First 7 chars of a commit SHA, matching git's default short form. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

interface UsePluginDetailOptions {
  /**
   * Invoked after a successful removal. The full-page detail view uses this to
   * navigate back to the list (nothing is left to render once the plugin is
   * gone); an in-tab panel can use it to close itself instead.
   */
  onRemoved?: () => void;
}

export interface UsePluginDetailResult {
  /** The fetched plugin, or `null` until the detail query resolves. */
  plugin: PluginsByNameGetResponse | null;
  /** Update-drift signal for the installed copy (`undefined` until resolved). */
  drift: PluginDrift | undefined;
  isLoading: boolean;
  isError: boolean;
  /** Install the available plugin (no-op gating is the caller's concern). */
  install: () => void;
  /** Remove the installed plugin; fires `onRemoved` on success. */
  remove: () => void;
  /** Upgrade the installed copy to the marketplace pin. */
  upgrade: () => void;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
  isInstallError: boolean;
  isRemoveError: boolean;
  isUpgradeError: boolean;
  /** True when the installed copy has uncommitted local edits vs its baseline. */
  hasLocalEdits: boolean;
}

/**
 * Single source of truth for a single plugin's detail view: the plugin read,
 * its update-drift inspection, and the install / remove / upgrade mutations
 * (with their toast + cache-invalidation side effects). Shared by the full-page
 * detail route and the in-tab detail panel so neither duplicates the wiring.
 *
 * Toast and invalidation behavior matches the original detail page exactly:
 * install and upgrade surface a success toast, all three invalidate the list /
 * search / detail / inspect queries, and removal defers its post-success
 * navigation to the caller via `onRemoved`.
 */
export function usePluginDetail(
  assistantId: string,
  name: string,
  options?: UsePluginDetailOptions,
): UsePluginDetailResult {
  const queryClient = useQueryClient();
  const onRemoved = options?.onRemoved;

  const detailQuery = useQuery({
    ...pluginsByNameGetOptions({
      path: { assistant_id: assistantId, name },
    }),
    enabled: Boolean(assistantId) && Boolean(name),
  });

  const installed = detailQuery.data?.installed ?? false;
  const driftQuery = usePluginDrift({
    assistantId,
    name,
    enabled: installed,
  });
  const drift = driftQuery.data;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: pluginsSearchGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    if (name) {
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameInspectGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
    }
  }, [assistantId, name, queryClient]);

  const installMutation = usePluginsInstallPostMutation({
    onSuccess: () => {
      invalidate();
      toast.success(`Installed ${name || "plugin"}`);
    },
  });

  const removeMutation = usePluginsByNameDeleteMutation({
    onSuccess: () => {
      invalidate();
      onRemoved?.();
    },
  });

  const upgradeMutation = usePluginsByNameUpgradePostMutation({
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.outcome === "already-up-to-date"
          ? `${name || "Plugin"} is already up to date`
          : `Upgraded ${name || "plugin"} to ${shortSha(result.toCommit)}`,
      );
    },
  });

  const install = () => {
    installMutation.mutate({
      path: { assistant_id: assistantId },
      body: { name },
    });
  };

  const remove = () => {
    removeMutation.mutate({
      path: { assistant_id: assistantId, name },
    });
  };

  const upgrade = () => {
    upgradeMutation.mutate({
      path: { assistant_id: assistantId, name },
      body: {},
    });
  };

  return {
    plugin: detailQuery.data ?? null,
    drift,
    isLoading: detailQuery.isLoading,
    isError: detailQuery.isError,
    install,
    remove,
    upgrade,
    isInstalling: installMutation.isPending,
    isRemoving: removeMutation.isPending,
    isUpgrading: upgradeMutation.isPending,
    isInstallError: installMutation.isError,
    isRemoveError: removeMutation.isError,
    isUpgradeError: upgradeMutation.isError,
    hasLocalEdits: computeHasLocalEdits(drift),
  };
}
