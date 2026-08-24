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
 * Bringing the chat on screen is part of the mint rather than a step after it.
 * On desktop the composer counts as on screen only while the main view is not
 * the fullscreen app viewer ({@link useComposerOnScreen}), so a draft minted
 * behind that viewer would be a conversation with no composer to speak into.
 * It goes through {@link revealConversationView} for the same reason every
 * other new-conversation path does: an app already open on a wide viewport
 * keeps its side-by-side layout with the draft as the chat pane, and
 * `app-editing` still counts as on screen, so the voice room opens either way.
 */

import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { revealConversationView } from "@/utils/conversation-navigation";

/**
 * Mint a fresh draft conversation, select it, and bring the chat on screen.
 * Returns the draft's id, which is the key its composer is bound to.
 *
 * The transcript side panels are cleared with it, exactly as
 * {@link navigateToNewConversation} does: a files or tool-detail panel opened
 * against the previous conversation is about messages this draft does not
 * have, so carrying it over shows the new chat someone else's payload.
 */
export function mintVoiceDraftConversation(): string {
  const draftId = createDraftConversationId();
  useConversationStore.getState().setActiveConversationId(draftId);
  useViewerStore.getState().clearTranscriptPanelPayloads();
  revealConversationView(draftId);
  return draftId;
}
