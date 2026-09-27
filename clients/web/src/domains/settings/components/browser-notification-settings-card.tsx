import { useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useTranslation } from "@/i18n";
import {
  refreshNotificationPermission,
  requestBrowserNotificationPermission,
} from "@/runtime/notifications";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

type PermissionState = Awaited<ReturnType<typeof refreshNotificationPermission>>;

export function BrowserNotificationSettingsCard() {
  const { t } = useTranslation("settings");
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const refresh = () => {
    void refreshNotificationPermission().then(setPermission);
  };

  useEffect(refresh, []);
  useBusSubscription("app.resume", refresh);
  useBusSubscription("app.attention", ({ attended }) => {
    if (attended) {
      refresh();
    }
  });

  const enable = () => {
    setRequesting(true);
    void requestBrowserNotificationPermission().then((result) => {
      setPermission(result);
      setRequesting(false);
    });
  };

  const description = permission === "granted"
    ? t("browserNotificationSettingsCard.grantedDescription")
    : permission === "denied"
      ? t("browserNotificationSettingsCard.deniedDescription")
      : permission === "unsupported"
        ? t("browserNotificationSettingsCard.unsupportedDescription")
        : permission === "prompt"
          ? t("browserNotificationSettingsCard.promptDescription")
          : t("browserNotificationSettingsCard.checkingDescription");

  return (
    <Card padding="lg">
      <div className="space-y-3">
        <h2 className="text-title-small text-[var(--content-default)]">
          {t("browserNotificationSettingsCard.title")}
        </h2>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {description}
        </p>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {t("browserNotificationSettingsCard.openTabDescription")}
        </p>
        {permission === "prompt" && (
          <Button variant="outlined" disabled={requesting} onClick={enable}>
            {t("browserNotificationSettingsCard.enable")}
          </Button>
        )}
      </div>
    </Card>
  );
}
