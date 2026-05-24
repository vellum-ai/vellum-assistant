import { useMutation, useQuery } from "@tanstack/react-query";
import { HardDrive, Loader2, RefreshCw, Server, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

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
  const currentGib = assistant.provisioned_storage_gib ?? null;

  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const largestSize = allowedSizes.length > 0 ? allowedSizes[allowedSizes.length - 1] : null;
  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum | null>(
    null,
  );
  const displaySize = selectedSize ?? largestSize ?? currentSize;
  const [upgradeModalOpen, setUpgradeModalOpen] = useState<"storage" | "machine" | null>(null);
  const [resizeError, setResizeError] = useState<string | null>(null);

  const resizeMutation = useMutation({
    ...assistantsResizeMutation(),
    onSuccess: () => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setResizeError(null);
      setSelectedSize(null);
      setResizeModalOpen(false);
      void refetch();
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
    isPro &&
    allowedSizes.includes(displaySize) &&
    displaySize !== currentSize
      ? displaySize
      : null;

  const canGrowStorage =
    isPro && availableGib != null && (currentGib == null || currentGib < availableGib);

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
        onClick={() => setResizeModalOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-body-small-default font-medium text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Increase Storage
      </button>
    ) : (
      <Button variant="ghost" size="compact" disabled={isLoading} onClick={() => setResizeModalOpen(true)}>
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

      {/* Resize modal (pro plan) — machine + storage in one */}
      <Modal.Root
        open={resizeModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setResizeModalOpen(false);
            setSelectedSize(null);
            setResizeError(null);
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title icon={Server}>Resize Assistant</Modal.Title>
            <Modal.Description>
              Resize your assistant's compute and storage. Your assistant will briefly restart.
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
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
                    data-testid="resize-machine-size"
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
          </Modal.Body>
          <Modal.Footer className="items-center justify-between">
            <span className="text-label-small-default text-[var(--content-tertiary)]">
              Need more?{" "}
              <Link
                to={`${routes.settings.billing}?adjust_plan=1`}
                className="text-[var(--content-secondary)] underline decoration-[var(--border-element)] underline-offset-2 transition-colors hover:text-[var(--content-default)]"
                onClick={() => setResizeModalOpen(false)}
              >
                Upgrade plan
              </Link>
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setResizeModalOpen(false);
                  setSelectedSize(null);
                  setResizeError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={(effectiveSelectedSize == null && !canGrowStorage) || isLoading}
                leftIcon={
                  isLoading ? <Loader2 className="animate-spin" /> : undefined
                }
                onClick={() => {
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
            </div>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
