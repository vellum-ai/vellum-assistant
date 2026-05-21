import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { extractResizeError } from "@/domains/settings/components/resize-errors.js";
import {
  assistantsResizeMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant, AssistantHealthz } from "@/assistant/api.js";

export interface AssistantStorageCardProps {
  assistant: Assistant;
  healthz: AssistantHealthz | null;
  refetch: () => Promise<void> | void;
}

/**
 * Settings card that lets a Pro-plan user resize THIS assistant's persistent
 * storage up to the org's plan-included ceiling (`selected_storage_gib`).
 * Renders as `null` when the user is not on Pro, so the page-level mount can
 * stay unconditional aside from the self-hosted filter.
 *
 * Distinct from the org-wide billing `storage-card.tsx`: this card is
 * per-assistant and drives `assistantsResize` rather than the onboarding
 * bulk-apply endpoint. The backend never shrinks the PVC and rejects sizes
 * above the tier ceiling with 403 `exceeds_storage_tier`, so the button is
 * only offered when the current size is below the available ceiling.
 *
 * Confirms via `ConfirmDialog` because the resize restarts the pod and makes
 * the assistant briefly unreachable.
 */
export function AssistantStorageCard({
  assistant,
  healthz,
  refetch,
}: AssistantStorageCardProps) {
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

  const [confirmOpen, setConfirmOpen] = useState(false);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Storage resize started.");
      void refetch();
    },
    onError: (error) => {
      toast.error(
        extractResizeError(
          error,
          "Failed to resize storage. Please try again.",
        ),
      );
    },
  });

  // Surface a transient subscription-fetch failure rather than silently
  // hiding the card: a failed initial subscription fetch leaves `isPro`
  // false, which would otherwise rob a genuine Pro user of the resize
  // affordance during an outage. Render this before the `!isPro` gate so the
  // error wins. Gate on missing data (not `isError` alone): React Query keeps
  // the last good `data` during a background-refetch failure, so when cached
  // subscription data is present we fall through to the normal isPro/non-Pro
  // logic instead of flashing this error card.
  if (subscriptionQuery.isError && subscription == null) {
    return (
      <SettingsCard
        title="Storage"
        subtitle="Your Pro plan includes additional persistent storage for this assistant."
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

  const availableGib = onboardingQuery.data?.selected_storage_gib ?? null;
  // healthz.disk.totalMb reflects the provisioned PVC size. Mirror the MB->GiB
  // rounding used elsewhere; absent metrics means we can't compute headroom.
  const currentGib =
    healthz?.disk != null ? Math.round(healthz.disk.totalMb / 1024) : null;

  const canResize =
    availableGib != null && currentGib != null && currentGib < availableGib;

  const isLoading = resizeMutation.isPending;

  return (
    <>
      <SettingsCard
        title="Storage"
        subtitle="Your Pro plan includes additional persistent storage for this assistant."
      >
        <div className="flex flex-col gap-4">
          {onboardingQuery.isLoading ? (
            // `availableGib` is null while the onboarding query is in flight
            // (it only fires once `isPro` is true). Show a loading affordance
            // rather than the "applied"/"at maximum" state, which would
            // otherwise hide the resize button mid-fetch.
            <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-body-medium-lighter">
                Loading storage configuration...
              </span>
            </div>
          ) : onboardingQuery.isError && onboardingQuery.data == null ? (
            // On an initial-load error `availableGib` is null; surface an error
            // Notice instead of the (incorrect) "storage has been applied"
            // message. Gate on missing data so a background-refetch failure
            // with valid cached `selected_storage_gib` keeps the usage details
            // and resize controls rendered.
            <Notice tone="error">
              Could not load your storage configuration. Please try again.
            </Notice>
          ) : (
            <>
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

              {canResize ? (
                <>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                      Resize to{" "}
                      <span className="text-[var(--content-default)]">
                        {availableGib} GiB
                      </span>{" "}
                      to use your full plan allocation.
                    </span>
                    <Button
                      onClick={() => setConfirmOpen(true)}
                      disabled={isLoading}
                      leftIcon={
                        isLoading ? (
                          <Loader2 className="animate-spin" />
                        ) : undefined
                      }
                      className="shrink-0"
                    >
                      Resize Storage
                    </Button>
                  </div>
                  <Notice tone="warning">
                    Your assistant will briefly restart and be unreachable while
                    storage is resized.
                  </Notice>
                </>
              ) : (
                <Notice tone="neutral">
                  {currentGib != null && availableGib != null
                    ? "This assistant is at its plan storage maximum."
                    : "Your plan's included storage has been applied."}
                </Notice>
              )}
            </>
          )}
        </div>
      </SettingsCard>
      <ConfirmDialog
        open={confirmOpen}
        title="Resize Storage"
        message="Your assistant will briefly restart and be unreachable while storage is resized. Continue?"
        confirmLabel="Resize"
        onConfirm={() => {
          // Close the dialog immediately so a slow request can't be
          // double-submitted by repeated clicks while the mutation is
          // pending. The card-level button busy state and the error toast
          // already provide adequate feedback.
          setConfirmOpen(false);
          if (availableGib == null) return;
          resizeMutation.mutate({
            path: { id: assistant.id },
            body: { storage_gib: availableGib },
          });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
