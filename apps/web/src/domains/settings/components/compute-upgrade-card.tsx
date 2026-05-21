import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Radio, RadioGroup } from "@vellum/design-library/components/radio";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { extractResizeError } from "@/domains/settings/components/resize-errors.js";
import {
  assistantsResizeMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { MachineSizeEnum } from "@/generated/api/types.gen.js";
import type { Assistant } from "@/assistant/api.js";
import {
  machineSizeRank,
  SIZE_DESCRIPTION,
  SIZE_LABEL,
  TIER_TO_SIZES,
} from "@/lib/billing/machine-sizes.js";

export interface ComputeUpgradeCardProps {
  assistant: Assistant;
  refetch: () => Promise<void> | void;
}

/**
 * Settings card that lets a Pro-plan user resize the compute profile of the
 * current assistant. Always rendered for Pro (returns `null` for non-Pro);
 * the page already gates the self-hosted/local fallback by only mounting for
 * a platform assistant.
 *
 * Offers every machine size up to the org's `max_machine_tier` ceiling. Sizes
 * at or below the assistant's current size are disabled — this card only
 * upsizes the single assistant; downsizing is not offered here. Confirms via
 * `ConfirmDialog` because the resize restarts the pod and makes the assistant
 * briefly unreachable.
 */
export function ComputeUpgradeCard({
  assistant,
  refetch,
}: ComputeUpgradeCardProps) {
  const { data: subscription } = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const isPro = subscription?.plan_id === "pro";

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isPro,
  });

  // `machine_size` is widened to `MachineSizeEnum | NullEnum | null`; treat
  // null, undefined, and the empty string all as the unset/small case (the
  // backing field is a blankable CharField and backend logic also treats ""
  // as small).
  const currentSize: MachineSizeEnum =
    (assistant.machine_size as MachineSizeEnum) || "small";

  const maxMachineTier = onboardingQuery.data?.max_machine_tier ?? null;
  const allowedSizes: MachineSizeEnum[] =
    (maxMachineTier && TIER_TO_SIZES[maxMachineTier]) || [];

  const [selected, setSelected] = useState<MachineSizeEnum | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Compute profile updated. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      void refetch();
    },
    onError: (error) => {
      toast.error(
        extractResizeError(
          error,
          "Failed to update compute profile. Please try again.",
        ),
        { id: "assistant-resize-error" },
      );
    },
  });

  if (!isPro) {
    return null;
  }

  const currentRank = machineSizeRank(currentSize);

  // A picked size is only valid if it's still allowed and strictly larger than
  // the current size (no downsize from this card).
  const effectiveSelected =
    selected &&
    allowedSizes.includes(selected) &&
    machineSizeRank(selected) > currentRank
      ? selected
      : null;

  const isLoading = resizeMutation.isPending;
  const canApply = effectiveSelected != null && !isLoading;

  return (
    <>
      <SettingsCard
        title="Compute Profile"
        subtitle="Your Pro plan includes larger compute profiles with more CPU and memory."
      >
        <div className="flex flex-col gap-4">
          <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Current:{" "}
            <span className="text-[var(--content-default)]">
              {SIZE_LABEL[currentSize]}
            </span>
          </span>

          {onboardingQuery.isLoading ? (
            // `allowedSizes` is empty while the onboarding query is in flight
            // (it only fires once `isPro` is true), so surface a loading state
            // rather than the "no tier configured" warning, which would
            // otherwise flash and disable the resize action mid-fetch.
            <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-body-medium-lighter">
                Loading machine configuration...
              </span>
            </div>
          ) : onboardingQuery.isError && onboardingQuery.data == null ? (
            // On an initial-load error `allowedSizes` is empty; show an error
            // Notice instead of the (incorrect) "no tier configured" warning.
            // Gate on missing data so a background-refetch failure with valid
            // cached `max_machine_tier` keeps the size picker rendered.
            <Notice tone="error">Failed to load machine configuration.</Notice>
          ) : allowedSizes.length === 0 ? (
            <Notice tone="warning">
              Your subscription does not have a machine tier configured. Contact
              support if this is unexpected.
            </Notice>
          ) : (
            <>
              <RadioGroup<MachineSizeEnum>
                name="compute-machine-size"
                value={effectiveSelected ?? ("" as MachineSizeEnum)}
                onValueChange={setSelected}
                aria-label="Compute machine size"
              >
                {allowedSizes.map((size) => {
                  // Disable the current size and anything smaller — this card
                  // only upsizes the current assistant.
                  const disabled = machineSizeRank(size) <= currentRank;
                  return (
                    <Radio<MachineSizeEnum>
                      key={size}
                      value={size}
                      label={SIZE_LABEL[size]}
                      helperText={SIZE_DESCRIPTION[size]}
                      disabled={disabled || isLoading}
                    />
                  );
                })}
              </RadioGroup>

              <div className="flex items-center justify-between gap-4">
                <Notice tone="warning">
                  Resizing will briefly make your assistant unreachable while it
                  restarts.
                </Notice>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canApply}
                  leftIcon={
                    isLoading ? <Loader2 className="animate-spin" /> : undefined
                  }
                  className="shrink-0"
                >
                  Apply
                </Button>
              </div>
            </>
          )}
        </div>
      </SettingsCard>
      <ConfirmDialog
        open={confirmOpen}
        title="Resize Compute Profile"
        message="Your assistant will briefly restart and be unreachable while the resize applies. Continue?"
        confirmLabel="Resize"
        onConfirm={() => {
          // Close the dialog immediately so a slow request can't be
          // double-submitted by repeated clicks while the mutation is
          // pending. The button busy state and the error toast already
          // provide adequate feedback.
          setConfirmOpen(false);
          if (!effectiveSelected) return;
          resizeMutation.mutate({
            path: { id: assistant.id },
            body: { machine_size: effectiveSelected },
          });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
