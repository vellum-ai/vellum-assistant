
import { Download } from "lucide-react";

import { AppleLogo } from "@/components/icons/apple-logo.js";
import { NudgeChatBanner } from "@/domains/nudges/components/nudge-chat-banner.js";

interface MacOSAppBannerProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function MacOSAppBanner({ onDownload, onDismiss }: MacOSAppBannerProps) {
  return (
    <NudgeChatBanner
      icon={
        <AppleLogo
          size={16}
          style={{ color: "var(--content-default)" }}
        />
      }
      title="Get the macOS app"
      subtitle="Computer use · terminal access · native automation"
      ctaLabel="Download"
      ctaLeftIcon={<Download />}
      ctaAriaLabel="Download macOS app"
      ariaLabel="Download the macOS app"
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
