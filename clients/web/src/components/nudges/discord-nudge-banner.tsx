import { DiscordLogo } from "@/components/icons/discord-logo";
import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import { useTranslation } from "@/i18n";

interface DiscordNudgeBannerProps {
  onJoin: () => void;
  onDismiss: () => void;
}

export function DiscordNudgeBanner({
  onJoin,
  onDismiss,
}: DiscordNudgeBannerProps) {
  const { t } = useTranslation();

  return (
    <NudgeChatBanner
      icon={
        <DiscordLogo size={16} style={{ color: "var(--content-default)" }} />
      }
      title={t("discordNudgeBanner.title")}
      subtitle={
        <>
          <span className="sm:hidden">{t("discordNudgeBanner.subtitleShort")}</span>
          <span className="hidden sm:inline">
            {t("discordNudgeBanner.subtitleLong")}
          </span>
        </>
      }
      ctaLabel={
        <>
          <span className="sm:hidden">{t("discordNudgeBanner.ctaShort")}</span>
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <DiscordLogo size={16} style={{ color: "currentColor" }} />
            {t("discordNudgeBanner.ctaLong")}
          </span>
        </>
      }
      ctaAriaLabel={t("discordNudgeBanner.ariaLabel")}
      ariaLabel={t("discordNudgeBanner.ariaLabel")}
      onAction={onJoin}
      onDismiss={onDismiss}
    />
  );
}
