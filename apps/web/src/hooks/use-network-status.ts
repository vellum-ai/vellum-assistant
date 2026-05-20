import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { useEffect, useState } from "react";

/**
 * React hook that tracks network connectivity on Capacitor iOS.
 *
 * On native platforms it queries `Network.getStatus()` on mount and subscribes
 * to `networkStatusChange` events for real-time updates. On web it always
 * returns `true` — the offline banner is a native-only feature.
 */
export function useNetworkStatus(): boolean {
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let removed = false;

    Network.getStatus()
      .then((status) => {
        if (!removed) setConnected(status.connected);
      })
      .catch(() => {
        // Plugin call failed — leave state at the optimistic default.
      });

    const handle = Network.addListener("networkStatusChange", (status) => {
      if (!removed) setConnected(status.connected);
    });

    return () => {
      removed = true;
      handle.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  return connected;
}
