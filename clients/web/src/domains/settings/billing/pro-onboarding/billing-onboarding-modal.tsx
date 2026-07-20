import { useCallback, useEffect, useState } from "react";

import { useMutation } from "@tanstack/react-query";

import { assistantsResizeMutation } from "@/generated/api/@tanstack/react-query.gen";
import {
    clearCheckoutIntent,
    readCheckoutIntent,
    type CheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

import { CompleteState } from "./complete-state";
import { DomainStep } from "./domain-step";
import { FetchErrorState } from "./error-states";
import type { ProvisioningDimensions } from "./provisioning-machine";
import { ProvisioningState } from "./provisioning-state";
import { useProProvisioning } from "./use-pro-provisioning";
import { isOperationAlreadyInProgressError } from "./utils";

type WizardStep = "provisioning" | "domain" | "complete";

const EMPTY_DIMENSIONS: ProvisioningDimensions = {
  machineSize: null,
  storageGib: null,
};

export interface BillingOnboardingModalProps {
  open: boolean;
  onClose: () => void;
  /** Test hook — forwarded to the provisioning screen's celebration dwell. */
  dwellMs?: number;
}

export function BillingOnboardingModal({
  open,
  onClose,
  dwellMs,
}: BillingOnboardingModalProps) {
  const [step, setStep] = useState<WizardStep>("provisioning");
  const [finishedInBackground, setFinishedInBackground] = useState(false);
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);

  // The hook owns the on-open subscription/onboarding cache invalidation and
  // every provisioning poll; it keeps tracking across step changes so a
  // backgrounded resize still resolves while the user sets up their domain.
  const provisioning = useProProvisioning({ open });

  useEffect(() => {
    if (open) {
      setIntent(readCheckoutIntent());
      return;
    }
    setStep("provisioning");
    setFinishedInBackground(false);
  }, [open]);

  useEffect(() => {
    if (step === "complete") clearCheckoutIntent();
  }, [step]);

  // Domain/email/guardian registration must run while the assistant's machine
  // is online: registering the email triggers a guardian-channel write to the
  // machine's gateway. The platform auto-resizes (and restarts) the machine
  // right after checkout, so the domain step stays guarded (submit disabled)
  // while that resize is in flight — including a stall, where the machine may
  // still be mid-restart.
  const machineBusy =
    provisioning.state === "WAITING" ||
    provisioning.state === "RESIZING" ||
    provisioning.state === "STALLED";
  const provisioningSettled =
    provisioning.state === "DONE" || provisioning.state === "NOT_APPLICABLE";

  const { targets, assistantId, domainSetupAvailable, onboardingSettled } =
    provisioning;
  // Routing must never use a stale domain_setup_available: until the first
  // post-confirm fetch settles, TanStack may still serve pre-checkout cached
  // data. Both the celebration dwell and the escape hatch wait on this.
  // Latched: once fresh data has landed, a later background refetch must not
  // yank the escape hatch or restart the dwell.
  const [routingSettled, setRoutingSettled] = useState(false);
  useEffect(() => {
    if (!open) {
      setRoutingSettled(false);
      return;
    }
    if (onboardingSettled) setRoutingSettled(true);
  }, [open, onboardingSettled]);

  const advanceFromProvisioning = useCallback(() => {
    setStep(domainSetupAvailable === false ? "complete" : "domain");
  }, [domainSetupAvailable]);

  const escapeProvisioning = useCallback(() => {
    setFinishedInBackground(true);
    advanceFromProvisioning();
  }, [advanceFromProvisioning]);

  const resizeMutation = useMutation(assistantsResizeMutation());
  const applyStalledResize = () => {
    if (resizeMutation.isPending || !assistantId || !targets) return;
    resizeMutation.mutate(
      {
        path: { id: assistantId },
        body: {
          ...(targets.machineSize != null
            ? { machine_size: targets.machineSize }
            : {}),
          ...(targets.storageGib != null
            ? { storage_gib: targets.storageGib }
            : {}),
        },
      },
      {
        // A manual apply un-stalls the flow: the hook goes back to RESIZING
        // and resumes its actuals polling so the normal DONE path can
        // complete.
        onSuccess: () => provisioning.resumeAfterManualApply(),
        onError: (error) => {
          // The platform's concurrent-operation guard rejecting the apply
          // means the resize we stalled on is in fact still running — that is
          // success-equivalent, so resume observing instead of surfacing it.
          if (isOperationAlreadyInProgressError(error)) {
            provisioning.resumeAfterManualApply();
          }
        },
      },
    );
  };
  const stalledApplyError = isOperationAlreadyInProgressError(
    resizeMutation.error,
  )
    ? null
    : resizeMutation.error;
  const stalledAction = {
    onApply: applyStalledResize,
    pending: resizeMutation.isPending,
    error: stalledApplyError,
  };

  const handleClose = () => {
    if (step === "provisioning" && machineBusy) {
      toast.info("Your upgrade continues in the background.");
    }
    onClose();
  };

  // The provisioning card is the user's first real touchpoint with the flow;
  // we lock it so an accidental backdrop click or Esc can't bail them out
  // mid-provisioning. The explicit X (shown only here) is the deliberate exit.
  const isFirstCard = step === "provisioning";

  return (
    <Modal.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <Modal.Content
        size="md"
        hideCloseButton={!isFirstCard}
        dismissOnOverlayClick={!isFirstCard}
        onEscapeKeyDown={isFirstCard ? (e) => e.preventDefault() : undefined}
        onInteractOutside={isFirstCard ? (e) => e.preventDefault() : undefined}
        className="overflow-hidden"
      >
        {renderStep()}
      </Modal.Content>
    </Modal.Root>
  );

  function renderStep() {
    if (step === "provisioning") {
      if (provisioning.confirmError || provisioning.targetsError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      return (
        <ProvisioningState
          state={provisioning.state}
          softWaiting={provisioning.softWaiting}
          intent={intent}
          targets={targets ?? EMPTY_DIMENSIONS}
          fromSnapshot={provisioning.actualsSnapshot ?? EMPTY_DIMENSIONS}
          celebrating={routingSettled}
          onCelebrationEnd={advanceFromProvisioning}
          escapeAvailable={
            machineBusy && routingSettled && provisioning.escapeEligible
          }
          onEscape={escapeProvisioning}
          stalledAction={stalledAction}
          confirm={{
            onRetry: provisioning.retryConfirm,
            onGoToBilling: onClose,
          }}
          dwellMs={dwellMs}
        />
      );
    }

    if (step === "domain") {
      return (
        <DomainStep
          machineBusy={machineBusy}
          onExit={() => setStep("complete")}
        />
      );
    }

    return (
      <CompleteState
        finishedInBackground={finishedInBackground && !provisioningSettled}
        stalled={provisioning.state === "STALLED"}
        stalledAction={stalledAction}
      />
    );
  }
}
