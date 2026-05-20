
import { DiscordLogo } from "@/components/icons/discord-logo.js";
import { NudgeChatBanner } from "@/domains/nudges/components/nudge-chat-banner.js";

interface DiscordNudgeBannerProps {
  onJoin: () => void;
  onDismiss: () => void;
}

export function DiscordNudgeBanner({ onJoin, onDismiss }: DiscordNudgeBannerProps) {
  return (
    <NudgeChatBanner
      icon={
        <DiscordLogo
          size={16}
          style={{ color: "var(--content-default)" }}
        />
      }
      title="Join our community!"
      subtitle={
        <>
          <span className="sm:hidden">Share feedback, request features, get answers faster</span>
          <span className="hidden sm:inline">
            Talk to the team — share feedback, request features, get answers faster
          </span>
        </>
      }
      ctaLabel={
        <>
          <span className="sm:hidden">Join</span>
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <DiscordLogo size={16} style={{ color: "currentColor" }} />
            Join Discord
          </span>
        </>
      }
      ctaAriaLabel="Join the Vellum Discord community"
      ariaLabel="Join the Vellum Discord community"
      onAction={onJoin}
      onDismiss={onDismiss}
    />
  );
}
