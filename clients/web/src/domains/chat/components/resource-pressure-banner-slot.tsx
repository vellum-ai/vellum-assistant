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

import { useCallback, useEffect, useRef, useState } from "react";

import { useNavigate } from "react-router";

import { ResourcePressureBanner } from "@/components/resource-pressure-banner";
import type { UseResourcePressureMonitorResult } from "@/assistant/use-resource-pressure-monitor";
import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
  watchSetting,
} from "@/utils/local-settings";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";

const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// setTimeout treats delays above 2^31 - 1 ms as 0; longer waits re-arm in
// chunks of at most this much.
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

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
  /**
   * Render nothing while true (disk-pressure precedence). The slot stays
   * MOUNTED so its in-memory dismissal fallback (used when storage writes
   * fail) survives the disk episode; unmounting would discard it and let a
   * dismissed banner reappear once the disk banner clears.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResourcePressureBannerSlot({
  resourcePressure,
  assistantId,
  assistantStateKind,
  hidden = false,
}: ResourcePressureBannerSlotProps) {
  const navigate = useNavigate();
  const isNativeAndroid = useIsNativeAndroid();

  const dismissedUntilKey = assistantId
    ? `vellum:resourcePressureDismissedUntil:${assistantId}`
    : null;
  const suppressedKey = assistantId
    ? `vellum:resourcePressureSuppressed:${assistantId}`
    : null;

  // Seeded lazily at mount; the expiry effect below re-arms a timer for the
  // stored deadline so a cooldown that lapses while the slot stays mounted
  // re-enables the banner without a remount.
  const [cooldownActive, setCooldownActive] = useState(() =>
    readCooldownActive(dismissedUntilKey),
  );
  const [suppressed, setSuppressed] = useState(() =>
    readSuppressed(suppressedKey),
  );

  // In-memory fallback for the cooldown deadline. `setLocalNumber` swallows
  // storage failures (private browsing, quota), and treating the missing
  // stored value as an expired cooldown would resurface the banner right
  // after a dismiss. The ref keeps the dismissal honored while mounted.
  const inMemoryDeadlineRef = useRef(0);

  // The slot stays mounted across assistant switches, and the first render
  // can happen before the assistant id resolves. Re-seed both flags from
  // storage whenever the keys change so one assistant's in-memory dismissal
  // never bleeds into the next and a late-resolving id picks up its stored
  // suppress / cooldown state. (`Date.now()` is impure, so the re-read lives
  // in an effect rather than in render.)
  useEffect(() => {
    inMemoryDeadlineRef.current = 0;
    setCooldownActive(readCooldownActive(dismissedUntilKey));
    setSuppressed(readSuppressed(suppressedKey));
  }, [dismissedUntilKey, suppressedKey]);

  // A dismissal written by another mounted surface (second tab or window on
  // the same assistant) must reach this instance too, so subscribe to both
  // keys the same way the disk-pressure visibility hook does (same-tab via
  // the pref-changed event, cross-tab via `storage`).
  useEffect(() => {
    if (!dismissedUntilKey) {
      return;
    }
    return watchSetting(dismissedUntilKey, () => {
      setCooldownActive(readCooldownActive(dismissedUntilKey));
    });
  }, [dismissedUntilKey]);

  useEffect(() => {
    if (!suppressedKey) {
      return;
    }
    return watchSetting(suppressedKey, () => {
      setSuppressed(readSuppressed(suppressedKey));
    });
  }, [suppressedKey]);

  // While a cooldown is active, wake up at the stored deadline and clear the
  // flag so a long-lived chat view shows the banner again once the cooldown
  // lapses. The deadline is re-read from storage on each (re-)arm; delays
  // beyond the setTimeout range re-arm in chunks. (`Date.now()` is impure,
  // so the arithmetic lives in the effect rather than in render.)
  useEffect(() => {
    if (!cooldownActive) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      // The deadline is whichever of the stored and in-memory values is
      // later; a swallowed storage write leaves the stored value at 0.
      const deadline = Math.max(
        dismissedUntilKey ? getLocalNumber(dismissedUntilKey, 0) : 0,
        inMemoryDeadlineRef.current,
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        setCooldownActive(false);
        return;
      }
      timer = setTimeout(arm, Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS));
    };
    arm();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [cooldownActive, dismissedUntilKey]);

  const dismiss = useCallback(
    (permanent: boolean) => {
      if (permanent) {
        if (suppressedKey) {
          setLocalBool(suppressedKey, true);
        }
        setSuppressed(true);
        return;
      }
      const deadline = Date.now() + DISMISS_COOLDOWN_MS;
      inMemoryDeadlineRef.current = deadline;
      if (dismissedUntilKey) {
        setLocalNumber(dismissedUntilKey, deadline);
      }
      setCooldownActive(true);
    },
    [dismissedUntilKey, suppressedKey],
  );

  if (
    hidden ||
    resourcePressure.mode !== "warning" ||
    !resourcePressure.status
  ) {
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
      {/* Keyed by assistant so the banner's internal "Don't show again"
          checkbox state cannot leak across an in-place assistant switch
          and permanently suppress the wrong assistant's warning. */}
      <ResourcePressureBanner
        key={assistantId ?? "no-assistant"}
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
