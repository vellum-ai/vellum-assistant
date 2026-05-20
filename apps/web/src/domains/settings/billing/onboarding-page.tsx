import { AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Input } from "@vellum/design-library/components/input";
import { Notice } from "@vellum/design-library/components/notice";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellum/design-library/components/segment-control";
import { Typography } from "@vellum/design-library/components/typography";
import type { MachineSizeEnum, MachineTierEnum } from "@/generated/api/types.gen.js";
import {
  organizationsBillingSubscriptionOnboardingDomainCreateMutation,
  organizationsBillingSubscriptionOnboardingMachineCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";
import { routes } from "@/utils/routes.js";

export const DOMAIN_EXIT_DELAY_MS = 800;

/**
 * Pro onboarding wizard.
 *
 * Step 0 ("confirm-pro"): Race-guards the Stripe-redirect-vs-webhook-delivery
 * window. The user is redirected here from Stripe Checkout's success_url, but
 * `customer.subscription.created` is not guaranteed to have been processed by
 * the time the browser hits this page. We poll
 * `GET /v1/organizations/billing/subscription/` until `plan_id === "pro"` or
 * the timeout fires.
 *
 * Step 1 ("pvc-readiness"): Once Pro is confirmed, poll
 * `GET /v1/organizations/billing/subscription/onboarding/` until
 * `pvc_ready === true` or the timeout fires. PVC provisioning typically
 * completes in 10-20 seconds.
 *
 * Step 2 ("machine-size"): Pick a default machine size for new assistants,
 * filtered by the org's `max_machine_tier`. Submits to
 * `POST /v1/organizations/billing/subscription/onboarding/machine/`.
 *
 * Step 3 ("domain"): Optional custom subdomain `<sub>.<emailRootDomain>`
 * (env-aware, e.g. `vellum.me` in prod) registered via
 * `POST /v1/organizations/billing/subscription/onboarding/domain/`. The
 * user can also explicitly skip; both terminal paths return the user to
 * billing settings.
 */

export const PRO_POLL_INTERVAL_MS = 1000;
export const PRO_POLL_TIMEOUT_MS = 10_000;
export const PVC_POLL_INTERVAL_MS = 2000;
export const PVC_POLL_TIMEOUT_MS = 30_000;

const MACHINE_SIZE_ORDER: readonly MachineSizeEnum[] = [
  "small",
  "medium",
  "large",
  "extra_large",
];

const TIER_TO_MAX_SIZE_INDEX: Record<MachineTierEnum, number> = {
  medium: 1, // small, medium
  large: 2, // small, medium, large
  xl: 3, // small, medium, large, extra_large
};

const MACHINE_SIZE_LABEL: Record<MachineSizeEnum, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  extra_large: "Extra large",
};

/**
 * Returns the allowed machine sizes for an org's tier, in ascending order.
 * null/unknown tier → fall back to the most restrictive tier (medium).
 */
export function allowedMachineSizesForTier(
  tier: MachineTierEnum | null | undefined,
): MachineSizeEnum[] {
  const ceilingIdx =
    TIER_TO_MAX_SIZE_INDEX[tier as MachineTierEnum] ??
    TIER_TO_MAX_SIZE_INDEX.medium;
  return MACHINE_SIZE_ORDER.slice(0, ceilingIdx + 1);
}

const ONBOARDING_MACHINE_DRF_FIELD_KEYS = [
  "machine_size",
  "subdomain",
  "non_field_errors",
] as const;

/**
 * Maps backend onboarding error codes (sent as `{ error: "<code>" }`) to
 * user-facing messages. Codes are emitted by `django/app/billing/onboarding_views.py`.
 */
export const ONBOARDING_ERROR_CODE_MESSAGES: Record<string, string> = {
  subdomain_taken: "That subdomain is already taken. Try another.",
  assistant_already_has_domain:
    "Your assistant already has a custom domain.",
  no_assistant_to_attach_domain:
    "We couldn't find an assistant to attach this domain to.",
  exceeds_machine_tier: "That machine size isn't available on your plan.",
};

/**
 * Extracts a user-facing error message from the response shapes used by the
 * onboarding endpoints. Probe order:
 *   1. `{ error: "<code>" }` — the real backend envelope used by
 *      `onboarding_views.py` for all coded failure modes.
 *   2. DRF field-error arrays (`machine_size`, `subdomain`, `non_field_errors`).
 *   3. `detail` string.
 *   4. Caller-provided fallback.
 */
export function extractOnboardingErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.error === "string") {
      const mapped = ONBOARDING_ERROR_CODE_MESSAGES[rec.error];
      if (mapped) return mapped;
    }
    for (const key of ONBOARDING_MACHINE_DRF_FIELD_KEYS) {
      const msgs = rec[key];
      if (Array.isArray(msgs) && typeof msgs[0] === "string") {
        return msgs[0];
      }
    }
    if (typeof rec.detail === "string") {
      return rec.detail;
    }
  }
  return fallback;
}

type WizardStep =
  | "confirm-pro"
  | "pvc-readiness"
  | "machine-size"
  | "domain";

