import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import {
  assistantsProUpgradeMachineCreateMutation,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/domains/assistant/api.js";

export interface ComputeUpgradeCardProps {
  assistant: Assistant;
  refetch: () => Promise<void> | void;
}

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
          setConfirmOpen(false);
          upgradeMutation.mutate({ path: { id: assistant.id } });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
