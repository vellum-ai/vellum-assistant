
import { DiscordLogo } from "@/components/app/icons/discord-logo.js";
import { NudgeSidebarEntry } from "@/components/app/assistant/NudgeSidebarEntry/NudgeSidebarEntry.js";

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
