/**
 * Disk-pressure banner slot — owns per-assistant localStorage-backed
 * dismiss / suppress flags and renders the appropriate {@link DiskPressureBanner}
 * variant based on the current monitor status.
 *
 * The "dismissed" flag clears automatically when the disk-pressure state
 * transitions away from `"warning"`, while the "suppressed" flag
 * ("Don't show again") persists across state transitions.
 *
 * The dismissal logic lives in {@link useDiskPressureBannerVisibility} so
 * callers that need to know whether the banner actually renders (e.g. the
 * chat route's banner precedence gate) share the exact rules the slot uses
 * instead of re-deriving them from the raw monitor mode.
 */

import { useCallback, useEffect, useState } from "react";

import { useNavigate } from "react-router";

import {
  DiskPressureBanner,
  type DiskPressureBannerMode,
} from "@/components/disk-pressure-banner";
import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import {
  getLocalBool,
  removeLocalSetting,
  setLocalBool,
  watchSetting,
} from "@/utils/local-settings";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Shared visibility hook
// ---------------------------------------------------------------------------

interface DiskPressureBannerVisibility {
  /** Banner mode the slot renders, or null when the slot renders nothing. */
  visibleMode: DiskPressureBannerMode | null;
  /** Dismisses the warning banner; `permanent` maps to "Don't show again". */
  dismissWarning: (permanent: boolean) => void;
}

function readFlag(key: string | null): boolean {
  if (!key) {
    return false;
  }
  return getLocalBool(key, false);
}

/**
 * Single source of truth for whether the disk-pressure banner is visible.
 *
 * Encapsulates the monitor mode plus the per-assistant localStorage-backed
 * dismiss / suppress flags. The slot consumes this hook to decide what to
 * render, and callers gating other banners on disk precedence consume it to
 * learn whether the slot actually renders, so the two can never drift.
 *
 * Multiple hook instances stay in sync through {@link watchSetting}: a
 * dismissal written by the slot's instance notifies every other mounted
 * instance (same-tab via the pref-changed event, cross-tab via `storage`).
 */
export function useDiskPressureBannerVisibility(
  diskPressure: UseDiskPressureMonitorResult,
  assistantId: string | null,
): DiskPressureBannerVisibility {
  const dismissedKey = assistantId
    ? `vellum:diskPressureDismissed:${assistantId}`
    : null;
  const suppressedKey = assistantId
    ? `vellum:diskPressureSuppressed:${assistantId}`
    : null;

  const [warningDismissed, setWarningDismissed] = useState(() =>
    readFlag(dismissedKey),
  );
  const [warningSuppressed, setWarningSuppressed] = useState(() =>
    readFlag(suppressedKey),
  );

  // Re-seed on key change (assistant switch, late-resolving id) and follow
  // writes made by other instances of this hook.
  useEffect(() => {
    setWarningDismissed(readFlag(dismissedKey));
    if (!dismissedKey) {
      return;
    }
    return watchSetting(dismissedKey, () => {
      setWarningDismissed(readFlag(dismissedKey));
    });
  }, [dismissedKey]);
  useEffect(() => {
    setWarningSuppressed(readFlag(suppressedKey));
    if (!suppressedKey) {
      return;
    }
    return watchSetting(suppressedKey, () => {
      setWarningSuppressed(readFlag(suppressedKey));
    });
  }, [suppressedKey]);

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

  const mode =
    !diskPressure.status || diskPressure.mode === "inactive"
      ? null
      : (diskPressure.mode as DiskPressureBannerMode);
  // Only the warning variant is dismissible; acknowledgement-required and
  // cleanup always render while their mode is active.
  const visibleMode =
    mode === "warning" && (warningDismissed || warningSuppressed)
      ? null
      : mode;

  return { visibleMode, dismissWarning };
}

/**
 * Whether {@link DiskPressureBannerSlot} currently renders a banner.
 *
 * For callers that only need the boolean (e.g. to yield another banner's
 * space while the disk banner is on screen).
 */
export function useDiskPressureBannerVisible(
  diskPressure: UseDiskPressureMonitorResult,
  assistantId: string | null,
): boolean {
  return (
    useDiskPressureBannerVisibility(diskPressure, assistantId).visibleMode !==
    null
  );
}

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
  const isNativeAndroid = useIsNativeAndroid();

  const { visibleMode, dismissWarning } = useDiskPressureBannerVisibility(
    diskPressure,
    assistantId,
  );

  if (!diskPressure.status || !visibleMode) {
    return null;
  }

  // The spacer lives with the banner, not around the slot: a wrapper on the
  // caller's side outlives every `return null` above and leaves an empty
  // element in the composer's banner stack, which reads there as a banner.
  return (
    <div className="mb-2">
      <DiskPressureBanner
        status={diskPressure.status}
        mode={visibleMode}
        isAcknowledging={diskPressure.isAcknowledging}
        acknowledgeError={diskPressure.acknowledgeError?.message ?? null}
        onAcknowledge={() => void diskPressure.acknowledge()}
        onDismissWarning={dismissWarning}
        onReviewWorkspaceData={() =>
          void navigate(`${routes.workspace}?sort=size`)
        }
        onUpgradeStorage={
          assistantStateKind === "active" && !isNativeAndroid
            ? () => void navigate(routes.plans)
            : null
        }
      />
    </div>
  );
}
