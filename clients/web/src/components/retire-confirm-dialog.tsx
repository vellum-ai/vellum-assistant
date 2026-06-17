import type { ReactNode } from "react";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

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
  return (
    <ConfirmDialog
      open={open}
      title="Retire Assistant"
      message={
        <>
          This will permanently retire this assistant and all of its data. You
          will need to go through the onboarding flow again to create a new
          one. This action cannot be undone.
          {extraMessage}
        </>
      }
      confirmLabel="Retire"
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export { RetireConfirmDialog };
