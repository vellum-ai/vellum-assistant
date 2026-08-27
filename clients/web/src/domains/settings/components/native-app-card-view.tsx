import { Bell, Fingerprint, Smartphone, Vibrate } from "lucide-react";

import { NudgeSettingsCard } from "@/domains/settings/components/nudge-settings-card";
import {
  openNativeAppStore,
  writeNativeAppDownloaded,
  type NativeAppPromotion,
} from "@/hooks/use-native-app-nudge";
import { useTranslation } from "@/i18n";

export interface NativeAppCardViewProps {
  promotion: NativeAppPromotion;
}

export function NativeAppCardView({ promotion }: NativeAppCardViewProps) {
  const { t } = useTranslation("settings");
  const { appName, target } = promotion;

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
        writeNativeAppDownloaded(target);
        openNativeAppStore(target);
      }}
    />
  );
}
