import { useEffect } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";

import { useIsLiveVoiceSessionOwnedBy } from "./live-voice-store";

/**
 * Surfaces a live-voice turn into the chat transcript on a brand-new / empty
 * conversation.
 *
 * On the empty-state landing the viewed conversation is a client-minted draft
 * id with no seeded history snapshot. When a voice session attaches to it, the
 * daemon persists and broadcasts the user turn (`user_message_echo`) under that
 * same draft id — but {@link useChatSessionStore}'s `applyEnvelopeToSnapshot`
 * is a no-op while the snapshot is null, so the turn is dropped and the empty
 * state never flips. The text-send path avoids this by adding an optimistic row
 * and seeding a snapshot on send; voice does neither.
 *
 * This hook is the voice analogue: when the active (viewed) conversation owns
 * the live-voice session and its snapshot is still unseeded, seed an empty one
 * so the incoming echo/stream folds in and the transcript renders in place (the
 * daemon adopts the draft id, so no navigation is needed). Seeding only when
 * the snapshot is null leaves existing conversations — whose history seeds
 * itself — untouched.
 *
 * Mounted once at layout scope (see `chat-layout.tsx`) alongside the session
 * controller so it spans every chat route.
 */
export function useSeedLiveVoiceSnapshot(): void {
  const activeConversationId = useConversationStore.use.activeConversationId();
  const ownsActiveConversation =
    useIsLiveVoiceSessionOwnedBy(activeConversationId);

  useEffect(() => {
    if (!ownsActiveConversation || activeConversationId == null) {
      return;
    }
    // Read (don't subscribe) the snapshot: seed only a genuinely unseeded
    // draft, so an existing conversation's own history seed is never clobbered.
    if (useChatSessionStore.getState().snapshot !== null) {
      return;
    }
    useChatSessionStore.getState().seedSnapshot(activeConversationId, {
      messages: [],
      seq: null,
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      processing: undefined,
    });
  }, [ownsActiveConversation, activeConversationId]);
}
