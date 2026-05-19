
import { Download } from "lucide-react";

import { NudgeSidebarEntry } from "@/components/app/assistant/NudgeSidebarEntry/NudgeSidebarEntry.js";

interface MacOSAppSidebarEntryProps {
  onDownload: () => void;
  onDismiss: () => void;
}

export function MacOSAppSidebarEntry({ onDownload, onDismiss }: MacOSAppSidebarEntryProps) {
  return (
    <NudgeSidebarEntry
      title="Get the macOS App"
      description="Computer use, terminal access, native automation & more."
      ctaLabel="Download"
      ctaLeftIcon={<Download />}
      onAction={onDownload}
      onDismiss={onDismiss}
    />
  );
}
