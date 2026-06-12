import { ArrowRight, Cpu, HardDrive, Loader2, Server } from "lucide-react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { extractResizeError } from "@/domains/settings/components/resize-errors";
import {
    assistantsActiveRetrieveOptions,
    organizationsBillingSubscriptionOnboardingRetrieveOptions,
    useAssistantsResizeMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import {
    allowedMachineSizesForTier,
    SIZE_DESCRIPTION,
    SIZE_LABEL,
} from "@/lib/billing/machine-sizes";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

export interface TierUpgradeResizeModalProps {
  open: boolean;
  onClose: () => void;
}

function ResourceCard({
  icon: Icon,
  label,
  from,
  to,
}: {
  icon: typeof Server;
  label: string;
  from: string;
  to: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: "color-mix(in oklab, var(--system-positive-strong) 10%, transparent)",
        }}
      >
        <Icon className="h-4 w-4 text-[var(--system-positive-strong)]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-label-small-default text-[var(--content-tertiary)]">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-label-medium-default text-[var(--content-tertiary)] line-through">
            {from}
          </span>
          <ArrowRight className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]" />
          <span className="text-label-medium-default text-[var(--content-default)]">
            {to}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TierUpgradeResizeModal({
  open,
  onClose,
}: TierUpgradeResizeModalProps) {
  const assistantQuery = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: open,
  });
  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: open,
  });

  const assistant = assistantQuery.data;
  const currentSize = (assistant?.machine_size as MachineSizeEnum) || "small";
  const currentGib = assistant?.provisioned_storage_gib ?? null;

  const maxTier = onboardingQuery.data?.max_machine_tier ?? null;
  const availableGib = onboardingQuery.data?.selected_storage_gib ?? null;
  const allowedSizes = allowedMachineSizesForTier(maxTier);

  const targetSize: MachineSizeEnum =
    allowedSizes.length > 0 ? allowedSizes[allowedSizes.length - 1] : currentSize;

  const machineChanged = targetSize !== currentSize;
  const canGrowStorage =
    availableGib != null && (currentGib == null || currentGib < availableGib);
  const hasChanges = machineChanged || canGrowStorage;

  const [resizeError, setResizeError] = useState<string | null>(null);

  const resizeMutation = useAssistantsResizeMutation({
    onSuccess: () => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setResizeError(null);
      onClose();
    },
    onError: (error) => {
      setResizeError(
        extractResizeError(
          error,
          "Failed to resize assistant. Please try again.",
        ),
      );
    },
  });

  const isLoading = resizeMutation.isPending;
  const dataLoading = assistantQuery.isLoading || onboardingQuery.isLoading;

  return (
    <Modal.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setResizeError(null);
          onClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title icon={Server}>Plan Updated</Modal.Title>
          <Modal.Description>
            Your new resources are ready. Apply them now to resize your assistant — it will briefly restart.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {dataLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : !hasChanges ? (
            <Notice tone="neutral">
              Your assistant is already running at the maximum size for your plan.
            </Notice>
          ) : (
            <div className="flex flex-col gap-2">
              {machineChanged && (
                <>
                  <ResourceCard
                    icon={Cpu}
                    label="Machine"
                    from={SIZE_LABEL[currentSize]}
                    to={SIZE_LABEL[targetSize]}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1 rounded-lg bg-[var(--surface-base)] px-3 py-2.5">
                      <span className="text-label-small-default text-[var(--content-tertiary)]">
                        CPU
                      </span>
                      <span className="text-label-medium-default text-[var(--content-default)]">
                        {SIZE_DESCRIPTION[targetSize].split(",")[0].trim()}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1 rounded-lg bg-[var(--surface-base)] px-3 py-2.5">
                      <span className="text-label-small-default text-[var(--content-tertiary)]">
                        Memory
                      </span>
                      <span className="text-label-medium-default text-[var(--content-default)]">
                        {SIZE_DESCRIPTION[targetSize].split(",")[1].trim()}
                      </span>
                    </div>
                  </div>
                </>
              )}
              {canGrowStorage && (
                <ResourceCard
                  icon={HardDrive}
                  label="Storage"
                  from={currentGib != null ? `${currentGib} GiB` : "—"}
                  to={`${availableGib} GiB`}
                />
              )}
            </div>
          )}
          {resizeError && (
            <div className="mt-3">
              <Notice tone="error">{resizeError}</Notice>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="ghost"
            onClick={() => {
              setResizeError(null);
              onClose();
            }}
          >
            Do Later
          </Button>
          <Button
            disabled={dataLoading || !hasChanges || isLoading || !assistant?.id}
            leftIcon={
              isLoading ? <Loader2 className="animate-spin" /> : undefined
            }
            onClick={() => {
              if (!assistant?.id) return;
              setResizeError(null);
              const body: { machine_size?: MachineSizeEnum; storage_gib?: number } = {};
              if (machineChanged) {
                body.machine_size = targetSize;
              }
              if (canGrowStorage && availableGib != null) {
                body.storage_gib = availableGib;
              }
              resizeMutation.mutate({
                path: { id: assistant.id },
                body,
              });
            }}
          >
            {resizeError ? "Retry" : "Apply & Restart"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
