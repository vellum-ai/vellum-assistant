import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

const TAP_THRESHOLD = 7;
const MESSAGE_DURATION_MS = 2000;

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

export function DevModeVersionUnlock({
  version,
  loading,
  assistantId,
}: DevModeVersionUnlockProps) {
  const tapCountRef = useRef(0);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = useCallback(() => {
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
        onClick={handleClick}
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
