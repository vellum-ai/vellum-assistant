import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { Typography } from "@vellumai/design-library";

interface HomeTopHeaderProps {
  avatarComponents: CharacterComponents | null;
  avatarTraits: CharacterTraits | null;
  avatarImageUrl: string | null;
}

/**
 * Top-level page header for the home dashboard: the assistant avatar paired
 * with the "Home" title. Sits above the schedules panel and the secondary
 * greeting banner.
 */
export function HomeTopHeader({
  avatarComponents,
  avatarTraits,
  avatarImageUrl,
}: HomeTopHeaderProps) {
  return (
    <div className="flex items-center gap-[var(--app-spacing-md)]">
      <ChatAvatar
        components={avatarComponents}
        traits={avatarTraits}
        customImageUrl={avatarImageUrl}
        size={48}
      />
      <Typography variant="title-large" as="h1">
        Schedules
      </Typography>
    </div>
  );
}
