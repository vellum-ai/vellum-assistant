import { Smartphone } from "lucide-react";

import { NudgeChatBanner } from "@/components/nudges/nudge-chat-banner";
import {
  getNativeAppName,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";

interface NativeAppBannerProps {
  platform: NativeAppPlatform;
  onDownload: () => void;
  onDismiss: () => void;
}

export function NativeAppBanner({
  platform,
  onDownload,
  onDismiss,
}: NativeAppBannerProps) {
  const appName = getNativeAppName(platform);

  return (
    <NudgeChatBanner
      icon={
        <Smartphone
          size={16}
          style={{ color: "var(--content-default)" }}
          aria-hidden
        />
      }
      title={`Get the ${appName} app`}
      subtitle="Push notifications · biometric login · haptics"
      ctaLabel="Download"
      ctaAriaLabel={`Download ${appName} app`}
      ariaLabel={`Download the ${appName} app`}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
