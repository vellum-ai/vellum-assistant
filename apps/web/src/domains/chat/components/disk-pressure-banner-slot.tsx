/**
 * Disk-pressure banner slot — owns per-assistant localStorage-backed
 * dismiss / suppress flags and renders the appropriate {@link DiskPressureBanner}
 * variant based on the current monitor status.
 *
 * The "dismissed" flag clears automatically when the disk-pressure state
 * transitions away from `"warning"`, while the "suppressed" flag
 * ("Don't show again") persists across state transitions.
 */

import { useCallback, useEffect, useState } from "react";

import { useNavigate } from "react-router";

import { DiskPressureBanner, type DiskPressureBannerMode } from "@/components/disk-pressure-banner";
import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import { getLocalBool, removeLocalSetting, setLocalBool } from "@/utils/local-settings";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DiskPressureBannerSlotProps {
  diskPressure: UseDiskPressureMonitorResult;
  assistantId: string | null;
  /** `"active"` for platform-hosted assistants that have an upgrade path. */
  assistantStateKind: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DiskPressureBannerSlot({
  diskPressure,
  assistantId,
  assistantStateKind,
}: DiskPressureBannerSlotProps) {
  const navigate = useNavigate();

  const dismissedKey = assistantId
    ? `vellum:diskPressureDismissed:${assistantId}`
    : null;
  const suppressedKey = assistantId
    ? `vellum:diskPressureSuppressed:${assistantId}`
    : null;

  const [warningDismissed, setWarningDismissed] = useState(() => {
    if (!dismissedKey) return false;
    return getLocalBool(dismissedKey, false);
  });
  const [warningSuppressed, setWarningSuppressed] = useState(() => {
    if (!suppressedKey) return false;
    return getLocalBool(suppressedKey, false);
  });

  const dismissWarning = useCallback(
    (permanent: boolean) => {
      if (permanent) {
        if (suppressedKey) {
          setLocalBool(suppressedKey, true);
        }
        setWarningSuppressed(true);
        return;
      }
      if (dismissedKey) {
        setLocalBool(dismissedKey, true);
      }
      setWarningDismissed(true);
    },
    [dismissedKey, suppressedKey],
  );

  // Clear the per-episode dismiss on state change; the suppressed flag is
  // intentionally not cleared here so "Don't show again" actually sticks.
  useEffect(() => {
    const st = diskPressure.status?.state;
    if (st && st !== "warning" && warningDismissed) {
      if (dismissedKey) {
        removeLocalSetting(dismissedKey);
      }
      setWarningDismissed(false);
    }
  }, [diskPressure.status?.state, warningDismissed, dismissedKey]);

  if (!diskPressure.status) return null;
  const mode = diskPressure.mode === "inactive" ? null : (diskPressure.mode as DiskPressureBannerMode | null);
  if (!mode) return null;
  if (mode === "warning" && (warningDismissed || warningSuppressed)) return null;

  return (
    <DiskPressureBanner
      status={diskPressure.status}
      mode={mode}
      isAcknowledging={diskPressure.isAcknowledging}
      acknowledgeError={diskPressure.acknowledgeError?.message ?? null}
      onAcknowledge={() => void diskPressure.acknowledge()}
      onDismissWarning={dismissWarning}
      onReviewWorkspaceData={() => void navigate(`${routes.workspace}?sort=size`)}
      onUpgradeStorage={assistantStateKind === "active" ? () => void navigate(`${routes.settings.billing}?adjust_plan=1`) : null}
    />
  );
}
