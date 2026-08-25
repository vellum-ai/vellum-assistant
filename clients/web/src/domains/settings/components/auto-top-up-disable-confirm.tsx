import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useTranslation } from "@/i18n";

export interface AutoTopUpDisableConfirmProps {
  open: boolean;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reconfirm dialog for the destructive "Disable auto-reload" action.
 * Single-sentence body — fits the `ConfirmDialog` primitive exactly. If the
 * copy ever needs structure (bullets, etc.), swap to `Modal.*` directly.
 */
export function AutoTopUpDisableConfirm({
  open,
  confirming,
  onCancel,
  onConfirm,
}: AutoTopUpDisableConfirmProps) {
  const { t } = useTranslation("settings");
  return (
    <ConfirmDialog
      open={open}
      title={t("autoTopUpDisableConfirm.title")}
      message={t("autoTopUpDisableConfirm.message")}
      confirmLabel={
        confirming
          ? t("autoTopUpDisableConfirm.disabling")
          : t("autoTopUpDisableConfirm.disable")
      }
      cancelLabel={t("autoTopUpDisableConfirm.keepEnabled")}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
