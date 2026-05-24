import { useCallback, useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Modal } from "@vellum/design-library/components/modal";
import type { MachineTierEnum } from "@/generated/api/types.gen.js";
import {
  assistantsActiveRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";

import { CompleteState } from "./complete-state.js";
import { DomainStep } from "./domain-step.js";
import { FetchErrorState, TimeoutState } from "./error-states.js";
import { PendingState } from "./pending-state.js";
import { SetupStep } from "./setup-step.js";
import { PRO_POLL_INTERVAL_MS, PRO_POLL_TIMEOUT_MS } from "./utils.js";
import { WelcomeState } from "./welcome-state.js";

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
  const advanceFromSetup = useCallback(() => {
    if (domainSetupAvailable === false) {
      setStep("complete");
    } else {
      setStep("domain");
    }
  }, [domainSetupAvailable]);

  return (
    <Modal.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Modal.Content size="md" hideCloseButton className="overflow-hidden">
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
      return <WelcomeState onContinue={() => setStep("setup")} />;
    }

    if (step === "setup") {
      if (onboardingQuery.isError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      const maxTier = (onboardingQuery.data?.max_machine_tier ??
        null) as MachineTierEnum | null;
      return (
        <SetupStep
          storageGib={onboardingQuery.data?.selected_storage_gib ?? null}
          maxTier={maxTier}
          onBack={() => setStep("welcome")}
          onAdvance={advanceFromSetup}
        />
      );
    }

    if (step === "domain") {
      return (
        <DomainStep
          onBack={() => setStep("setup")}
          onExit={() => setStep("complete")}
        />
      );
    }

    if (step === "complete") {
      const backFromComplete = domainSetupAvailable === false ? "setup" : "domain";
      return <CompleteState onBack={() => setStep(backFromComplete)} />;
    }

    return null;
  }
}
