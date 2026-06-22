import { useCallback, useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
    assistantsActiveRetrieveOptions,
    organizationsBillingSubscriptionOnboardingRetrieveOptions,
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
    organizationsBillingSubscriptionRetrieveOptions,
    organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineTierEnum } from "@/generated/api/types.gen";
import { Modal } from "@vellumai/design-library/components/modal";

import { CompleteState } from "./complete-state";
import { DomainStep } from "./domain-step";
import { FetchErrorState, TimeoutState } from "./error-states";
import { PendingState } from "./pending-state";
import { SetupStep } from "./setup-step";
import { PRO_POLL_INTERVAL_MS, PRO_POLL_TIMEOUT_MS } from "./utils";
import { WelcomeState } from "./welcome-state";

type WizardStep = "confirm-pro" | "welcome" | "setup" | "domain" | "complete";

export interface BillingOnboardingModalProps {
  open: boolean;
  onClose: () => void;
}

export function BillingOnboardingModal({
  open,
  onClose,
}: BillingOnboardingModalProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>("confirm-pro");
  const [proPollExpired, setProPollExpired] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);

  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
    // Refresh the tier-ceiling cache (`max_machine_tier`,
    // `selected_storage_gib`) the wizard's SetupStep and the shared Storage &
    // Resources ResizeCard read from, so neither renders pre-upgrade limits
    // once the new subscription is confirmed.
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    });
  }, [open, queryClient]);

  const retryPoll = useCallback(() => {
    setProPollExpired(false);
    setPollGeneration((g) => g + 1);
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
  }, [queryClient]);

  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    refetchInterval: (query) => {
      const planId = query.state.data?.plan_id;
      if (planId === "pro" || proPollExpired) return false;
      return PRO_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    enabled: open && step === "confirm-pro",
  });

  useEffect(() => {
    if (!open || step !== "confirm-pro") return;
    const t = setTimeout(() => setProPollExpired(true), PRO_POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [open, step, pollGeneration]);

  useEffect(() => {
    if (step !== "confirm-pro") return;
    if (subscriptionQuery.data?.plan_id === "pro") {
      setStep("welcome");
    }
  }, [step, subscriptionQuery.data?.plan_id]);

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: open && step !== "confirm-pro",
  });

  useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: open,
  });

  const domainSetupAvailable = onboardingQuery.data?.domain_setup_available;
  // Domain/email/guardian registration must run while the assistant's machine
  // is still online: registering the email triggers a guardian-channel write to
  // the machine's gateway. The SetupStep's "Apply & Restart" takes the machine
  // offline, so the domain step runs *before* setup — otherwise that write hangs
  // against a restarting machine.
  const advanceFromWelcome = useCallback(() => {
    if (domainSetupAvailable === false) {
      setStep("setup");
    } else {
      setStep("domain");
    }
  }, [domainSetupAvailable]);
  const backFromSetup = useCallback(() => {
    if (domainSetupAvailable === false) {
      setStep("welcome");
    } else {
      setStep("domain");
    }
  }, [domainSetupAvailable]);

  // The welcome card is the user's first real touchpoint with the flow; we lock
  // it so an accidental backdrop click or Esc can't bail them out of setup. The
  // explicit X (shown only here) is the deliberate exit, and the card's copy
  // tells them they can opt into these features later from Settings.
  const isFirstCard = step === "welcome";

  return (
    <Modal.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
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
    if (step === "confirm-pro") {
      if (subscriptionQuery.isError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      if (proPollExpired) {
        return (
          <TimeoutState
            message="We're still confirming your upgrade."
            onRetry={retryPoll}
            onGoToBilling={onClose}
          />
        );
      }
      return (
        <PendingState
          title="Finalizing your upgrade…"
          body="This usually takes a few seconds."
        />
      );
    }

    if (step === "welcome") {
      if (onboardingQuery.isError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      // Gate "Get started" until fresh onboarding data has settled:
      // advanceFromWelcome routes on domain_setup_available. isPending covers the
      // cold load; isFetching covers the background refetch from the on-open
      // invalidation, during which TanStack still serves stale cached data — a
      // fast click then would route on a pre-checkout domain_setup_available.
      // On error we show FetchErrorState above rather than routing on stale data.
      return (
        <WelcomeState
          onContinue={advanceFromWelcome}
          continueDisabled={onboardingQuery.isPending || onboardingQuery.isFetching}
        />
      );
    }

    if (step === "domain") {
      return (
        <DomainStep
          onBack={() => setStep("welcome")}
          onExit={() => setStep("setup")}
        />
      );
    }

    if (step === "setup") {
      if (onboardingQuery.isError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      const maxTier = (onboardingQuery.data?.max_machine_tier ??
        null) as MachineTierEnum | null;
      // When domain setup is unavailable the domain step is skipped, so setup is
      // the sole step in the indicator; otherwise it's the second of two.
      const domainStepIncluded = domainSetupAvailable !== false;
      return (
        <SetupStep
          storageGib={onboardingQuery.data?.selected_storage_gib ?? null}
          maxTier={maxTier}
          onBack={backFromSetup}
          onAdvance={() => setStep("complete")}
          dotIndex={domainStepIncluded ? 1 : 0}
          dotTotal={domainStepIncluded ? 2 : 1}
        />
      );
    }

    if (step === "complete") {
      return <CompleteState onBack={() => setStep("setup")} />;
    }

    return null;
  }
}
