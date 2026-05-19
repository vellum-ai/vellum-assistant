
import { Star } from "lucide-react";
import { GitHubLogo } from "@/components/app/icons/github-logo.js";

import { NudgeChatBanner } from "@/components/app/assistant/NudgeChatBanner/NudgeChatBanner.js";

interface GitHubNudgeBannerProps {
  onStar: () => void;
  onDismiss: () => void;
}

export function GitHubNudgeBanner({ onStar, onDismiss }: GitHubNudgeBannerProps) {
  return (
    <NudgeChatBanner
      icon={
        <GitHubLogo
          size={16}
          style={{ color: "var(--content-default)" }}
          aria-hidden
        />
      }
      title="Vellum is open source"
      subtitle="Star us on GitHub or contribute"
      ctaLabel="Star us"
      ctaLeftIcon={<Star />}
      ctaAriaLabel="Star Vellum on GitHub"
      ariaLabel="Vellum is open source on GitHub"
      onAction={onStar}
      onDismiss={onDismiss}
    />
  );
}
