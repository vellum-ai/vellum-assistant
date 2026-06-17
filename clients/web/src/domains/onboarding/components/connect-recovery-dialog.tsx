import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Modal } from "@vellumai/design-library/components/modal";

import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";

type RecoveryStep = "menu" | "confirm-repair" | "confirm-retire";

interface ConnectRecoveryDialogProps {
  open: boolean;
  /** Display label of the assistant that failed to connect. */
  assistantName: string;
  /** A repair or retire is in flight. */
  isPending: boolean;
  /** Failure from a repair/retire attempt, shown inline. */
  errorMessage?: string;
  onCancel: () => void;
  /** Fired only after the nested repair confirmation. */
  onRepair: () => void;
  /** Fired only after the nested retire confirmation. */
  onRetire: () => void;
}

/**
 * Recovery dialog for a local assistant whose guardian token is missing or
 * can no longer be refreshed. Offers three paths: cancel back to the chooser,
 * wake-and-repair (re-provisions the token — revokes the assistant's other
 * device-bound tokens, so it sits behind an explicit confirmation), or retire
 * (destructive, also confirmed).
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
  const [step, setStep] = useState<RecoveryStep>("menu");

  useEffect(() => {
    if (open) setStep("menu");
  }, [open]);

  // A span (not <p>) so it can nest inside ConfirmDialog's <p> description.
  const errorLine = errorMessage ? (
    <span className="mt-3 block text-body-small-default text-[var(--system-negative-strong)]">
      {errorMessage}
    </span>
  ) : null;

  if (step === "confirm-repair") {
    return (
      <ConfirmDialog
        open={open}
        title="Repair Assistant?"
        message={
          <>
            Repairing re-provisions this assistant&rsquo;s authentication
            token. Any other devices or browser sessions connected to it will
            be signed out and need to reconnect.
            {errorLine}
          </>
        }
        confirmLabel="Repair"
        isPending={isPending}
        onConfirm={onRepair}
        onCancel={() => setStep("menu")}
      />
    );
  }

  if (step === "confirm-retire") {
    return (
      <RetireConfirmDialog
        open={open}
        isPending={isPending}
        extraMessage={errorLine}
        onConfirm={onRetire}
        onCancel={() => setStep("menu")}
      />
    );
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !isPending) onCancel();
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isPending) onCancel();
        }}
      >
        <Modal.Header>
          <Modal.Title>Can&rsquo;t Authenticate Assistant</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            The authentication token for {assistantName} is missing or can no
            longer be refreshed, so this assistant can&rsquo;t be connected.
            You can repair it, retire it, or pick a different assistant.
          </Modal.Description>
          {errorLine}
          <div className="mt-5 flex w-full flex-col gap-2">
            <Button
              variant="primary"
              fullWidth
              disabled={isPending}
              onClick={() => setStep("confirm-repair")}
            >
              Wake &amp; Repair
            </Button>
            <Button
              variant="dangerOutline"
              fullWidth
              disabled={isPending}
              onClick={() => setStep("confirm-retire")}
            >
              Retire Assistant
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
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConnectRecoveryDialog };
