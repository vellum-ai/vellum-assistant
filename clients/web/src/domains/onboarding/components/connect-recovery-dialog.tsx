import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";

interface ConnectRecoveryDialogProps {
  open: boolean;
  /** Display label of the assistant that failed to connect. */
  assistantName: string;
  /** A repair or retire is in flight. */
  isPending: boolean;
  /** Failure from a repair/retire attempt, shown inline. */
  errorMessage?: string;
  onCancel: () => void;
  /** Fired directly by the primary action. */
  onRepair: () => void;
  /** Fired only after the nested retire confirmation. */
  onRetire: () => void;
}

/**
 * Recovery dialog for a local assistant whose guardian token is missing or
 * can no longer be refreshed. Offers three paths: wake-and-repair, cancel back
 * to the chooser, or retire.
 *
 * Repair is the way back in and fires on a single click. It re-provisions the
 * token and so revokes the assistant's other device-bound tokens; that
 * consequence is stated in the body copy, which is where a user reaching this
 * dialog on every launch will actually read it, rather than behind a second
 * confirmation step they learn to click through.
 *
 * Retire is destructive and unrelated to getting back in, so it sits below a
 * divider in a compact, low-emphasis form instead of adjacent to the primary
 * button, and keeps its own confirmation.
 */
function ConnectRecoveryDialog({
  open,
  assistantName,
  isPending,
  errorMessage,
  onCancel,
  onRepair,
  onRetire,
}: ConnectRecoveryDialogProps) {
  const [confirmingRetire, setConfirmingRetire] = useState(false);

  useEffect(() => {
    if (open) {
      setConfirmingRetire(false);
    }
  }, [open]);

  // A span (not <p>) so it can nest inside ConfirmDialog's <p> description.
  const errorLine = errorMessage ? (
    <span className="mt-3 block text-body-small-default text-[var(--system-negative-strong)]">
      {errorMessage}
    </span>
  ) : null;

  if (confirmingRetire) {
    return (
      <RetireConfirmDialog
        open={open}
        isPending={isPending}
        extraMessage={errorLine}
        onConfirm={onRetire}
        onCancel={() => setConfirmingRetire(false)}
      />
    );
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !isPending) {
          onCancel();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isPending) {
            onCancel();
          }
        }}
      >
        <Modal.Header>
          <Modal.Title>Can&rsquo;t Authenticate Assistant</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            The authentication token for {assistantName} is missing or can no
            longer be refreshed, so this assistant can&rsquo;t be connected.
            Repairing wakes it and re-provisions the token; any other devices or
            browser sessions connected to it will be signed out and need to
            reconnect.
          </Modal.Description>
          {errorLine}
          <div className="mt-5 flex w-full flex-col gap-2">
            <Button
              variant="primary"
              fullWidth
              disabled={isPending}
              leftIcon={
                isPending ? <Loader2 className="animate-spin" /> : undefined
              }
              onClick={onRepair}
            >
              {isPending ? "Repairing…" : "Wake & Repair"}
            </Button>
            <Button
              variant="outlined"
              fullWidth
              disabled={isPending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
          <div className="mt-4 flex justify-center border-t border-[var(--border-base)] pt-3">
            <Button
              variant="dangerGhost"
              size="compact"
              disabled={isPending}
              onClick={() => setConfirmingRetire(true)}
            >
              Retire Assistant…
            </Button>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConnectRecoveryDialog };
