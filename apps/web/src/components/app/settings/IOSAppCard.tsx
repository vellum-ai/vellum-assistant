
import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { useIsIOSWeb } from "@/lib/ios-app-nudge/platform.js";
import { openIOSAppStore, writeIOSAppDownloaded } from "@/lib/ios-app-nudge/prefs.js";

import { NudgeSettingsCard, type NudgeBenefit } from "@/components/app/settings/NudgeSettingsCard.js";

const BENEFITS: ReadonlyArray<NudgeBenefit> = [
  { icon: Bell, text: "Push notifications — stay in the loop even when the browser is closed" },
  { icon: Fingerprint, text: "Biometric login — Face ID & Touch ID for instant, secure access" },
  { icon: Vibrate, text: "Native haptics — tactile feedback that feels part of the device" },
  { icon: Smartphone, text: "Home screen access — launch your assistant with a single tap" },
];

export function IOSAppCard() {
  const visible = useIsIOSWeb();

  if (!visible) return null;

  function handleDownload() {
    writeIOSAppDownloaded();
    openIOSAppStore();
  }

  return (
    <NudgeSettingsCard
      title="iOS App"
      subtitle="Your assistant, always in your pocket."
      benefits={BENEFITS}
      ctaLabel="Download on the App Store"
      ctaLeftIcon={<Smartphone />}
      onAction={handleDownload}
    />
  );
}
