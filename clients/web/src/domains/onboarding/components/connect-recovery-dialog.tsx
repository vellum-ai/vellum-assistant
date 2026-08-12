import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Modal } from "@vellumai/design-library/components/modal";

import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation("onboarding");
  const [step, setStep] = useState<RecoveryStep>("menu");

  useEffect(() => {
    if (open) {
      setStep("menu");
    }
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
        title={t("connectRecoveryDialog.repairTitle")}
        message={
          <>
            {t("connectRecoveryDialog.repairBody")}
            {errorLine}
          </>
        }
        confirmLabel={t("connectRecoveryDialog.repairConfirm")}
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
          <Modal.Title>
            {t("connectRecoveryDialog.authFailedTitle")}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            {t("connectRecoveryDialog.authFailedBody", {
              name: assistantName,
            })}
          </Modal.Description>
          {errorLine}
          <div className="mt-5 flex w-full flex-col gap-2">
            <Button
              variant="primary"
              fullWidth
              disabled={isPending}
              onClick={() => setStep("confirm-repair")}
            >
              {t("connectRecoveryDialog.wakeAndRepair")}
            </Button>
            <Button
              variant="dangerOutline"
              fullWidth
              disabled={isPending}
              onClick={() => setStep("confirm-retire")}
            >
              {t("connectRecoveryDialog.retire")}
            </Button>
            <Button
              variant="outlined"
              fullWidth
              disabled={isPending}
              onClick={onCancel}
            >
              {t("actions.cancel")}
            </Button>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConnectRecoveryDialog };
