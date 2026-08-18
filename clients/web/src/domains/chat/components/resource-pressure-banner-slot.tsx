/**
 * Resource-pressure banner slot. Owns the per-assistant localStorage-backed
 * dismiss / suppress flags and renders {@link ResourcePressureBanner} while
 * the monitor reports an elevated episode.
 *
 * Unlike the disk-pressure slot's episode-scoped dismiss, a plain dismiss
 * here starts a 7-day cooldown that also suppresses new elevated episodes.
 * Resource pressure recurs for busy-but-healthy workloads, so an
 * episode-scoped dismiss would nag; the timestamp cooldown is the anti-nag.
 * "Don't show again" persists permanently and is never auto-cleared.
 */

import { useCallback, useEffect, useState } from "react";

import { useNavigate } from "react-router";

import { ResourcePressureBanner } from "@/components/resource-pressure-banner";
import type { UseResourcePressureMonitorResult } from "@/assistant/use-resource-pressure-monitor";
import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
} from "@/utils/local-settings";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";

const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function readCooldownActive(dismissedUntilKey: string | null): boolean {
  if (!dismissedUntilKey) {
    return false;
  }
  return Date.now() < getLocalNumber(dismissedUntilKey, 0);
}

function readSuppressed(suppressedKey: string | null): boolean {
  if (!suppressedKey) {
    return false;
  }
  return getLocalBool(suppressedKey, false);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ResourcePressureBannerSlotProps {
  resourcePressure: UseResourcePressureMonitorResult;
  assistantId: string | null;
  /** `"active"` for platform-hosted assistants that have an upgrade path. */
  assistantStateKind: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResourcePressureBannerSlot({
  resourcePressure,
  assistantId,
  assistantStateKind,
}: ResourcePressureBannerSlotProps) {
  const navigate = useNavigate();
  const isNativeAndroid = useIsNativeAndroid();

  const dismissedUntilKey = assistantId
    ? `vellum:resourcePressureDismissedUntil:${assistantId}`
    : null;
  const suppressedKey = assistantId
    ? `vellum:resourcePressureSuppressed:${assistantId}`
    : null;

  // Evaluated lazily at mount; a cooldown that expires while the slot stays
  // mounted is picked up on the next mount, which is fine for a 7-day window.
  const [cooldownActive, setCooldownActive] = useState(() =>
    readCooldownActive(dismissedUntilKey),
  );
  const [suppressed, setSuppressed] = useState(() =>
    readSuppressed(suppressedKey),
  );

  // The slot stays mounted across assistant switches, and the first render
  // can happen before the assistant id resolves. Re-seed both flags from
  // storage whenever the keys change so one assistant's in-memory dismissal
  // never bleeds into the next and a late-resolving id picks up its stored
  // suppress / cooldown state. (`Date.now()` is impure, so the re-read lives
  // in an effect rather than in render.)
  useEffect(() => {
    setCooldownActive(readCooldownActive(dismissedUntilKey));
    setSuppressed(readSuppressed(suppressedKey));
  }, [dismissedUntilKey, suppressedKey]);

  const dismiss = useCallback(
    (permanent: boolean) => {
      if (permanent) {
        if (suppressedKey) {
          setLocalBool(suppressedKey, true);
        }
        setSuppressed(true);
        return;
      }
      if (dismissedUntilKey) {
        setLocalNumber(dismissedUntilKey, Date.now() + DISMISS_COOLDOWN_MS);
      }
      setCooldownActive(true);
    },
    [dismissedUntilKey, suppressedKey],
  );

  if (resourcePressure.mode !== "warning" || !resourcePressure.status) {
    return null;
  }
  if (suppressed || cooldownActive) {
    return null;
  }

  // The spacer lives with the banner, not around the slot: a wrapper on the
  // caller's side outlives every `return null` above and leaves an empty
  // element in the composer's banner stack, which reads there as a banner.
  return (
    <div className="mb-2">
      <ResourcePressureBanner
        status={resourcePressure.status}
        onDismiss={dismiss}
        onUpgrade={
          assistantStateKind === "active" && !isNativeAndroid
            ? () => void navigate(routes.plans)
            : null
        }
      />
    </div>
  );
}
