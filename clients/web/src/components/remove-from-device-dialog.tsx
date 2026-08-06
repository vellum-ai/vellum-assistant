import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

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
  return (
    <ConfirmDialog
      open={open}
      title="Remove from this device?"
      message={
        <>
          {kind === "paired" ? (
            <>
              This won&rsquo;t affect {assistantName} on its host machine. It
              only forgets the pairing on this device. Pair again anytime with
              vellum connect import.
            </>
          ) : kind === "origin" ? (
            <>
              This won&rsquo;t affect {assistantName} or sign you out there. It
              only forgets the entry on this device. Add it again anytime.
            </>
          ) : (
            <>
              This won&rsquo;t delete {assistantName}. It only removes it from
              this device. Logging in will make it available again.
            </>
          )}
          {errorMessage && (
            <span className="mt-2 block text-[var(--system-negative-strong)]">
              {errorMessage}
            </span>
          )}
        </>
      }
      confirmLabel="Remove"
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
