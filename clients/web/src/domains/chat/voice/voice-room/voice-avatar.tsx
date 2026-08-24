import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

import type { VoiceAvatarVisual } from "./voice-avatar-state";

const DEFAULT_SIZE = 160;

export interface VoiceAvatarProps {
  /** Assistant whose avatar to render; `null` renders the "V" fallback. */
  assistantId: string | null;
  /** Current visual mode, derived from the live-voice session phase. */
  visual: VoiceAvatarVisual;
  /** Rendered avatar diameter in px. */
  size?: number;
}

/**
 * The large, state-driven assistant avatar at the center of the live-voice
 * room. Resolves the real assistant avatar (character / custom image / "V"
 * fallback) via {@link useAssistantAvatar} and carries the session phase as a
 * `voice-avatar--<visual>` class, which idle, listening, thinking and
 * reconnecting each answer with a CSS loop (see `.voice-avatar-*` in
 * index.css). `responding` has no loop: it holds still.
 *
 * The avatar node stays mounted for the whole session, so a visual change only
 * swaps that class and the loops cross-fade in place rather than the whole
 * avatar re-popping. The one-time entry spring is owned by the room wrapper
 * (see `voice-room.tsx`), not here.
 *
 * Nothing here reads audio. Both halves of a turn are drawn as bands at the
 * room's floor, so the avatar states are the session's phase and the bands are
 * its voice: `listening` and `responding` differ by which band is up, not by
 * anything the avatar does. Reduced-motion users get the static avatar (CSS
 * loops disabled).
 */
export function VoiceAvatar({
  assistantId,
  visual,
  size = DEFAULT_SIZE,
}: VoiceAvatarProps) {
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);

  return (
    <div
      className={`voice-avatar voice-avatar--${visual}`}
      style={{ width: size, height: size }}
    >
      <ChatAvatar
        components={components}
        traits={traits}
        customImageUrl={customImageUrl}
        size={size}
      />
    </div>
  );
}
