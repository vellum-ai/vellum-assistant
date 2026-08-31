import { Smartphone } from "lucide-react";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import type { NativeAppPromotion } from "@/hooks/use-native-app-nudge";
import { useTranslation } from "@/i18n";

interface NativeAppBannerProps {
  promotion: NativeAppPromotion;
  onDownload: () => void;
  onDismiss: () => void;
}

export function NativeAppBanner({
  promotion,
  onDownload,
  onDismiss,
}: NativeAppBannerProps) {
  const { t } = useTranslation();
  const { appName } = promotion;

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
        appName === null
          ? t("nativeAppBanner.titleGeneric")
          : t("nativeAppBanner.title", { appName })
      }
      subtitle={t("nativeAppBanner.subtitle")}
      ctaLabel={t("nativeAppBanner.download")}
      ctaAriaLabel={
        appName === null
          ? t("nativeAppBanner.downloadAppAriaGeneric")
          : t("nativeAppBanner.downloadAppAria", { appName })
      }
      ariaLabel={
        appName === null
          ? t("nativeAppBanner.bannerAriaGeneric")
          : t("nativeAppBanner.bannerAria", { appName })
      }
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
