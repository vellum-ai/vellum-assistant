import { useCallback, useEffect, useState } from "react";

import {
    clearCheckoutIntent,
    readCheckoutIntent,
    type CheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { isElectron } from "@/runtime/is-electron";
import { cn } from "@/utils/misc";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

import { CompleteState } from "./complete-state";
import { DomainStep } from "./domain-step";
import { FetchErrorState } from "./error-states";
import type { ProvisioningDimensions } from "./provisioning-machine";
import { ProvisioningState } from "./provisioning-state";
import { useProProvisioning } from "./use-pro-provisioning";

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

  // Stalled recovery re-calls the idempotent, org-wide ensure-provisioned
  // reconcile — the same path the wizard fires on Pro confirmation. Its errors
  // surface as-is; a server-side resize that is still running converges the
  // actuals polling to DONE and replaces the stalled UI regardless.
  const { stalledAction } = provisioning;
  const stalledActionIfStalled =
    provisioning.state === "STALLED" ? stalledAction : undefined;

  // The fetch-error variant of the provisioning step is a standard dismissible
  // card, not the locked full-bleed takeover — otherwise the light error UI is
  // marooned in the dark full-screen viewport and the user can't act on it.
  const provisioningError =
    step === "provisioning" &&
    (provisioning.confirmError || provisioning.targetsError);

  const handleClose = () => {
    if (step === "provisioning" && !provisioningError && machineBusy) {
      toast.info("Your upgrade continues in the background.");
    }
    onClose();
  };

  // The live provisioning takeover is the user's first real touchpoint with the
  // flow; we lock it so an accidental backdrop click or Esc can't bail them out
  // mid-provisioning. The explicit X (shown only here) is the deliberate exit.
  const isTakeover = step === "provisioning" && !provisioningError;

  // data-theme="dark" also themes Modal.Content's close button so it reads on
  // the dark backdrop. In Electron the X clears the title-bar drag strip (a
  // fixed z-100 band over the top 28px) so it stays clickable.
  const provisioningContentClass = cn(
    "overflow-hidden inset-0 max-w-none w-screen h-screen max-h-none rounded-none border-0",
    "[&_[aria-label=Close]]:[-webkit-app-region:no-drag]",
    isElectron() && "[&_[aria-label=Close]]:top-12",
  );

  return (
    <Modal.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <Modal.Content
        size="md"
        hideCloseButton={!isTakeover}
        dismissOnOverlayClick={!isTakeover}
        onEscapeKeyDown={isTakeover ? (e) => e.preventDefault() : undefined}
        onInteractOutside={isTakeover ? (e) => e.preventDefault() : undefined}
        data-theme={isTakeover ? "dark" : undefined}
        overlayClassName={isTakeover ? "bg-black p-0" : undefined}
        className={isTakeover ? provisioningContentClass : "overflow-hidden"}
      >
        {/* Keyed on step so the fade replays as we swap takeover ⇄ card. */}
        <div
          key={step}
          className="flex min-h-0 flex-1 flex-col [animation:fadeIn_0.25s_ease-out_both] motion-reduce:[animation:none]"
        >
          {renderStep()}
        </div>
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
          assistantId={assistantId}
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
          stalledAction={stalledActionIfStalled}
          assistantId={assistantId}
          onExit={() => setStep("complete")}
        />
      );
    }

    return (
      <CompleteState
        finishedInBackground={finishedInBackground && !provisioningSettled}
        stalledAction={stalledActionIfStalled}
        assistantId={assistantId}
      />
    );
  }
}