export function BillingOnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>("confirm-pro");
  const [proPollExpired, setProPollExpired] = useState(false);
  const [pvcPollExpired, setPvcPollExpired] = useState(false);

  const goToBilling = useCallback(
    () => navigate(routes.settings.billing, { replace: true }),
    [navigate],
  );

  // Force a refetch on mount so we don't read a stale cached "base" entry
  // from the billing page the user just left.
  useEffect(() => {
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
  }, [queryClient]);

  // ----- Step 0: Pro confirmation race guard -----

  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    refetchInterval: (query) => {
      const planId = query.state.data?.plan_id;
      if (planId === "pro" || proPollExpired) return false;
      return PRO_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    enabled: step === "confirm-pro",
  });

  useEffect(() => {
    if (step !== "confirm-pro") return;
    const t = setTimeout(() => setProPollExpired(true), PRO_POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [step]);

  useEffect(() => {
    if (step !== "confirm-pro") return;
    if (subscriptionQuery.data?.plan_id === "pro") {
      setStep("pvc-readiness");
    }
  }, [step, subscriptionQuery.data?.plan_id]);

  // ----- Step 1: PVC readiness -----

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    refetchInterval: (query) => {
      const ready = query.state.data?.pvc_ready === true;
      if (ready || pvcPollExpired) return false;
      return PVC_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    enabled: step === "pvc-readiness",
  });

  useEffect(() => {
    if (step !== "pvc-readiness") return;
    const t = setTimeout(() => setPvcPollExpired(true), PVC_POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [step]);

  // Force a fresh onboarding read when we enter the PVC step so we don't
  // immediately observe a stale cached value.
  useEffect(() => {
    if (step !== "pvc-readiness") return;
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    });
  }, [step, queryClient]);

  // ----- Step 1 → Step 2 transition -----

  useEffect(() => {
    if (step !== "pvc-readiness") return;
    if (onboardingQuery.data?.pvc_ready === true) {
      setStep("machine-size");
    }
  }, [step, onboardingQuery.data?.pvc_ready]);

  // ----- Step 2 → Step 3 advance -----
  //
  // Gate on the backend's `domain_setup_available` flag: if the org has no
  // assistant to attach a domain to, the domain step would dead-end with
  // `no_assistant_to_attach_domain`. Skip straight to billing instead.
  const domainSetupAvailable = onboardingQuery.data?.domain_setup_available;
  const advanceFromMachineSize = useCallback(() => {
    if (domainSetupAvailable === false) {
      goToBilling();
    } else {
      setStep("domain");
    }
  }, [domainSetupAvailable, goToBilling]);

  return (
    <div className="max-w-4xl space-y-6">
      <Card padding="lg">{renderStep()}</Card>
    </div>
  );

  function renderStep() {
    if (step === "confirm-pro") {
      if (subscriptionQuery.isError) {
        return <FetchErrorState onGoToBilling={goToBilling} />;
      }
      if (proPollExpired) {
        return (
          <TimeoutState
            message="We're still confirming your upgrade. Try again from billing in a moment."
            onGoToBilling={goToBilling}
          />
        );
      }
      return (
        <PendingState
          title="Finalizing your upgrade…"
          body="Stripe is confirming your subscription. This usually takes a few seconds."
        />
      );
    }

    if (step === "pvc-readiness") {
      if (onboardingQuery.isError) {
        return <FetchErrorState onGoToBilling={goToBilling} />;
      }
      if (pvcPollExpired) {
        return (
          <TimeoutState
            message="We're still setting up your workspace. Try again from billing in a moment."
            onGoToBilling={goToBilling}
          />
        );
      }
      // pvc_ready=true case is handled by the effect that advances to
      // "machine-size"; render the pending state in the meantime.
      return (
        <PendingState
          title="Setting up your workspace…"
          body="We're provisioning storage for your assistant. This usually takes 10–20 seconds."
        />
      );
    }

    if (step === "machine-size") {
      if (onboardingQuery.isError) {
        // We still need the onboarding state for `max_machine_tier`.
        return <FetchErrorState onGoToBilling={goToBilling} />;
      }
      const maxTier = (onboardingQuery.data?.max_machine_tier ??
        null) as MachineTierEnum | null;
      return (
        <MachineSizeStep
          maxTier={maxTier}
          onAdvance={advanceFromMachineSize}
        />
      );
    }

    if (step === "domain") {
      return <DomainStep onExit={goToBilling} />;
    }

    return null;
  }
}

