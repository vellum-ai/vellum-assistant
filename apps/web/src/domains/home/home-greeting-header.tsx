import { SquarePen } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

interface HomeGreetingHeaderProps {
  /** Optional daemon-supplied dynamic greeting. Falls back to a time-of-day greeting. */
  greeting?: string;
  isMobile?: boolean;
  onStartNewChat: () => void;
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

/**
 * Secondary greeting banner shown beneath the top header and schedules panel.
 * Smaller and de-emphasised relative to the "Home" title, paired with the
 * New Chat action.
 */
export function HomeGreetingHeader({
  greeting,
  isMobile,
  onStartNewChat,
}: HomeGreetingHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-[var(--app-spacing-md)]">
      <Typography
        variant="title-medium"
        as="h2"
        className="min-w-0 flex-1 truncate text-[var(--content-secondary)]"
      >
        {greeting || clientComputeGreeting(new Date())}
      </Typography>

      {isMobile ? (
        <Button
          variant="ghost"
          iconOnly={<SquarePen />}
          onClick={onStartNewChat}
          aria-label="New Chat"
          tooltip="New Chat"
          className="!rounded-full"
        />
      ) : (
        <Button
          variant="ghost"
          leftIcon={<SquarePen />}
          onClick={onStartNewChat}
        >
          New Chat
        </Button>
      )}
    </div>
  );
}
