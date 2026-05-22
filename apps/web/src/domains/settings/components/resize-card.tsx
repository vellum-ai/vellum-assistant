import { useMutation, useQuery } from "@tanstack/react-query";
import { HardDrive, Loader2, RefreshCw, Server, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import { CapacityBar } from "@/domains/settings/components/capacity-bar.js";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { extractResizeError } from "@/domains/settings/components/resize-errors.js";
import { formatResourceMb } from "@/domains/settings/components/assistant-status-panel.js";
import {
  assistantsResizeMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { MachineSizeEnum } from "@/generated/api/types.gen.js";
import type { Assistant, AssistantHealthz } from "@/assistant/api.js";
import {
  allowedMachineSizesForTier,
  buildMachineSizeOptions,
  machineSizeRank,
  SIZE_LABEL,
} from "@/lib/billing/machine-sizes.js";
import { routes } from "@/utils/routes.js";

export interface ResizeCardProps {
  assistant: Assistant;
  healthz: AssistantHealthz | null;
  healthzLoading: boolean;
  refetch: () => Promise<void> | void;
}

export function ResizeCard({
  assistant,
  healthz,
  healthzLoading,
  refetch,
}: ResizeCardProps) {
  const navigate = useNavigate();
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const subscription = subscriptionQuery.data;
  const isPlatform = !assistant.is_local;
  const isPro = subscription?.plan_id === "pro";

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isPro,
  });

  const currentSize: MachineSizeEnum =
    (assistant.machine_size as MachineSizeEnum) || "small";

  const maxMachineTier = onboardingQuery.data?.max_machine_tier ?? null;
  const allowedSizes = allowedMachineSizesForTier(maxMachineTier);

  const machineSizeOptions = useMemo(
    () =>
      buildMachineSizeOptions(
        allowedSizes,
        currentSize,
        <Tag tone="positive">Current</Tag>,
      ),
    [allowedSizes, currentSize],
  );

  const availableGib = onboardingQuery.data?.selected_storage_gib ?? null;
  const currentGib =
    healthz?.disk != null ? Math.round(healthz.disk.totalMb / 1024) : null;

  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum | null>(
    null,
  );
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState<"storage" | "machine" | null>(null);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setSelectedSize(null);
      setResizeModalOpen(false);
      setStorageModalOpen(false);
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

  if (subscriptionQuery.isError && subscription == null) {
    return (
      <SettingsCard
        id="storage-resources"
        title="Compute & Resources"
        subtitle="Monitor resource usage and manage your assistant's compute profile."
      >
        <Notice tone="error">
          Could not load your subscription. Please try again.
        </Notice>
      </SettingsCard>
    );
  }

  const effectiveSelectedSize =
    isPro && selectedSize &&
    allowedSizes.includes(selectedSize) &&
    selectedSize !== currentSize
      ? selectedSize
      : null;

  const canGrowStorage =
    isPro && availableGib != null && currentGib != null && currentGib < availableGib;

  const canUpsize =
    isPro &&
    allowedSizes.length > 0 &&
    machineSizeRank(currentSize) < machineSizeRank(allowedSizes[allowedSizes.length - 1]);

  const isLoading = resizeMutation.isPending;

  const diskBar = healthz?.disk
    ? {
        value: healthz.disk.usedMb,
        max: healthz.disk.totalMb,
        caption: `${formatResourceMb(healthz.disk.usedMb)} of ${formatResourceMb(healthz.disk.totalMb)}`,
      }
    : null;

  const cpuBar = healthz?.cpu
    ? {
        value: healthz.cpu.currentPercent,
        max: 100,
        caption: `${healthz.cpu.currentPercent.toFixed(1)}%`,
      }
    : null;

  const memoryBar = healthz?.memory
    ? {
        value: healthz.memory.currentMb,
        max: healthz.memory.maxMb,
        caption: `${formatResourceMb(healthz.memory.currentMb)} of ${formatResourceMb(healthz.memory.maxMb)}`,
      }
    : null;

  const diskAction = !isPlatform ? null : isPro ? (
    canGrowStorage ? (
      <button
        type="button"
        disabled={isLoading}
        onClick={() => setStorageModalOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-body-small-default font-medium text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Increase Storage
      </button>
    ) : (
      <Button variant="ghost" size="compact" disabled={isLoading} onClick={() => setStorageModalOpen(true)}>
        Resize
      </Button>
    )
  ) : (
    <Button variant="ghost" size="compact" onClick={() => setUpgradeModalOpen("storage")}>
      Resize
    </Button>
  );

  const machineAction = !isPlatform ? null : isPro ? (
    canUpsize ? (
      <button
        type="button"
        disabled={isLoading}
        onClick={() => setResizeModalOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-body-small-default font-medium text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Increase Size
      </button>
    ) : (
      <Button variant="ghost" size="compact" disabled={isLoading} onClick={() => setResizeModalOpen(true)}>
        Resize
      </Button>
    )
  ) : (
    <Button variant="ghost" size="compact" onClick={() => setUpgradeModalOpen("machine")}>
      Resize
    </Button>
  );

  return (
    <>
      <SettingsCard
        id="storage-resources"
        title="Compute & Resources"
        subtitle="Monitor resource usage and manage your assistant's compute profile."
        compactAccessory
        accessory={
          <Button
            variant="ghost"
            size="compact"
            iconOnly={
              healthzLoading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )
            }
            tooltip="Refresh resource metrics"
            aria-label="Refresh resource metrics"
            disabled={healthzLoading}
            onClick={() => void refetch()}
          />
        }
      >
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          {/* Disk tile */}
          <div className="flex flex-col rounded-lg bg-[var(--surface-base)] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--content-tertiary)]">
                  <HardDrive className="h-3.5 w-3.5" />
                </span>
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  Disk
                </span>
              </div>
              {diskAction}
            </div>
            <div className="mt-auto flex flex-col gap-1 pt-3">
              <span className="text-label-medium-default text-[var(--content-tertiary)]">
                Storage
              </span>
              {healthzLoading ? (
                <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                </div>
              ) : diskBar ? (
                <CapacityBar
                  value={diskBar.value}
                  max={diskBar.max}
                  caption={diskBar.caption}
                />
              ) : (
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  Unavailable
                </span>
              )}
            </div>
          </div>

          {/* Machine tile (CPU + Memory) */}
          <div className="flex flex-col rounded-lg bg-[var(--surface-base)] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--content-tertiary)]">
                  <Server className="h-3.5 w-3.5" />
                </span>
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  Machine
                </span>
                <Tag tone="neutral">{SIZE_LABEL[currentSize]}</Tag>
              </div>
              {machineAction}
            </div>
            <div className="mt-auto grid grid-cols-2 gap-3 pt-3">
              <div className="flex flex-col gap-1">
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  CPU
                </span>
                {healthzLoading ? (
                  <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </div>
                ) : cpuBar ? (
                  <CapacityBar
                    value={cpuBar.value}
                    max={cpuBar.max}
                    caption={cpuBar.caption}
                  />
                ) : (
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">—</span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  Memory
                </span>
                {healthzLoading ? (
                  <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </div>
                ) : memoryBar ? (
                  <CapacityBar
                    value={memoryBar.value}
                    max={memoryBar.max}
                    caption={memoryBar.caption}
                  />
                ) : (
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">—</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* Upgrade modal (free plan) */}
      <Modal.Root
        open={upgradeModalOpen != null}
        onOpenChange={(o) => { if (!o) setUpgradeModalOpen(null); }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title>Upgrade to Pro</Modal.Title>
            <Modal.Description>
              {upgradeModalOpen === "storage"
                ? "Upgrade to the Pro plan to increase your storage allocation and get more space for your assistant."
                : "Upgrade to the Pro plan to unlock larger machine sizes with more CPU and memory for your assistant."}
            </Modal.Description>
          </Modal.Header>
          <Modal.Footer>
            <Button variant="ghost" onClick={() => setUpgradeModalOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setUpgradeModalOpen(null);
                void navigate(`${routes.settings.billing}?adjust_plan=1`);
              }}
            >
              Upgrade
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>

      {/* Resize machine modal (pro plan) */}
      <Modal.Root
        open={resizeModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setResizeModalOpen(false);
            setSelectedSize(null);
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title>Resize Machine</Modal.Title>
            <Modal.Description>
              Larger machine sizes are already included in your plan. Select a
              size to resize to — your assistant will briefly restart.
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            {allowedSizes.length === 0 ? (
              <Notice tone="warning">
                No machine tier configured. Contact support.
              </Notice>
            ) : (
              <Dropdown
                options={machineSizeOptions}
                value={selectedSize ?? currentSize}
                onChange={setSelectedSize}
                aria-label="Compute machine size"
                data-testid="resize-machine-size"
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              onClick={() => {
                setResizeModalOpen(false);
                setSelectedSize(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={effectiveSelectedSize == null || isLoading}
              leftIcon={
                isLoading ? <Loader2 className="animate-spin" /> : undefined
              }
              onClick={() => {
                if (effectiveSelectedSize == null) return;
                resizeMutation.mutate({
                  path: { id: assistant.id },
                  body: { machine_size: effectiveSelectedSize },
                });
              }}
            >
              Apply
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>

      {/* Resize storage modal (pro plan) */}
      <Modal.Root
        open={storageModalOpen}
        onOpenChange={(o) => { if (!o) setStorageModalOpen(false); }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title>Resize Storage</Modal.Title>
            <Modal.Description>
              Your plan includes up to {availableGib} GiB of storage.
              This will expand your disk from {currentGib ?? "?"} GiB
              to {availableGib} GiB — your assistant will briefly restart.
            </Modal.Description>
          </Modal.Header>
          <Modal.Footer>
            <Button
              variant="ghost"
              onClick={() => setStorageModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isLoading}
              leftIcon={
                isLoading ? <Loader2 className="animate-spin" /> : undefined
              }
              onClick={() => {
                if (availableGib == null) return;
                resizeMutation.mutate({
                  path: { id: assistant.id },
                  body: { storage_gib: availableGib },
                });
                setStorageModalOpen(false);
              }}
            >
              Apply
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
