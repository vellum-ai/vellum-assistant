
import { Smartphone } from "lucide-react";

import { NudgeSidebarEntry } from "@/components/app/assistant/NudgeSidebarEntry/NudgeSidebarEntry.js";

interface IOSAppSidebarEntryProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function IOSAppSidebarEntry({ onDownload, onDismiss }: IOSAppSidebarEntryProps) {
  return (
    <NudgeSidebarEntry
      title="Get the iOS App"
      description="Push notifications, biometric login, haptics & more."
      ctaLabel="Download"
      ctaLeftIcon={<Smartphone />}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
