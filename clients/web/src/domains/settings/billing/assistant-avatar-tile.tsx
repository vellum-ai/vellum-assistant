import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { DialogHeaderTile } from "@/domains/settings/billing/dialog-header-tile";
import { useActiveAssistantAvatar } from "@/hooks/use-assistant-avatar";

// The mock places the creature at 32 × 26 inside the 52px tile — wider than the
// tile's nominal padding, which is how the art is drawn there.
const AVATAR_SIZE = 32;

/**
 * The assistant's avatar on a rounded neutral tile — the header glyph of the
 * package-switch confirm dialog. The tile holds its square while the avatar
 * query settles so the header does not reflow when the creature appears.
 */
export function AssistantAvatarTile() {
  const { ready, components, traits, customImageUrl } =
    useActiveAssistantAvatar();

  return (
    <DialogHeaderTile
      data-testid="assistant-avatar-tile"
      className="bg-[var(--surface-active)]"
    >
      {ready ? (
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={AVATAR_SIZE}
        />
      ) : null}
    </DialogHeaderTile>
  );
}
