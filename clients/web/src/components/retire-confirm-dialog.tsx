import type { ReactNode } from "react";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useTranslation } from "@/i18n";

/**
 * Canonical destructive confirmation for retiring an assistant. Every retire
 * entry point (settings, the tray command, the chooser's recovery dialog)
 * renders this so the irreversible-action warning never drifts between
 * surfaces.
 */
function RetireConfirmDialog({
  open,
  isPending,
  extraMessage,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  isPending: boolean;
  /** Optional inline addendum (e.g. a prior failure) appended to the warning. */
  extraMessage?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={t("retireConfirmDialog.title")}
      message={
        <>
          {t("retireConfirmDialog.message")}
          {extraMessage}
        </>
      }
      confirmLabel={t("retireConfirmDialog.confirmLabel")}
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export { RetireConfirmDialog };
