import { Settings } from "lucide-react";
import { useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { openAndroidNotificationSettings } from "@/runtime/android-notification-settings";
import {
  getNotificationPermission,
  refreshNotificationPermission,
} from "@/runtime/notifications";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

type PermissionState = Awaited<ReturnType<typeof getNotificationPermission>>;

export function NativeNotificationSettingsCard() {
  const isAndroid = useIsNativeAndroid();
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (isAndroid) {
      void getNotificationPermission().then(setPermission);
    }
  }, [isAndroid]);

  useBusSubscription("app.resume", () => {
    if (isAndroid) {
      void refreshNotificationPermission().then(setPermission);
    }
  });

  if (!isAndroid) {
    return null;
  }

  const handleAction = async () => {
    setError(!(await openAndroidNotificationSettings()));
  };

  return (
    <Card className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-body-medium-default text-[var(--content-default)]">
          Native alerts
        </p>
        <p className="text-body-small-default text-[var(--content-secondary)]">
          {permission === "granted"
            ? "Enabled for this device."
            : "Receive alerts when the app is closed."}
        </p>
        {error && (
          <p className="text-body-small-default text-[var(--system-negative-strong)]">
            Could not open Android notification settings.
          </p>
        )}
      </div>
      {permission !== "unsupported" && (
        <Button
          variant="outlined"
          size="regular"
          leftIcon={<Settings />}
          onClick={() => void handleAction()}
          disabled={permission === null}
        >
          System settings
        </Button>
      )}
    </Card>
  );
}
