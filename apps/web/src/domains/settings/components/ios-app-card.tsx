import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card.js";
import { useIsIOSWeb } from "@/domains/nudges/ios-app-platform.js";
import {
  openIOSAppStore,
  writeIOSAppDownloaded,
} from "@/domains/nudges/ios-app-prefs.js";

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
