import { BellRing, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useTranslation } from "@/i18n";
import {
  isAndroidNotificationSettingsAvailable,
  openAndroidNotificationSettings,
} from "@/runtime/android-notification-settings";
import {
  getNotificationPermission,
  refreshNotificationPermission,
} from "@/runtime/notifications";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

type PermissionState = Awaited<ReturnType<typeof getNotificationPermission>>;

interface PermissionDetails {
  description: string;
  label: string;
  tone: TagTone;
}

export function AndroidNotificationSettingsCard() {
  const { t } = useTranslation("settings");
  const canOpenSystemSettings = isAndroidNotificationSettingsAvailable();
  const [permission, setPermission] = useState<PermissionState | null>(null);

  useEffect(() => {
    void getNotificationPermission().then(setPermission);
  }, []);

  useBusSubscription("app.resume", ({ signal }) => {
    if (signal !== "online") {
      void refreshNotificationPermission().then(setPermission);
    }
  });

  let details: PermissionDetails;
  switch (permission) {
    case "granted":
      details = {
        description: t("androidNotificationSettingsCard.grantedDescription"),
        label: t("androidNotificationSettingsCard.grantedLabel"),
        tone: "positive",
      };
      break;
    case "denied":
      details = {
        description: t("androidNotificationSettingsCard.deniedDescription"),
        label: t("androidNotificationSettingsCard.deniedLabel"),
        tone: "negative",
      };
      break;
    case "prompt":
      details = {
        description: t("androidNotificationSettingsCard.promptDescription"),
        label: t("androidNotificationSettingsCard.promptLabel"),
        tone: "warning",
      };
      break;
    case "unsupported":
      details = {
        description: t(
          "androidNotificationSettingsCard.unsupportedDescription",
        ),
        label: t("androidNotificationSettingsCard.unsupportedLabel"),
        tone: "neutral",
      };
      break;
    default:
      details = {
        description: t("androidNotificationSettingsCard.checkingDescription"),
        label: t("androidNotificationSettingsCard.checkingLabel"),
        tone: "neutral",
      };
      break;
  }

  return (
    <Card padding="lg">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-base)] text-[var(--content-secondary)]">
            <BellRing className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-title-small text-[var(--content-default)]">
                {t("androidNotificationSettingsCard.title")}
              </h2>
              <Tag tone={details.tone}>{details.label}</Tag>
            </div>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-secondary)]">
              {details.description}
            </p>
          </div>
        </div>

        {canOpenSystemSettings && (
          <Button
            variant="outlined"
            onClick={() => void openAndroidNotificationSettings()}
            disabled={permission === null}
            rightIcon={<ExternalLink aria-hidden />}
            className="self-start sm:self-auto"
          >
            {t("androidNotificationSettingsCard.openSettings")}
          </Button>
        )}
      </div>
    </Card>
  );
}
