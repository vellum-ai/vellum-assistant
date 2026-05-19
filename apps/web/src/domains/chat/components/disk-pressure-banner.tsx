
import { HardDrive } from "lucide-react";

import { Button } from "@vellum/design-library";
import { Notice } from "@vellum/design-library";
import type { DiskPressureStatus } from "@/domains/assistant/api.js";
import { formatDiskPressureUsage } from "@/domains/assistant/disk-pressure.js";

export type DiskPressureBannerMode = "acknowledgement-required" | "cleanup";

export interface DiskPressureBannerProps {
  status: DiskPressureStatus;
  mode: DiskPressureBannerMode;
  isAcknowledging?: boolean;
  acknowledgeError?: string | null;
  onAcknowledge: () => void;
  onReviewDiskUsage: () => void;
}

export function DiskPressureBanner(props: DiskPressureBannerProps) {
  const {
    status,
    mode,
    isAcknowledging = false,
    acknowledgeError,
    onAcknowledge,
    onReviewDiskUsage,
  } = props;
  const formattedUsage = formatDiskPressureUsage(status);
  const usagePrefix =
    formattedUsage === "Unknown" ? null : `Current usage: ${formattedUsage}. `;

  if (mode === "cleanup") {
    return (
      <Notice
        tone="warning"
        title="Cleanup mode is active"
        icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
        actions={
          <Button
            variant="outlined"
            size="regular"
            onClick={onReviewDiskUsage}
          >
            Review storage
          </Button>
        }
        className="p-4"
        data-testid="disk-pressure-banner"
      >
        {usagePrefix}
        Background processes and trusted-contact messages remain blocked until
        storage is freed.
      </Notice>
    );
  }

  return (
    <Notice
      tone="error"
      title="Storage is critically low"
      icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
      actions={
        <>
          <Button
            variant="primary"
            size="regular"
            disabled={isAcknowledging}
            onClick={onAcknowledge}
          >
            {isAcknowledging ? "Acknowledging..." : "Acknowledge and clean up"}
          </Button>
          <Button
            variant="outlined"
            size="regular"
            onClick={onReviewDiskUsage}
          >
            Review storage
          </Button>
        </>
      }
      className="p-4"
      data-testid="disk-pressure-banner"
    >
      <span>
        {usagePrefix}
        Background processes and trusted-contact messages are blocked until
        storage is freed. Acknowledge to continue with cleanup tools.
      </span>
      {acknowledgeError ? (
        <span
          className="mt-2 block text-[var(--system-negative-strong)]"
          role="alert"
        >
          {acknowledgeError}
        </span>
      ) : null}
    </Notice>
  );
}
