import { useEffect } from "react";
import { Download, Monitor } from "lucide-react";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import { emitNativeAppNudgeImpressionOnce } from "@/utils/native-app-nudge-telemetry";
import { useTranslation } from "@/i18n";

interface LinuxAppBannerProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function LinuxAppBanner({ onDownload, onDismiss }: LinuxAppBannerProps) {
  const { t } = useTranslation();

  // See NativeAppBanner: the mount is the impression, because eligibility does
  // not mean ChatBody rendered the slot.
  useEffect(() => {
    emitNativeAppNudgeImpressionOnce("banner", "linux");
  }, []);

  return (
    <NudgeChatBanner
      icon={<Monitor size={16} style={{ color: "var(--content-default)" }} />}
      title={t("linuxAppBanner.title")}
      subtitle={t("linuxAppBanner.subtitle")}
      ctaLabel={t("linuxAppBanner.ctaLabel")}
      ctaLeftIcon={<Download />}
      ctaAriaLabel={t("linuxAppBanner.ctaAriaLabel")}
      ariaLabel={t("linuxAppBanner.ariaLabel")}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
