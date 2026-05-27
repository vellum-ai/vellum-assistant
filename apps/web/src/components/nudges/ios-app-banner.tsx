
import { Smartphone } from "lucide-react";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";

interface IOSAppBannerProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function IOSAppBanner({ onDownload, onDismiss }: IOSAppBannerProps) {
  return (
    <NudgeChatBanner
      icon={
        <Smartphone
          size={16}
          style={{ color: "var(--content-default)" }}
          aria-hidden
        />
      }
      title="Get the iOS app"
      subtitle="Push notifications · biometric login · haptics"
      ctaLabel="Download"
      ctaAriaLabel="Download iOS app"
      ariaLabel="Download the iOS app"
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
