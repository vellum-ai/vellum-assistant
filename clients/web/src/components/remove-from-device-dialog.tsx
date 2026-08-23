import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useTranslation } from "@/i18n";

/**
 * Shared "Remove from this device?" confirmation, mounted by both the
 * assistant chooser and the tray-command handler in `RootLayout` so the copy
 * cannot drift. A paired entry is a pairing record on this machine, a
 * platform entry is a device-local listing, and an origin entry is a
 * remembered remote address; no removal touches the assistant itself, which
 * is what the per-kind copy explains.
 */
export function RemoveFromDeviceDialog({
  open,
  kind,
  assistantName,
  errorMessage,
  isPending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /**
   * Which removal copy applies: a pairing, a platform listing, or a
   * remembered remote origin.
   */
  kind: "paired" | "platform" | "origin";
  assistantName: string;
  /** Inline failure line under the message when a removal attempt failed. */
  errorMessage?: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  const message =
    kind === "paired"
      ? t("removeFromDeviceDialog.messagePaired", { assistantName })
      : kind === "origin"
        ? t("removeFromDeviceDialog.messageOrigin", { assistantName })
        : t("removeFromDeviceDialog.messagePlatform", { assistantName });

  return (
    <ConfirmDialog
      open={open}
      title={t("removeFromDeviceDialog.title")}
      message={
        <>
          {message}
          {errorMessage && (
            <span className="mt-2 block text-[var(--system-negative-strong)]">
              {errorMessage}
            </span>
          )}
        </>
      }
      confirmLabel={t("removeFromDeviceDialog.confirm")}
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
