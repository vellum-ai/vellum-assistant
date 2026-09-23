import { useEffect } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@vellumai/design-library";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import type { NativeAppPromotion } from "@/hooks/use-native-app-nudge";
import {
  emitNativeAppNudgeImpressionOnce,
  type NudgeSurface,
} from "@/utils/native-app-nudge-telemetry";
import { useTranslation } from "@/i18n";

interface NativeAppBannerProps {
  promotion: NativeAppPromotion;
  onDownload: () => void;
  onDismiss: () => void;
  alternative?: {
    promotion: NativeAppPromotion;
    onDownload: () => void;
  };
  surface?: NudgeSurface;
}

export function NativeAppBanner({
  promotion,
  onDownload,
  onDismiss,
  alternative,
  surface = "banner",
}: NativeAppBannerProps) {
  const { t } = useTranslation();
  const { appName, target } = promotion;
  const isReminder =
    surface === "schedule-created" || surface === "notifications-empty";
  const alternativeTarget = alternative?.promotion.target;

  // Count impressions only when the banner is mounted.
  useEffect(() => {
    emitNativeAppNudgeImpressionOnce(surface, target);
    if (alternativeTarget) {
      emitNativeAppNudgeImpressionOnce(surface, alternativeTarget);
    }
  }, [surface, target, alternativeTarget]);

  return (
    <NudgeChatBanner
      icon={
        <Smartphone
          size={16}
          style={{ color: "var(--content-default)" }}
          aria-hidden
        />
      }
      title={
        appName === null || alternative
          ? t("nativeAppBanner.titleGeneric")
          : t("nativeAppBanner.title", { appName })
      }
      subtitle={t(
        isReminder
          ? "nativeAppBanner.reminderSubtitle"
          : "nativeAppBanner.subtitle",
      )}
      actions={
        isReminder ? (
          [
            { promotion, onDownload },
            ...(alternative ? [alternative] : []),
          ].map(({ promotion: option, onDownload: download }) => (
            <Button
              key={option.target}
              variant="outlined"
              size="compact"
              onClick={download}
              aria-label={
                option.appName === null
                  ? t("nativeAppBanner.downloadAppAriaGeneric")
                  : t("nativeAppBanner.downloadAppAria", {
                      appName: option.appName,
                    })
              }
            >
              {option.target === "ios"
                ? t("nativeAppBanner.appStore")
                : option.target === "android"
                  ? t("nativeAppBanner.googlePlay")
                  : t("nativeAppBanner.download")}
            </Button>
          ))
        ) : undefined
      }
      ctaLabel={t("nativeAppBanner.download")}
      ctaAriaLabel={
        appName === null
          ? t("nativeAppBanner.downloadAppAriaGeneric")
          : t("nativeAppBanner.downloadAppAria", { appName })
      }
      ariaLabel={
        appName === null || alternative
          ? t("nativeAppBanner.bannerAriaGeneric")
          : t("nativeAppBanner.bannerAria", { appName })
      }
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
