import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { DialogHeaderTile } from "@/domains/settings/billing/dialog-header-tile";
import { useTakeoverSurface } from "@/domains/settings/billing/pro-onboarding/use-takeover-surface";

// The mock places the creature at 32 × 26 inside the 52px tile — wider than the
// tile's nominal padding, which is how the art is drawn there.
const AVATAR_SIZE = 32;

/**
 * The assistant's avatar on a rounded neutral tile — the header glyph of the
 * package-switch confirm dialog. The tile holds its square while the avatar
 * query settles so the header does not reflow when the creature appears;
 * `ChatAvatar` synthesizes fallback traits, so drawing early would flash the
 * bundled green and then jump to the real color.
 */
export function AssistantAvatarTile() {
  const { ready, avatar } = useTakeoverSurface();

  return (
    <DialogHeaderTile
      data-testid="assistant-avatar-tile"
      className="bg-[var(--surface-active)]"
    >
      {ready ? (
        <ChatAvatar
          components={avatar.components}
          traits={avatar.traits}
          customImageUrl={avatar.customImageUrl}
          size={AVATAR_SIZE}
        />
      ) : null}
    </DialogHeaderTile>
  );
}
