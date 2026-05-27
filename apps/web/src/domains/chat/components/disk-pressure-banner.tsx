
import { useState } from "react";
import { AlertTriangle, HardDrive } from "lucide-react";

import { Button, Modal } from "@vellum/design-library";
import { Notice } from "@vellum/design-library";
import type { DiskPressureStatus } from "@/assistant/api";
import { formatDiskPressureUsage } from "@/assistant/disk-pressure";

export type DiskPressureBannerMode = "warning" | "acknowledgement-required" | "cleanup";

export interface DiskPressureBannerProps {
  status: DiskPressureStatus;
  mode: DiskPressureBannerMode;
  isAcknowledging?: boolean;
  acknowledgeError?: string | null;
  onAcknowledge: () => void;
  onDismissWarning?: () => void;
  onReviewWorkspaceData?: () => void;
  onUpgradeStorage?: (() => void) | null;
}

export function DiskPressureBanner(props: DiskPressureBannerProps) {
  const {
    status,
    mode,
    isAcknowledging = false,
    acknowledgeError,
    onAcknowledge,
    onDismissWarning,
    onReviewWorkspaceData,
    onUpgradeStorage,
  } = props;
  const [showAcknowledgeModal, setShowAcknowledgeModal] = useState(false);
  const formattedUsage = formatDiskPressureUsage(status);

  if (mode === "warning") {
    const usagePercent = status.usagePercent ?? 0;

    return (
      <Notice
        tone="warning"
        title="Storage is running low"
        icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        onDismiss={onDismissWarning}
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${usagePercent}%`,
                  backgroundColor: "var(--system-mid-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-mid-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">
            Your assistant will enter a locked state if it runs out of storage.
          </p>
          <div className="flex flex-wrap gap-2">
            {onReviewWorkspaceData && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onReviewWorkspaceData}
              >
                Review Workspace Data
              </Button>
            )}
            {onUpgradeStorage && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onUpgradeStorage}
              >
                Upgrade Storage
              </Button>
            )}
          </div>
        </div>
      </Notice>
    );
  }

  if (mode === "cleanup") {
    const cleanupPercent = status.usagePercent ?? 0;

    return (
      <Notice
        tone="warning"
        title="Cleanup mode is active"
        icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${cleanupPercent}%`,
                  backgroundColor: "var(--system-mid-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-mid-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">
            Prompt your assistant to free up space before it runs out and enters a locked state.
          </p>
          <div className="flex flex-wrap gap-2">
            {onReviewWorkspaceData && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onReviewWorkspaceData}
              >
                Review Workspace Data
              </Button>
            )}
            {onUpgradeStorage && (
              <Button
                variant="outlined"
                size="compact"
                onClick={onUpgradeStorage}
              >
                Upgrade Storage
              </Button>
            )}
          </div>
        </div>
      </Notice>
    );
  }

  const criticalPercent = status.usagePercent ?? 0;

  return (
    <>
      <Notice
        tone="error"
        title="Storage is critically low"
        icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${criticalPercent}%`,
                  backgroundColor: "var(--system-negative-strong)",
                }}
              />
            </div>
            <span className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-negative-strong)]">
              {formattedUsage}
            </span>
          </div>
          <p className="m-0">
            Your assistant will enter a locked state if it runs out of storage.
          </p>
          {acknowledgeError ? (
            <span
              className="text-[var(--system-negative-strong)]"
              role="alert"
            >
              {acknowledgeError}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="compact"
              onClick={() => setShowAcknowledgeModal(true)}
            >
              Review
            </Button>
          </div>
        </div>
      </Notice>

      <Modal.Root
        open={showAcknowledgeModal}
        onOpenChange={(open) => {
          if (!open) setShowAcknowledgeModal(false);
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title icon={AlertTriangle}>
              Storage is critically low
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Modal.Description>
              Your assistant will enter a locked state if it runs out of
              storage. You should either prompt your assistant to free up space
              or increase your storage.
            </Modal.Description>
          </Modal.Body>
          <Modal.Footer>
            {onUpgradeStorage && (
              <Button
                variant="outlined"
                onClick={() => {
                  setShowAcknowledgeModal(false);
                  onUpgradeStorage();
                }}
              >
                Upgrade Storage
              </Button>
            )}
            <Button
              variant="primary"
              disabled={isAcknowledging}
              onClick={() => {
                onAcknowledge();
                setShowAcknowledgeModal(false);
              }}
            >
              {isAcknowledging ? "Acknowledging..." : "Acknowledge"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
