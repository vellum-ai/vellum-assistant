import { useCallback, useEffect, useRef, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  getConnectivityState,
  retryConnectivity,
  subscribeToConnectivity,
  type ConnectivityState,
} from "@/runtime/connectivity";

export type { ConnectivityState };

const RECOVERY_DEBOUNCE_MS = 2_000;

export interface ConnectivityStateHandle {
  connectivityState: ConnectivityState;
  /** Probe the host immediately and apply the post-probe state. */
  retryConnectivity: () => void;
}

/**
 * React hook that tracks the Electron host's connectivity state.
 *
 * Returns `"online"` off Electron. Degraded states appear immediately;
 * recovery to `"online"` via broadcast is debounced by 2 seconds so the
 * banner doesn't flicker on flaky networks.
 *
 * Broadcasts alone can't be trusted to converge: main only broadcasts on
 * state *change*, so a single missed message (window hidden, IPC race at
 * startup) would otherwise leave the banner stuck with no path back. Two
 * pull-based syncs recover from that, applying immediately (no debounce —
 * a pulled snapshot is current truth, not a possibly-flapping transition):
 *
 *   1. Re-fetch on `app.resume` (visibility/online) and on window focus —
 *      focus is not bus-owned and a desynced window can regain focus
 *      without a visibility change.
 *   2. `retryConnectivity` applies the state returned by the host's probe,
 *      so the banner's "Retry now" works even if broadcasts never arrive.
 */
export function useConnectivityState(): ConnectivityStateHandle {
  const [state, setState] = useState<ConnectivityState>("online");
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimer.current) {
      clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    }
  }, []);

  const applySnapshot = useCallback(
    (next: ConnectivityState | null) => {
      if (!next) return;
      clearRecoveryTimer();
      setState(next);
    },
    [clearRecoveryTimer],
  );

  const resync = useCallback(() => {
    void getConnectivityState().then(applySnapshot);
  }, [applySnapshot]);

  useBusSubscription("app.resume", resync);

  useEffect(() => {
    const unsub = subscribeToConnectivity((next) => {
      if (next === "online") {
        if (recoveryTimer.current) return;
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = null;
          setState("online");
        }, RECOVERY_DEBOUNCE_MS);
      } else {
        clearRecoveryTimer();
        setState(next);
      }
    });

    window.addEventListener("focus", resync);

    return () => {
      unsub();
      window.removeEventListener("focus", resync);
      clearRecoveryTimer();
    };
  }, [resync, clearRecoveryTimer]);

  const retry = useCallback(() => {
    void retryConnectivity().then(applySnapshot);
  }, [applySnapshot]);

  return { connectivityState: state, retryConnectivity: retry };
}
