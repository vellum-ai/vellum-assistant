import { WifiOff } from "lucide-react";

import { Notice } from "@vellum/design-library/components/notice";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useNetworkStatus } from "@/hooks/use-network-status";

/**
 * Non-intrusive banner shown when the Capacitor iOS app loses network
 * connectivity. Auto-dismisses when the connection is restored.
 *
 * Renders nothing on web — gated by `useIsNativePlatform()` to avoid
 * console errors from the Network plugin.
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
