import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { toast } from "@vellumai/design-library";

import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { appsByIdDeletePost } from "@/generated/daemon/sdk.gen";
import { t } from "@/i18n";
import type { AppSummary } from "@/types/app-types";
import { clearAppHtmlCache } from "@/utils/app-html-cache";

/**
 * Shared app-deletion state and mutation, owned by whichever view renders
 * the `DeleteAppDialog` (the library gallery and the conversation assets
 * pill). Runs the full cleanup sequence in one place so the two entry
 * points cannot drift: `appsByIdDeletePost` + HTML cache clear +
 * `appsGet` invalidation. The app's pin is dropped by the daemon as part of
 * the delete, so it is not cleared here.
 *
 * NOTE for popover/sheet callers: render `DeleteAppDialog` OUTSIDE the
 * `Popover.Root`/`BottomSheet.Root` subtree. The portaled dialog steals
 * focus, which closes the popover; if the dialog lives inside it, the
 * confirmation unmounts before the user can act.
 */
export function useAppDelete(assistantId: string) {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<AppSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      await appsByIdDeletePost({
        path: { assistant_id: assistantId, id: pendingDelete.id },
        throwOnError: true,
      });
      clearAppHtmlCache(assistantId, pendingDelete.id);
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      setPendingDelete(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("useAppDelete.deleteFailed"),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, isDeleting, assistantId, queryClient]);

  const cancelDelete = useCallback(() => {
    if (!isDeleting) {
      setPendingDelete(null);
    }
  }, [isDeleting]);

  return {
    pendingDelete,
    isDeleting,
    requestDelete: setPendingDelete,
    confirmDelete,
    cancelDelete,
  };
}
