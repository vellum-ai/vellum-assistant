import { CloudOff, WifiOff } from "lucide-react";

import { useConnectivityState } from "@/hooks/use-connectivity-state";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { retryConnectivity } from "@/runtime/connectivity";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

function ElectronConnectivityBanner() {
  const state = useConnectivityState();

  if (state === "online") return null;

  if (state === "device-offline") {
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

  return (
    <div className="px-4 pt-2">
      <Notice
        tone="warning"
        title="Trying to reach Vellum…"
        icon={<CloudOff className="h-4 w-4" aria-hidden="true" />}
        actions={
          <Button variant="outlined" size="compact" onClick={retryConnectivity}>
            Retry now
          </Button>
        }
      />
    </div>
  );
}

function NativeOfflineBanner() {
  const connected = useNetworkStatus();

  if (connected) return null;

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

export function OfflineBanner() {
  const isNative = useIsNativePlatform();

  if (isElectron()) return <ElectronConnectivityBanner />;
  if (isNative) return <NativeOfflineBanner />;
  return null;
}
