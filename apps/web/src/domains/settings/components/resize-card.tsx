import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Checkbox } from "@vellum/design-library/components/checkbox";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { Radio, RadioGroup } from "@vellum/design-library/components/radio";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { extractResizeError } from "@/domains/settings/components/resize-errors.js";
import {
  assistantsResizeMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { MachineSizeEnum } from "@/generated/api/types.gen.js";
import type { Assistant, AssistantHealthz } from "@/assistant/api.js";
import {
  allowedMachineSizesForTier,
  machineSizeRank,
  SIZE_DESCRIPTION,
  SIZE_LABEL,
} from "@/lib/billing/machine-sizes.js";

export interface ResizeCardProps {
  assistant: Assistant;
  healthz: AssistantHealthz | null;
  refetch: () => Promise<void> | void;
}

/**
 * Unified settings card that lets a Pro-plan user resize THIS assistant's
 * compute profile and/or persistent storage in a single action. Renders as
 * `null` for non-Pro users; the page already gates the self-hosted/local
 * fallback by only mounting for a platform assistant.
 *
 * Both dimensions are independent and optional:
 *   - Machine size: offers every size up to the org's `max_machine_tier`,
 *     upsize-only (current/smaller sizes disabled).
 *   - Storage: an "apply plan max" toggle that grows the PVC to the
 *     plan-included ceiling (`selected_storage_gib`).
 *
 * A single Apply issues exactly one `assistantsResize` call carrying ONLY the
 * changed dimension(s) (the serializer requires at least one). The restart
 * warning + confirm dialog appear ONLY when the machine size changes — PVC
 * growth is an online expansion that does not restart the pod.
 */
export function ResizeCard({ assistant, healthz, refetch }: ResizeCardProps) {
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const subscription = subscriptionQuery.data;
  const isPro = subscription?.plan_id === "pro";

  // Endpoint is Pro-only; skip until plan resolves so non-Pro users never
  // fire the onboarding query.
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
  const allowedSizes = allowedMachineSizesForTier(maxMachineTier);

  const availableGib = onboardingQuery.data?.selected_storage_gib ?? null;
  // healthz.disk.totalMb reflects the provisioned PVC size. Mirror the MB->GiB
  // rounding used elsewhere; absent metrics means we can't compute headroom.
  const currentGib =
    healthz?.disk != null ? Math.round(healthz.disk.totalMb / 1024) : null;

  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum | null>(
    null,
  );
  const [applyStorage, setApplyStorage] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setSelectedSize(null);
      setApplyStorage(false);
      void refetch();
    },
    onError: (error) => {
      toast.error(
        extractResizeError(
          error,
          "Failed to resize assistant. Please try again.",
        ),
        { id: "assistant-resize-error" },
      );
    },
  });

  // Surface a transient subscription-fetch failure rather than silently
  // hiding the card: a failed initial subscription fetch leaves `isPro`
  // false, which would otherwise rob a genuine Pro user of the resize
  // affordance during an outage. Gate on missing data (not `isError` alone):
  // React Query keeps the last good `data` during a background-refetch
  // failure, so when cached subscription data is present we fall through to
  // the normal isPro/non-Pro logic instead of flashing this error card.
  if (subscriptionQuery.isError && subscription == null) {
    return (
      <SettingsCard
        title="Compute & Storage"
        subtitle="Your Pro plan includes larger compute profiles and additional storage for this assistant."
      >
        <Notice tone="error">
          Could not load your subscription. Please try again.
        </Notice>
      </SettingsCard>
    );
  }

  if (!isPro) {
    return null;
  }

  const currentRank = machineSizeRank(currentSize);

  // A picked size is only valid if it's still allowed and strictly larger than
  // the current size (no downsize from this card).
  const effectiveSelectedSize =
    selectedSize &&
    allowedSizes.includes(selectedSize) &&
    machineSizeRank(selectedSize) > currentRank
      ? selectedSize
      : null;

  // Storage can grow only when the plan ceiling is known and exceeds the
  // current PVC size.
  const canGrowStorage =
    availableGib != null && currentGib != null && currentGib < availableGib;
  const effectiveStorageGib =
    applyStorage && canGrowStorage ? availableGib : null;

  const isLoading = resizeMutation.isPending;
  const machineChanges = effectiveSelectedSize != null;
  const storageChanges = effectiveStorageGib != null;
  const canApply = (machineChanges || storageChanges) && !isLoading;

  const submit = () => {
    const body: { machine_size?: MachineSizeEnum; storage_gib?: number } = {};
    if (effectiveSelectedSize != null) {
      body.machine_size = effectiveSelectedSize;
    }
    if (effectiveStorageGib != null) {
      body.storage_gib = effectiveStorageGib;
    }
    // Never send an empty body — the serializer requires at least one field.
    if (body.machine_size == null && body.storage_gib == null) return;
    resizeMutation.mutate({ path: { id: assistant.id }, body });
  };

  const handleApply = () => {
    // Only a machine-size change restarts the pod, so only that path needs the
    // confirm dialog. Storage-only growth is an online PVC expansion.
    if (machineChanges) {
      setConfirmOpen(true);
      return;
    }
    submit();
  };

  return (
    <>
      <SettingsCard
        title="Compute & Storage"
        subtitle="Your Pro plan includes larger compute profiles and additional storage for this assistant."
      >
        <div className="flex flex-col gap-6">
          {onboardingQuery.isLoading ? (
            // `allowedSizes`/`availableGib` are empty while the onboarding
            // query is in flight (it only fires once `isPro` is true). Show a
            // loading affordance rather than the configured states, which
            // would otherwise flash mid-fetch.
            <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-body-medium-lighter">
                Loading resize configuration...
              </span>
            </div>
          ) : onboardingQuery.isError && onboardingQuery.data == null ? (
            // On an initial-load error we have no tier/storage data; surface an
            // error Notice instead of the (incorrect) configured states. Gate
            // on missing data so a background-refetch failure with valid cached
            // values keeps the controls rendered.
            <Notice tone="error">Failed to load resize configuration.</Notice>
          ) : (
            <>
              {/* Compute profile */}
              <div className="flex flex-col gap-3">
                <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                  Compute profile:{" "}
                  <span className="text-[var(--content-default)]">
                    {SIZE_LABEL[currentSize]}
                  </span>
                </span>
                {allowedSizes.length === 0 ? (
                  <Notice tone="warning">
                    Your subscription does not have a machine tier configured.
                    Contact support if this is unexpected.
                  </Notice>
                ) : (
                  <RadioGroup<MachineSizeEnum>
                    name="resize-machine-size"
                    value={effectiveSelectedSize ?? ("" as MachineSizeEnum)}
                    onValueChange={setSelectedSize}
                    aria-label="Compute machine size"
                  >
                    {allowedSizes.map((size) => {
                      // Disable the current size and anything smaller — this
                      // card only upsizes the current assistant.
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
                )}
              </div>

              {/* Storage */}
              <div className="flex flex-col gap-3">
                <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
                  This assistant uses{" "}
                  <span className="text-[var(--content-default)]">
                    {currentGib != null
                      ? `~${currentGib} GiB`
                      : "an unknown amount"}
                  </span>{" "}
                  {availableGib != null ? (
                    <>
                      of{" "}
                      <span className="text-[var(--content-default)]">
                        {availableGib} GiB
                      </span>{" "}
                      included in your plan.
                    </>
                  ) : (
                    "of the storage included in your plan."
                  )}
                </p>
                {canGrowStorage ? (
                  <Checkbox
                    checked={applyStorage}
                    disabled={isLoading}
                    onCheckedChange={(c) => setApplyStorage(c === true)}
                    aria-label="Apply plan storage maximum"
                    label={
                      <>
                        Grow storage to{" "}
                        <span className="text-[var(--content-default)]">
                          {availableGib} GiB
                        </span>{" "}
                        to use your full plan allocation.
                      </>
                    }
                  />
                ) : (
                  <Notice tone="neutral">
                    {currentGib != null && availableGib != null
                      ? "This assistant is at its plan storage maximum."
                      : "Your plan's included storage has been applied."}
                  </Notice>
                )}
              </div>

              {/* Apply */}
              <div className="flex items-center justify-between gap-4">
                {machineChanges ? (
                  <Notice tone="warning">
                    Resizing the compute profile will briefly make your
                    assistant unreachable while it restarts. Storage grows
                    online without a restart.
                  </Notice>
                ) : (
                  <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                    {storageChanges
                      ? "Storage grows online without a restart."
                      : "Select a larger compute profile or grow storage to apply."}
                  </span>
                )}
                <Button
                  onClick={handleApply}
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
        message="Your assistant will briefly restart and be unreachable while the compute profile resize applies. Continue?"
        confirmLabel="Resize"
        onConfirm={() => {
          // Close the dialog immediately so a slow request can't be
          // double-submitted by repeated clicks while the mutation is
          // pending. The button busy state and the error toast already
          // provide adequate feedback.
          setConfirmOpen(false);
          submit();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
