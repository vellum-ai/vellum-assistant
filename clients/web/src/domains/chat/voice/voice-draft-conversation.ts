/**
 * The one place voice mints a conversation to talk into.
 *
 * Voice is reachable from surfaces that hold no composer key: a
 * `<scheme>://voice` link (a widget button, the Action Button, Control Center,
 * a Siri shortcut), the Talk shortcut, push-to-talk on a route with nothing
 * selected. Each of them needs the same thing from a new key, so the sequence
 * lives here rather than once per entry point and the entries cannot drift
 * into different ideas of what a fresh chat is.
 *
 * What differs between them is *when* they want one, which stays at the call
 * site: the start-voice drain mints unconditionally (a start asked for from
 * outside the chat is a new call), while push-to-talk dictates into whatever
 * conversation is already selected and only mints when none is.
 *
 * `setMainView("chat")` is part of the mint rather than a step after it. On
 * desktop the composer counts as on screen only while the main view is the
 * chat ({@link useComposerOnScreen}), so a draft minted behind the app viewer
 * would be a conversation with no composer to speak into.
 */

import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Mint a fresh draft conversation, select it, and put the chat on screen.
 * Returns the draft's id, which is the key its composer is bound to.
 */
export function mintVoiceDraftConversation(): string {
  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);
  useViewerStore.getState().setMainView("chat");
  return draftId;
}
