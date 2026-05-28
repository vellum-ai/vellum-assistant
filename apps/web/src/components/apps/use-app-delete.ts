/**
 * Manages the app deletion flow — confirmation state and async delete.
 *
 * Handles cache invalidation, HTML cache cleanup, and pin removal
 * when an app is successfully deleted.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { appsByIdDeletePost } from "@/generated/daemon/sdk.gen";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import { clearAppHtmlCache } from "@/utils/app-html-cache";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { toast } from "@vellum/design-library";

export function useAppDelete(assistantId: string) {
  const queryClient = useQueryClient();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();

  const [appPendingDelete, setAppPendingDelete] = useState<AppSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    const target = appPendingDelete;
    if (!target || isDeleting) return;
    setIsDeleting(true);
    try {
      await appsByIdDeletePost({
        path: { assistant_id: assistantId, id: target.id },
        throwOnError: true,
      });
      clearAppHtmlCache(assistantId, target.id);
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      if (pinnedAppIds.has(target.id)) {
        togglePin(target);
      }
      setAppPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete app");
    } finally {
      setIsDeleting(false);
    }
  }, [appPendingDelete, isDeleting, assistantId, pinnedAppIds, togglePin, queryClient]);

  const handleCancelDelete = useCallback(() => {
    if (!isDeleting) setAppPendingDelete(null);
  }, [isDeleting]);

  return {
    appPendingDelete,
    setAppPendingDelete,
    isDeleting,
    handleConfirmDelete,
    handleCancelDelete,
  };
}
