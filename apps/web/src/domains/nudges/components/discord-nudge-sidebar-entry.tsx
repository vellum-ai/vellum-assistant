import { DiscordLogo } from "@/components/icons/discord-logo.js";
import { NudgeSidebarEntry } from "@/domains/nudges/components/nudge-sidebar-entry.js";

interface DiscordNudgeSidebarEntryProps {
  onJoin: () => void;
  onDismiss: () => void;
}

export function DiscordNudgeSidebarEntry({ onJoin, onDismiss }: DiscordNudgeSidebarEntryProps) {
  return (
    <NudgeSidebarEntry
      title="Join our community"
      description="Talk to the team — share feedback, request features, get answers faster."
      ctaLabel="Join Discord"
      ctaLeftIcon={
        <DiscordLogo
          size={16}
          style={{ color: "currentColor" }}
        />
      }
      onAction={onJoin}
      onDismiss={onDismiss}
    />
  );
}
