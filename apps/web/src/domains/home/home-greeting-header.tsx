import { SquarePen } from "lucide-react";

import { Button, Typography } from "@vellum/design-library";
import { ChatAvatar } from "@/components/avatar/chat-avatar.js";
import type { CharacterComponents, CharacterTraits } from "@/domains/avatar/types.js";

interface HomeGreetingHeaderProps {
  avatarComponents: CharacterComponents | null;
  avatarTraits: CharacterTraits | null;
  avatarImageUrl: string | null;
  /** Optional daemon-supplied dynamic greeting. Falls back to a static string. */
  greeting?: string;
  onStartNewChat: () => void;
}

export function HomeGreetingHeader({
  avatarComponents,
  avatarTraits,
  avatarImageUrl,
  greeting,
  onStartNewChat,
}: HomeGreetingHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-[var(--app-spacing-md)]">
      <div className="flex min-w-0 flex-1 items-center gap-[var(--app-spacing-md)]">
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          size={36}
        />
        <Typography variant="title-large" as="h1" className="truncate">
          {greeting || "Here’s what’s been going on"}
        </Typography>
      </div>

      <Button
        variant="primary"
        leftIcon={<SquarePen />}
        onClick={onStartNewChat}
      >
        New Chat
      </Button>
    </div>
  );
}
