
import { Download, Keyboard, Monitor, MousePointerClick, Terminal } from "lucide-react";

import { useIsMacOSWeb } from "@/lib/mac-app-nudge/platform.js";
import { openMacOsDownload, writeMacOsAppDownloaded } from "@/lib/mac-app-nudge/prefs.js";

import { NudgeSettingsCard, type NudgeBenefit } from "@/components/app/settings/NudgeSettingsCard.js";

const BENEFITS: ReadonlyArray<NudgeBenefit> = [
  { icon: MousePointerClick, text: "Computer use — control your screen and automate any app" },
  { icon: Terminal, text: "Run commands — execute bash directly on your machine" },
  { icon: Monitor, text: "macOS automation — script native apps like Mail, Calendar & more" },
  { icon: Keyboard, text: "Global hotkey — summon your assistant from anywhere" },
];

export function MacOSAppCard() {
  const visible = useIsMacOSWeb();

  if (!visible) return null;

  function handleDownload() {
    writeMacOsAppDownloaded();
    openMacOsDownload();
  }

  return (
    <NudgeSettingsCard
      title="macOS App"
      subtitle="Unlock your assistant's full potential with native capabilities."
      benefits={BENEFITS}
      ctaLabel="Download for macOS"
      ctaLeftIcon={<Download />}
      onAction={handleDownload}
    />
  );
}
