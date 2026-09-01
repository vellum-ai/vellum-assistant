import { useEffect } from "react";
import { Download } from "lucide-react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import { emitNativeAppNudgeImpressionOnce } from "@/utils/native-app-nudge-telemetry";
import { useTranslation } from "@/i18n";

interface MacOSAppBannerProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function MacOSAppBanner({ onDownload, onDismiss }: MacOSAppBannerProps) {
  const { t } = useTranslation();

  // See NativeAppBanner: the mount is the impression, because eligibility does
  // not mean ChatBody rendered the slot.
  useEffect(() => {
    emitNativeAppNudgeImpressionOnce("banner", "macos");
  }, []);

  return (
    <NudgeChatBanner
      icon={<AppleLogo size={16} style={{ color: "var(--content-default)" }} />}
      title={t("macosAppBanner.title")}
      subtitle={t("macosAppBanner.subtitle")}
      ctaLabel={t("macosAppBanner.ctaLabel")}
      ctaLeftIcon={<Download />}
      ctaAriaLabel={t("macosAppBanner.ctaAriaLabel")}
      ariaLabel={t("macosAppBanner.ariaLabel")}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
