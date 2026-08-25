/**
 * Confirmation dialog for app deletion.
 * Thin wrapper around ConfirmDialog with destructive styling.
 */

import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={app !== null}
      title={t("deleteAppDialog.title")}
      message={
        app
          ? t("deleteAppDialog.message", { name: app.name })
          : ""
      }
      confirmLabel={
        isDeleting
          ? t("deleteAppDialog.deleting")
          : t("deleteAppDialog.delete")
      }
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
