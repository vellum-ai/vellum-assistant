import { useQuery } from "@tanstack/react-query";
import { HardDrive, Loader2, RefreshCw, Server, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Assistant } from "@/assistant/api";
import { DetailCard } from "@/components/detail-card";
import { formatResourceMb } from "@/domains/settings/components/assistant-status-panel";
import { CapacityBar } from "@/domains/settings/components/capacity-bar";
import { extractResizeError } from "@/domains/settings/components/resize-errors";
import {
    organizationsBillingSubscriptionOnboardingRetrieveOptions,
    organizationsBillingSubscriptionRetrieveOptions,
    useAssistantsResizeMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import {
    allowedMachineSizesForTier,
    buildMachineSizeOptions,
    machineSizeRank,
    SIZE_LABEL,
} from "@/lib/billing/machine-sizes";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

export interface ResizeCardProps {
  assistant: Assistant;
  healthz: HealthzGetResponse | null;
  healthzLoading: boolean;
  /** True while a post-resize poll is waiting for the new allocation to appear. */
  healthzPolling: boolean;
  refetch: () => Promise<void> | void;
  /** Poll /v1/health until the allocation changes from `baseline` after a resize. */
  refetchUntilResized: (
    baseline: HealthzGetResponse | null,
  ) => Promise<void> | void;
}

export function ResizeCard({
  assistant,
  healthz,
  healthzLoading,
  healthzPolling,
  refetch,
  refetchUntilResized,
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

  // `selected_storage_gib` is the provisioned storage quota the org has
  // purchased — the assistant's actual disk ceiling. The filesystem total
  // reported by /v1/health can over-report the underlying host volume, so it
  // is not a reliable limit.
  const availableGib = onboardingQuery.data?.selected_storage_gib ?? null;
  // The base assistant record doesn't expose its current provisioned storage,
  // and the filesystem total can over-report the host volume — gating on it
  // would wrongly hide the upgrade path when a user still has purchased quota.
  // Leave it unknown so the storage-grow path stays available; the resize
  // endpoint validates the requested size against the purchased tier.
  const currentGib: number | null = null;

  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const largestSize =
    allowedSizes.length > 0 ? allowedSizes[allowedSizes.length - 1] : null;
  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum | null>(
    null,
  );
  const displaySize = selectedSize ?? largestSize ?? currentSize;
  const [upgradeModalOpen, setUpgradeModalOpen] = useState<
    "storage" | "machine" | null
  >(null);
  const [resizeError, setResizeError] = useState<string | null>(null);

  const resizeMutation = useAssistantsResizeMutation({
    onSuccess: (_data, variables) => {
      toast.success("Resize started. Changes will apply shortly.", {
        id: "assistant-resize",
      });
      setResizeError(null);
      setSelectedSize(null);
      setResizeModalOpen(false);
      if (variables.body?.machine_size != null) {
        // A machine resize rolls the pod asynchronously, so a single immediate
        // refetch would just re-read the pre-resize CPU/memory. Poll against the
        // current allocation as a baseline until the new size lands.
        void refetchUntilResized(healthz);
      } else {
        // Storage-only resize: CPU/memory don't change (and the disk ceiling is
        // driven off the provisioned quota, not healthz), so the allocation poll
        // would never resolve. A single refresh is enough.
        void refetch();
      }
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
      <DetailCard
        id="storage-resources"
        title="Compute & Resources"
        subtitle="Monitor resource usage and manage your assistant's compute profile."
      >
        <Notice tone="error">
          Could not load your subscription. Please try again.
        </Notice>
      </DetailCard>
    );
  }

  const effectiveSelectedSize =
    isPro && allowedSizes.includes(displaySize) && displaySize !== currentSize
      ? displaySize
      : null;

  const canGrowStorage =
    isPro &&
    availableGib != null &&
    (currentGib == null || currentGib < availableGib);

  const canUpsize =
    isPro &&
    allowedSizes.length > 0 &&
    machineSizeRank(currentSize) <
      machineSizeRank(allowedSizes[allowedSizes.length - 1]);

  // Keep resize CTAs disabled while the post-resize poll is in flight so the
  // user can't kick off a second resize before the first lands.
  const isLoading = resizeMutation.isPending || healthzPolling;

  // Fall back to the filesystem total only when no quota is known (free plan).
  const diskMaxMb =
    availableGib != null
      ? availableGib * 1024
      : (healthz?.disk?.totalMb ?? null);

  const diskBar =
    healthz?.disk && diskMaxMb != null
      ? {
          value: healthz.disk.usedMb,
          max: diskMaxMb,
          caption: `${formatResourceMb(healthz.disk.usedMb)} of ${formatResourceMb(diskMaxMb)}`,
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
      <Button
        variant="ghost"
        size="compact"
        disabled={isLoading}
        onClick={() => setResizeModalOpen(true)}
      >
        Resize
      </Button>
    )
  ) : (
    <Button
      variant="ghost"
      size="compact"
      onClick={() => setUpgradeModalOpen("storage")}
    >
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
      <Button
        variant="ghost"
        size="compact"
        disabled={isLoading}
        onClick={() => setResizeModalOpen(true)}
      >
        Resize
      </Button>
    )
  ) : (
    <Button
      variant="ghost"
      size="compact"
      onClick={() => setUpgradeModalOpen("machine")}
    >
      Resize
    </Button>
  );

  return (
    <>
      <DetailCard
        id="storage-resources"
        title="Compute & Resources"
        subtitle="Monitor resource usage and manage your assistant's compute profile."
        compactAccessory
        accessory={
          <Button
            variant="ghost"
            size="compact"
            iconOnly={
              healthzLoading || healthzPolling ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )
            }
            tooltip={
              healthzPolling ? "Applying resize…" : "Refresh resource metrics"
            }
            aria-label="Refresh resource metrics"
            disabled={healthzLoading || healthzPolling}
            onClick={() => void refetch()}
          />
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr]">
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
              {diskBar ? (
                <CapacityBar
                  value={diskBar.value}
                  max={diskBar.max}
                  caption={diskBar.caption}
                />
              ) : healthzLoading ? (
                <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                </div>
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
                {cpuBar ? (
                  <CapacityBar
                    value={cpuBar.value}
                    max={cpuBar.max}
                    caption={cpuBar.caption}
                  />
                ) : healthzLoading ? (
                  <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </div>
                ) : (
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">
                    —
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-label-medium-default text-[var(--content-tertiary)]">
                  Memory
                </span>
                {memoryBar ? (
                  <CapacityBar
                    value={memoryBar.value}
                    max={memoryBar.max}
                    caption={memoryBar.caption}
                  />
                ) : healthzLoading ? (
                  <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </div>
                ) : (
                  <span className="text-label-medium-default text-[var(--content-tertiary)]">
                    —
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </DetailCard>

      {/* Upgrade modal (free plan) */}
      <Modal.Root
        open={upgradeModalOpen != null}
        onOpenChange={(o) => {
          if (!o) setUpgradeModalOpen(null);
        }}
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
              Resize your assistant's compute and storage. Your assistant will
              briefly restart.
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              {allowedSizes.length === 0 ? (
                <Notice tone="warning">
                  No machine tier configured. Visit the community for help.
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
                  Storage is already at its provisioned size ({currentGib} GiB)
                  and will not change.
                </Notice>
              ) : (
                <Notice tone="neutral">Storage will not change.</Notice>
              )}
              {resizeError && <Notice tone="error">{resizeError}</Notice>}
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
                disabled={
                  (effectiveSelectedSize == null && !canGrowStorage) ||
                  isLoading
                }
                leftIcon={
                  isLoading ? <Loader2 className="animate-spin" /> : undefined
                }
                onClick={() => {
                  setResizeError(null);
                  const body: {
                    machine_size?: MachineSizeEnum;
                    storage_gib?: number;
                  } = {};
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
