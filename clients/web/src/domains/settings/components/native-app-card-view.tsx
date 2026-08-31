import { useEffect } from "react";
import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card";
import {
  openNativeAppStore,
  writeNativeAppDownloaded,
  type NativeAppPromotion,
} from "@/hooks/use-native-app-nudge";
import {
  emitNativeAppNudgeEvent,
  emitNativeAppNudgeImpressionOnce,
} from "@/utils/native-app-nudge-telemetry";
import { useTranslation } from "@/i18n";

export interface NativeAppCardViewProps {
  promotion: NativeAppPromotion;
}

export function NativeAppCardView({ promotion }: NativeAppCardViewProps) {
  const { t } = useTranslation("settings");
  const { appName, target } = promotion;

  // `NativeAppCard` renders null off mobile, so this mount means the card is on
  // screen. Without it `settings:<target>` would carry clicks and no
  // denominator, leaving that surface's conversion uncomputable.
  useEffect(() => {
    emitNativeAppNudgeImpressionOnce("settings", target);
  }, [target]);

  return (
    <NudgeSettingsCard
      title={
        appName === null
          ? t("nativeAppCard.titleGeneric")
          : t("nativeAppCard.title", { appName })
      }
      subtitle={
        appName === null
          ? t("nativeAppCard.subtitleGeneric")
          : t("nativeAppCard.subtitle", { appName })
      }
      benefits={[
        { icon: Bell, text: t("nativeAppCard.benefitPush") },
        { icon: Fingerprint, text: t("nativeAppCard.benefitBiometric") },
        { icon: Vibrate, text: t("nativeAppCard.benefitHaptics") },
        { icon: Smartphone, text: t("nativeAppCard.benefitHomeScreen") },
      ]}
      ctaLabel={t("nativeAppCard.download")}
      ctaLeftIcon={<Smartphone size={16} />}
      onAction={() => {
        emitNativeAppNudgeEvent("click", "settings", target);
        writeNativeAppDownloaded(target);
        openNativeAppStore(target);
      }}
    />
  );
}
