import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { DialogHeaderTile } from "@/domains/settings/billing/dialog-header-tile";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
  const activeId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits, customImageUrl, isLoading } =
    useAssistantAvatar(activeId);
  // `useAssistantAvatar(null)` is a disabled query, which reports
  // `isLoading: false` with no data, so the id has to gate drawing too.
  const ready = activeId != null && !isLoading;

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
