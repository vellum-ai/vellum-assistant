/**
 * Confirmation dialog for app deletion.
 * Thin wrapper around ConfirmDialog with destructive styling.
 */

import type { AppSummary } from "@/types/app-types";
import { ConfirmDialog } from "@vellumai/design-library";

interface DeleteAppDialogProps {
  app: AppSummary | null;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteAppDialog({
  app,
  isDeleting,
  onConfirm,
  onCancel,
}: DeleteAppDialogProps) {
  return (
    <ConfirmDialog
      open={app !== null}
      title="Delete app"
      message={app ? `"${app.name}" will be permanently removed.` : ""}
      confirmLabel={isDeleting ? "Deleting…" : "Delete"}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
