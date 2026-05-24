import { Loader2, Server } from "lucide-react";
import { useMemo, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import { extractResizeError } from "@/domains/settings/components/resize-errors.js";
import {
  assistantsActiveRetrieveOptions,
  assistantsResizeMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { MachineSizeEnum } from "@/generated/api/types.gen.js";
import {
  allowedMachineSizesForTier,
  buildMachineSizeOptions,
} from "@/lib/billing/machine-sizes.js";

export interface TierUpgradeResizeModalProps {
  open: boolean;
  onClose: () => void;
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

  const largestSize = allowedSizes.length > 0 ? allowedSizes[allowedSizes.length - 1] : null;
  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum | null>(null);
  const displaySize = selectedSize ?? largestSize ?? currentSize;
  const [resizeError, setResizeError] = useState<string | null>(null);

  const machineSizeOptions = useMemo(
    () =>
      buildMachineSizeOptions(
        allowedSizes,
        currentSize,
        <Tag tone="positive">Current</Tag>,
      ),
    [allowedSizes, currentSize],
  );

  const effectiveSelectedSize =
    allowedSizes.includes(displaySize) && displaySize !== currentSize
      ? displaySize
      : null;

  const canGrowStorage =
    availableGib != null && (currentGib == null || currentGib < availableGib);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setResizeError(null);
      setSelectedSize(null);
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
          setSelectedSize(null);
          setResizeError(null);
          onClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title icon={Server}>Plan Updated</Modal.Title>
          <Modal.Description>
            Your plan has been updated with new resources. Apply them now to resize your assistant — it will briefly restart.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {dataLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {allowedSizes.length === 0 ? (
                <Notice tone="warning">
                  No machine tier configured. Contact support.
                </Notice>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label-medium-default text-[var(--content-secondary)]">
                    Machine Size
                  </span>
                  <Dropdown
                    options={machineSizeOptions}
                    value={displaySize}
                    onChange={setSelectedSize}
                    aria-label="Compute machine size"
                    data-testid="portal-resize-machine-size"
                  />
                </div>
              )}
              {canGrowStorage ? (
                <Notice tone="info">
                  {currentGib != null
                    ? `Storage will be expanded from ${currentGib} GiB to ${availableGib} GiB.`
                    : `Storage will be expanded to ${availableGib} GiB.`}
                </Notice>
              ) : currentGib != null ? (
                <Notice tone="neutral">
                  Storage is already at its provisioned size ({currentGib} GiB) and will not change.
                </Notice>
              ) : (
                <Notice tone="neutral">
                  Storage will not change.
                </Notice>
              )}
              {resizeError && (
                <Notice tone="error">{resizeError}</Notice>
              )}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedSize(null);
              setResizeError(null);
              onClose();
            }}
          >
            Do Later
          </Button>
          <Button
            disabled={
              dataLoading ||
              (effectiveSelectedSize == null && !canGrowStorage) ||
              isLoading ||
              !assistant?.id
            }
            leftIcon={
              isLoading ? <Loader2 className="animate-spin" /> : undefined
            }
            onClick={() => {
              if (!assistant?.id) return;
              setResizeError(null);
              const body: { machine_size?: MachineSizeEnum; storage_gib?: number } = {};
              if (effectiveSelectedSize != null) {
                body.machine_size = effectiveSelectedSize;
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
            {resizeError ? "Retry" : "Apply"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
