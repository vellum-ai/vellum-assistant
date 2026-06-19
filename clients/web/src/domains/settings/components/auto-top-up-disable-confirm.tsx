import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

export interface AutoTopUpDisableConfirmProps {
  open: boolean;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reconfirm dialog for the destructive "Disable automatic top-ups" action.
 * Single-sentence body — fits the `ConfirmDialog` primitive exactly. If the
 * copy ever needs structure (bullets, etc.), swap to `Modal.*` directly.
 */
export function AutoTopUpDisableConfirm({
  open,
  confirming,
  onCancel,
  onConfirm,
}: AutoTopUpDisableConfirmProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Disable automatic top-ups?"
      message="Auto top-ups will stop. Any saved payment method stays on file."
      confirmLabel={confirming ? "Disabling…" : "Disable"}
      cancelLabel="Keep enabled"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
