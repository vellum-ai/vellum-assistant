
import { WifiOff } from "lucide-react";

import { Notice } from "@vellum/design-library/components/notice";
import { useIsNativePlatform } from "@/lib/native-auth.js";
import { useNetworkStatus } from "@/lib/network-status.js";

/**
 * Non-intrusive banner shown when the Capacitor iOS app loses network
 * connectivity. Auto-dismisses when the connection is restored.
 *
 * Renders nothing on web — gated by `useIsNativePlatform()` to avoid
 * SSR/hydration mismatches and console errors from the Network plugin.
 */
export function OfflineBanner() {
  const isNative = useIsNativePlatform();
  const connected = useNetworkStatus();

  if (!isNative || connected) return null;

  return (
    <div className="px-4 pt-2">
      <Notice
        tone="warning"
        title="You're offline"
        icon={<WifiOff className="h-4 w-4" aria-hidden="true" />}
      />
    </div>
  );
}
