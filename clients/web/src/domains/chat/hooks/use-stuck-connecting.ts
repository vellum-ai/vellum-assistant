import { useCallback, useEffect, useState } from "react";

import { captureError } from "@/lib/sentry/capture-error";

/**
 * How long the ChatPage "Connecting…" guard may persist before it is treated
 * as stuck. Auth-session init and the first assistant-lifecycle resolution
 * normally settle in a few seconds; this bound is generous enough for slow
 * networks while still giving a wedged handshake a user-visible exit. The
 * hatching flow is NOT under this bound — `initializing` has its own
 * 5-minute watchdog in the lifecycle service.
 */
export const CONNECTING_STUCK_TIMEOUT_MS = 30_000;

/**
 * Watchdog for the ChatPage "Connecting…" guard.
 *
 * The connecting state has no natural failure surface: if auth-session init
 * or the first lifecycle probe wedges (hung request, dropped promise), the
 * spinner shows forever with nothing captured to telemetry — the failure is
 * invisible in the field and undiagnosable for the user. After
 * `timeoutMs` of uninterrupted connecting, this flips to `stuck` so the
 * caller can render a retry affordance, and captures one Sentry event per
 * episode so wedges become measurable.
 *
 * `reset` re-arms the watchdog (used by the retry button): a retry that
 * wedges again re-escalates after another full timeout.
 */
export function useStuckConnecting(
  connectingReason: string | null,
  timeoutMs: number = CONNECTING_STUCK_TIMEOUT_MS,
): { connectingStuck: boolean; resetStuckConnecting: () => void } {
  const [stuck, setStuck] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (connectingReason === null) {
      setStuck(false);
      return;
    }
    const timer = setTimeout(() => {
      setStuck(true);
      captureError(
        new Error(`Chat stuck in Connecting state (${connectingReason})`),
        {
          context: "chat.connecting_stuck",
          tags: { reason: connectingReason },
          extra: { timeoutMs, attempt },
        },
      );
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [connectingReason, timeoutMs, attempt]);

  const resetStuckConnecting = useCallback(() => {
    setStuck(false);
    setAttempt((n) => n + 1);
  }, []);

  return { connectingStuck: stuck, resetStuckConnecting };
}
