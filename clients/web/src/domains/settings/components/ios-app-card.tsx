import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card";
import { useIsIOSWeb } from "@/runtime/platform-detection";
import {
  openIOSAppStore,
  writeIOSAppDownloaded,
} from "@/hooks/use-ios-app-nudge";

export function IOSAppCard() {
  const isIOSWeb = useIsIOSWeb();

  if (!isIOSWeb) {
    return null;
  }

  return (
    <NudgeSettingsCard
      title="Get the iOS App"
      subtitle="The Vellum iOS app gives you a native experience."
      benefits={[
        { icon: Bell, text: "Push notifications" },
        { icon: Fingerprint, text: "Biometric login" },
        { icon: Vibrate, text: "Native haptics" },
        { icon: Smartphone, text: "Home screen access" },
      ]}
      ctaLabel="Download"
      ctaLeftIcon={<Smartphone size={16} />}
      onAction={() => {
        writeIOSAppDownloaded();
        openIOSAppStore();
      }}
    />
  );
}
