import { Smartphone } from "lucide-react";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import {
  getNativeAppName,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";
import { useTranslation } from "@/i18n";

interface NativeAppBannerProps {
  platform: NativeAppPlatform;
  onDownload: () => void;
  onDismiss: () => void;
}

export function NativeAppBanner({
  platform,
  onDownload,
  onDismiss,
}: NativeAppBannerProps) {
  const { t } = useTranslation();
  const appName = getNativeAppName(platform);

  return (
    <NudgeChatBanner
      icon={
        <Smartphone
          size={16}
          style={{ color: "var(--content-default)" }}
          aria-hidden
        />
      }
      title={t("nativeAppBanner.title", { appName })}
      subtitle={t("nativeAppBanner.subtitle")}
      ctaLabel={t("nativeAppBanner.download")}
      ctaAriaLabel={t("nativeAppBanner.downloadAppAria", { appName })}
      ariaLabel={t("nativeAppBanner.bannerAria", { appName })}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
