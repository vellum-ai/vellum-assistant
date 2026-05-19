import { SquarePen } from "lucide-react";

import { Button, Typography } from "@vellum/design-library";
import { ChatAvatar } from "@/components/avatar/chat-avatar.js";
import type { CharacterComponents, CharacterTraits } from "@/domains/avatar/types.js";

interface HomeGreetingHeaderProps {
  avatarComponents: CharacterComponents | null;
  avatarTraits: CharacterTraits | null;
  avatarImageUrl: string | null;
  onStartNewChat: () => void;
}

export function HomeGreetingHeader({
  avatarComponents,
  avatarTraits,
  avatarImageUrl,
  onStartNewChat,
}: HomeGreetingHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-[var(--app-spacing-md)]">
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          size={36}
        />
        <Typography variant="title-large" as="h1">
          Here&apos;s what&apos;s been going on
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