function MachineSizeStep({
  maxTier,
  onAdvance,
}: {
  maxTier: MachineTierEnum | null;
  onAdvance: () => void;
}) {
  const items = useMemo<SegmentControlItem<MachineSizeEnum>[]>(
    () =>
      allowedMachineSizesForTier(maxTier).map((size) => ({
        value: size,
        label: MACHINE_SIZE_LABEL[size],
      })),
    [maxTier],
  );
  const [selected, setSelected] = useState<MachineSizeEnum>(
    items[0]?.value ?? "small",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const machineMutation = useMutation(
    organizationsBillingSubscriptionOnboardingMachineCreateMutation(),
  );

  const handleContinue = () => {
    if (machineMutation.isPending) return;
    machineMutation.mutate(
      { body: { machine_size: selected } },
      {
        onSuccess: () => {
          setErrorMsg(null);
          onAdvance();
        },
        onError: (err) => {
          setErrorMsg(
            extractOnboardingErrorMessage(
              err,
              "Couldn't update machine size. Please try again.",
            ),
          );
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Typography variant="title-small" as="h1">
          Choose your machine size
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          This sets the default size for new assistants. You can change it
          later in billing settings.
        </Typography>
      </div>

      <SegmentControl
        items={items}
        value={selected}
        onChange={setSelected}
        ariaLabel="Machine size"
      />

      {errorMsg ? <Notice tone="error">{errorMsg}</Notice> : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outlined"
          data-testid="onboarding-machine-skip"
          onClick={onAdvance}
        >
          Skip for now
        </Button>
        <Button
          variant="primary"
          data-testid="onboarding-machine-continue"
          disabled={machineMutation.isPending}
          onClick={handleContinue}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function DomainStep({ onExit }: { onExit: () => void }) {
  const { emailRootDomain } = useAppFeatureFlags();
  const [subdomain, setSubdomain] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const domainMutation = useMutation(
    organizationsBillingSubscriptionOnboardingDomainCreateMutation(),
  );

  const busy = domainMutation.isPending || confirmed;

  // Auto-exit after the success notice has rendered for DOMAIN_EXIT_DELAY_MS.
  // Pattern mirrors the upgrade/success page redirect effect so that unmount
  // clears the timer instead of leaking it.
  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(onExit, DOMAIN_EXIT_DELAY_MS);
    return () => clearTimeout(t);
  }, [confirmed, onExit]);

  const handleSet = () => {
    if (busy || !subdomain) return;
    domainMutation.mutate(
      { body: { subdomain } },
      {
        onSuccess: () => {
          setErrorMsg(null);
          setConfirmed(true);
        },
        onError: (err) => {
          setErrorMsg(
            extractOnboardingErrorMessage(
              err,
              "Couldn't register that subdomain. Try a different one.",
            ),
          );
        },
      },
    );
  };

  const handleSkip = () => {
    if (busy) return;
    // The skip path should never strand the user: exit to billing on both
    // success and failure responses from the backend.
    domainMutation.mutate(
      { body: { skipped: true } },
      { onSuccess: onExit, onError: () => onExit() },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Typography variant="title-small" as="h1">
          Pick a custom subdomain (optional)
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          Your assistant will be reachable at{" "}
          <span className="font-mono">
            {subdomain || "<subdomain>"}.{emailRootDomain}
          </span>
          . You can change this later.
        </Typography>
      </div>

      <div className="flex items-center gap-2">
        <Input
          fullWidth
          value={subdomain}
          onChange={(e) =>
            setSubdomain(e.target.value.toLowerCase().trim())
          }
          disabled={busy}
          placeholder="my-assistant"
          label="Subdomain"
        />
        <Typography
          variant="body-medium-lighter"
          as="span"
          className="whitespace-nowrap text-[var(--content-secondary)]"
        >
          .{emailRootDomain}
        </Typography>
      </div>

      {errorMsg ? <Notice tone="error">{errorMsg}</Notice> : null}
      {confirmed ? (
        <Notice tone="success">Domain set — redirecting…</Notice>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outlined"
          data-testid="onboarding-domain-skip"
          disabled={busy}
          onClick={handleSkip}
        >
          Skip for now
        </Button>
        <Button
          variant="primary"
          data-testid="onboarding-domain-set"
          disabled={!subdomain || busy}
          onClick={handleSet}
        >
          Set domain
        </Button>
      </div>
    </div>
  );
}

function PendingState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <Loader2
        className="h-6 w-6 animate-spin text-[var(--content-secondary)]"
        aria-hidden="true"
      />
      <Typography variant="title-small" as="h1">
        {title}
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        {body}
      </Typography>
    </div>
  );
}

function FetchErrorState({ onGoToBilling }: { onGoToBilling: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <AlertCircle
        className="h-8 w-8 text-[var(--system-negative-strong)]"
        aria-hidden="true"
      />
      <Typography variant="title-small" as="h1">
        Couldn&apos;t reach billing
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        We hit a problem checking your subscription. Your upgrade may still be
        processing — return to billing to refresh.
      </Typography>
      <div className="mt-4 flex justify-center">
        <Button
          variant="primary"
          data-testid="onboarding-go-to-billing"
          onClick={onGoToBilling}
        >
          Go to billing
        </Button>
      </div>
    </div>
  );
}

function TimeoutState({
  message,
  onGoToBilling,
}: {
  message: string;
  onGoToBilling: () => void;
}) {
  return (
    <div className="space-y-4">
      <Notice tone="warning">{message}</Notice>
      <div className="flex justify-end">
        <Button
          variant="outlined"
          data-testid="onboarding-go-to-billing"
          onClick={onGoToBilling}
        >
          Go to billing
        </Button>
      </div>
    </div>
  );
}
