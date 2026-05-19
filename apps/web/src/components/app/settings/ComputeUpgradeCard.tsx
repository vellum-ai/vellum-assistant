
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import {
  assistantsProUpgradeMachineCreateMutation,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/lib/assistants/api.js";

export interface ComputeUpgradeCardProps {
  assistant: Assistant;
  refetch: () => Promise<void> | void;
}

/**
 * Settings card that lets a Pro-plan user trigger a compute-profile upgrade
 * (small -> medium) for their assistant. Renders as `null` when the user is
 * not on Pro or the assistant is already past `small`, so the page-level
 * mount can stay unconditional aside from the self-hosted filter.
 *
 * Confirms via `ConfirmDialog` because the upgrade restarts the pod and
 * makes the assistant briefly unreachable.
 */
export function ComputeUpgradeCard({
  assistant,
  refetch,
}: ComputeUpgradeCardProps) {
  const { data: subscription } = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  const upgradeMutation = useMutation({
    ...assistantsProUpgradeMachineCreateMutation(),
    onSuccess: () => {
      void refetch();
    },
    onError: () => {
      toast.error("Failed to upgrade compute profile. Please try again.");
    },
  });

  const isPro = subscription?.plan_id === "pro";
  // `machine_size` is widened to `MachineSizeEnum | NullEnum | null`; treat
  // null, undefined, and the empty string all as the unset/small case (the
  // backing field is a blankable CharField and backend logic also treats ""
  // as small). Any other value means the assistant is already upgraded and
  // this card should stay hidden so unknown future presets don't surface it.
  const isAtSmall =
    !assistant.machine_size || assistant.machine_size === "small";

  if (!isPro || !isAtSmall) {
    return null;
  }

  const isLoading = upgradeMutation.isPending;

  return (
    <>
      <SettingsCard
        title="Compute Profile"
        subtitle="Your Pro plan includes a larger compute profile with more CPU and memory."
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                Current:{" "}
                <span className="text-[var(--content-default)]">Small</span>
              </span>
              <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                Available:{" "}
                <span className="text-[var(--content-default)]">Medium</span>
              </span>
            </div>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={isLoading}
              leftIcon={
                isLoading ? <Loader2 className="animate-spin" /> : undefined
              }
              className="shrink-0"
            >
              Upgrade Compute
            </Button>
          </div>
          <Notice tone="warning">
            Upgrading will briefly make your assistant unreachable while it
            restarts.
          </Notice>
        </div>
      </SettingsCard>
      <ConfirmDialog
        open={confirmOpen}
        title="Upgrade Compute Profile"
        message="Your assistant will briefly restart and be unreachable while the upgrade applies. Continue?"
        confirmLabel="Upgrade"
        onConfirm={() => {
          // Close the dialog immediately so a slow request can't be
          // double-submitted by repeated clicks while the mutation is
          // pending. The card-level button busy state and the error
          // toast already provide adequate feedback.
          setConfirmOpen(false);
          upgradeMutation.mutate({ path: { id: assistant.id } });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
