import { EyeOff, SquarePen } from "lucide-react";

import { Button, Typography } from "@vellum/design-library";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

interface HomeGreetingHeaderProps {
  avatarComponents: CharacterComponents | null;
  avatarTraits: CharacterTraits | null;
  avatarImageUrl: string | null;
  /** Optional daemon-supplied dynamic greeting. Falls back to a time-of-day greeting. */
  greeting?: string;
  isMobile?: boolean;
  onStartNewChat: () => void;
  /** Flag-gated incognito new-chat entry. Omitted when the flag is off. */
  onStartNewIncognitoChat?: () => void;
}

// Mirrors `computeGreeting` in assistant/src/runtime/routes/home-feed-routes.ts
// so the UI degrades to the same string when the daemon response omits a
// greeting (older daemon build, failed request, etc.).
function clientComputeGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Welcome back";
}

export function HomeGreetingHeader({
  avatarComponents,
  avatarTraits,
  avatarImageUrl,
  greeting,
  isMobile,
  onStartNewChat,
  onStartNewIncognitoChat,
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
          {greeting || clientComputeGreeting(new Date())}
        </Typography>
      </div>

      <div className="flex shrink-0 items-center gap-[var(--app-spacing-sm)]">
        {onStartNewIncognitoChat ? (
          <Button
            variant="ghost"
            iconOnly={<EyeOff />}
            onClick={onStartNewIncognitoChat}
            aria-label="New incognito chat"
            tooltip="New incognito chat"
            className={isMobile ? "!rounded-full" : undefined}
          />
        ) : null}
        {isMobile ? (
          <Button
            variant="primary"
            iconOnly={<SquarePen />}
            onClick={onStartNewChat}
            aria-label="New Chat"
            tooltip="New Chat"
            className="!rounded-full"
          />
        ) : (
          <Button
            variant="primary"
            leftIcon={<SquarePen />}
            onClick={onStartNewChat}
          >
            New Chat
          </Button>
        )}
      </div>
    </div>
  );
}
