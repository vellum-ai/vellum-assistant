import { Star } from "lucide-react";

import { NudgeSidebarEntry } from "@/domains/nudges/components/nudge-sidebar-entry.js";

interface GitHubNudgeSidebarEntryProps {
  onStar: () => void;
  onDismiss: () => void;
}

export function GitHubNudgeSidebarEntry({ onStar, onDismiss }: GitHubNudgeSidebarEntryProps) {
  return (
    <NudgeSidebarEntry
      title="Star us on GitHub"
      description="Vellum is open source — help us build it."
      ctaLabel="Star on GitHub"
      ctaLeftIcon={<Star />}
      onAction={onStar}
      onDismiss={onDismiss}
    />
  );
}
