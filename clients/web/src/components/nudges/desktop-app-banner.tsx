import { useEffect } from "react";
import { Download, Monitor } from "lucide-react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import type { DesktopAppPlatform } from "@/runtime/desktop-app-platform";
import { emitNativeAppNudgeImpressionOnce } from "@/utils/native-app-nudge-telemetry";
import { useTranslation } from "@/i18n";

interface DesktopAppBannerProps {
  platform: DesktopAppPlatform;
  onDownload: () => void;
  onDismiss: () => void;
}

export function DesktopAppBanner({
  platform,
  onDownload,
  onDismiss,
}: DesktopAppBannerProps) {
  const { t } = useTranslation();

  useEffect(() => {
    emitNativeAppNudgeImpressionOnce("banner", platform);
  }, [platform]);

  const icon =
    platform === "windows" ? (
      <Monitor size={16} />
    ) : (
      <AppleLogo size={16} style={{ color: "var(--content-default)" }} />
    );

  return (
    <NudgeChatBanner
      icon={icon}
      title={t("desktopAppBanner.title", { platform })}
      subtitle={t("desktopAppBanner.subtitle")}
      ctaLabel={t("desktopAppBanner.ctaLabel")}
      ctaLeftIcon={<Download />}
      ctaAriaLabel={t("desktopAppBanner.ctaAriaLabel", { platform })}
      ariaLabel={t("desktopAppBanner.ariaLabel", { platform })}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
