import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

const TAP_THRESHOLD = 7;
const MESSAGE_DURATION_MS = 2000;

/**
 * Shared 7-tap "developer mode" unlock behavior.
 *
 * The version string is the (intentionally undiscoverable) tap target that
 * toggles the `settingsDeveloperNav` flag — the only way to surface the
 * Developer settings tab. Exposed as a hook so the affordance can live on
 * whichever version label is actually on screen: the "Current" version line
 * inside the upgrade panels when they render, and the standalone
 * `DevModeVersionUnlock` fallback when they don't (e.g. logged out of the
 * platform with no local runtime to upgrade). This keeps the unlock reachable
 * in every gate state without duplicating a version label.
 */
export function useDevModeVersionTap(assistantId: string | null): {
  onTap: () => void;
  message: string | null;
} {
  const tapCountRef = useRef(0);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const onTap = useCallback(() => {
    tapCountRef.current += 1;
    if (tapCountRef.current >= TAP_THRESHOLD) {
      tapCountRef.current = 0;
      const store = useAssistantFeatureFlagStore.getState();
      const nowEnabled = !store.settingsDeveloperNav;
      store.setFlag("settingsDeveloperNav", nowEnabled, assistantId);
      setMessage(
        nowEnabled ? "Developer mode enabled" : "Developer mode disabled",
      );
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current);
      }
      dismissTimerRef.current = setTimeout(() => {
        setMessage(null);
        dismissTimerRef.current = null;
      }, MESSAGE_DURATION_MS);
    }
  }, [assistantId]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) {
        clearTimeout(dismissTimerRef.current);
      }
    },
    [],
  );

  return { onTap, message };
}

export interface DevModeVersionUnlockProps {
  version: string | null;
  loading: boolean;
  /**
   * Active assistant id for PATCH'ing the `settingsDeveloperNav`
   * override server-side. `null` when the parent panel hasn't resolved
   * the active assistant yet — toggle is still functional client-side,
   * the server PATCH is just skipped.
   */
  assistantId: string | null;
}

/**
 * Standalone version string with the 7-tap dev-mode unlock. Used as the
 * fallback version display when no upgrade panel is on screen to host the
 * tap (see `useDevModeVersionTap`).
 */
export function DevModeVersionUnlock({
  version,
  loading,
  assistantId,
}: DevModeVersionUnlockProps) {
  const { onTap, message } = useDevModeVersionTap(assistantId);

  if (loading) {
    return (
      <span className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading version...
      </span>
    );
  }

  if (!version) {
    return (
      <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
        —
      </span>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="break-all text-left text-body-medium-lighter text-[var(--content-default)]"
        onClick={onTap}
      >
        {version}
      </button>
      {message && (
        <p className="mt-1 text-body-small-default text-[var(--content-accent)]">
          {message}
        </p>
      )}
    </div>
  );
}
