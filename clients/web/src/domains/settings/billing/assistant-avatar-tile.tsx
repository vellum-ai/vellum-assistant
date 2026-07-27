import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useTakeoverSurface } from "@/domains/settings/billing/pro-onboarding/use-takeover-surface";
import { cn } from "@/utils/misc";

export interface AssistantAvatarTileProps {
  /** Avatar diameter in px, inside the tile's padding. */
  size?: number;
  className?: string;
}

/**
 * The assistant's avatar on a rounded neutral tile — the header glyph for
 * billing dialogs. The tile holds its square while the avatar query settles so
 * the header does not reflow when the creature appears; `ChatAvatar`
 * synthesizes fallback traits, so drawing early would flash the bundled green
 * and then jump to the real color.
 */
export function AssistantAvatarTile({
  size = 24,
  className,
}: AssistantAvatarTileProps) {
  const { ready, avatar } = useTakeoverSurface();

  return (
    <div
      aria-hidden
      data-testid="assistant-avatar-tile"
      className={cn(
        "flex size-[52px] shrink-0 items-center justify-center rounded-xl bg-[var(--surface-active)]",
        className,
      )}
    >
      {ready ? (
        <ChatAvatar
          components={avatar.components}
          traits={avatar.traits}
          customImageUrl={avatar.customImageUrl}
          size={size}
        />
      ) : null}
    </div>
  );
}
