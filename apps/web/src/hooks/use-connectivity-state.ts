import { useEffect, useRef, useState } from "react";

import {
  subscribeToConnectivity,
  type ConnectivityState,
} from "@/runtime/connectivity";

export type { ConnectivityState };

const RECOVERY_DEBOUNCE_MS = 2_000;

/**
 * React hook that tracks the Electron host's connectivity state.
 *
 * Returns `"online"` off Electron. Degraded states appear immediately;
 * recovery to `"online"` is debounced by 2 seconds so the banner
 * doesn't flicker on flaky networks.
 */
export function useConnectivityState(): ConnectivityState {
  const [state, setState] = useState<ConnectivityState>("online");
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribeToConnectivity((next) => {
      if (next === "online") {
        if (recoveryTimer.current) return;
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = null;
          setState("online");
        }, RECOVERY_DEBOUNCE_MS);
      } else {
        if (recoveryTimer.current) {
          clearTimeout(recoveryTimer.current);
          recoveryTimer.current = null;
        }
        setState(next);
      }
    });

    return () => {
      unsub();
      if (recoveryTimer.current) {
        clearTimeout(recoveryTimer.current);
        recoveryTimer.current = null;
      }
    };
  }, []);

  return state;
}
