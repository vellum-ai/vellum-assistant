import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card";
import {
  getNativeAppPromotion,
  openNativeAppStore,
  writeNativeAppDownloaded,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";
import {
  useIsAndroidWeb,
  useIsIOSWeb,
} from "@/runtime/platform-detection";

export function NativeAppCard() {
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
      title={`Get the ${promotion.appName} App`}
      subtitle={`The Vellum ${promotion.appName} app gives you a native experience.`}
      benefits={[
        { icon: Bell, text: "Push notifications" },
        { icon: Fingerprint, text: "Biometric login" },
        { icon: Vibrate, text: "Native haptics" },
        { icon: Smartphone, text: "Home screen access" },
      ]}
      ctaLabel="Download"
      ctaLeftIcon={<Smartphone size={16} />}
      onAction={() => {
        writeNativeAppDownloaded(promotion.platform);
        openNativeAppStore(promotion.platform);
      }}
    />
  );
}
