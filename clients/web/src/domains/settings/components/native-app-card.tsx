import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card";
import {
  getNativeAppPromotion,
  openNativeAppStore,
  writeNativeAppDownloaded,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";
import { useTranslation } from "@/i18n";
import {
  useIsAndroidWeb,
  useIsIOSWeb,
} from "@/runtime/platform-detection";

export function NativeAppCard() {
  const { t } = useTranslation("settings");
  const isIOSWeb = useIsIOSWeb();
  const isAndroidWeb = useIsAndroidWeb();
  const platform: NativeAppPlatform | null = isIOSWeb
    ? "ios"
    : isAndroidWeb
      ? "android"
      : null;
  const promotion = platform ? getNativeAppPromotion(platform) : null;

  if (!promotion) {
    return null;
  }

  return (
    <NudgeSettingsCard
      title={t("nativeAppCard.title", { appName: promotion.appName })}
      subtitle={t("nativeAppCard.subtitle", { appName: promotion.appName })}
      benefits={[
        { icon: Bell, text: t("nativeAppCard.benefitPush") },
        { icon: Fingerprint, text: t("nativeAppCard.benefitBiometric") },
        { icon: Vibrate, text: t("nativeAppCard.benefitHaptics") },
        { icon: Smartphone, text: t("nativeAppCard.benefitHomeScreen") },
      ]}
      ctaLabel={t("nativeAppCard.download")}
      ctaLeftIcon={<Smartphone size={16} />}
      onAction={() => {
        writeNativeAppDownloaded(promotion.platform);
        openNativeAppStore(promotion.platform);
      }}
    />
  );
}
