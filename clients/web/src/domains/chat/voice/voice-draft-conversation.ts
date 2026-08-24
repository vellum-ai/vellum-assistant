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
 */

import { prepareFreshConversation } from "@/utils/conversation-navigation";

/**
 * Mint a fresh draft conversation, select it, and bring the chat on screen.
 * Returns the draft's id, which is the key its composer is bound to.
 *
 * Runs the same preparation as {@link navigateToNewConversation}, and for the
 * same reasons: a voice call opened from outside the chat is as new a
 * conversation as one started from the new-chat button, so it must not inherit
 * the previous thread's side panels or its still-running subagent and workflow
 * cards. What differs is only the navigation, which stays at the call site.
 */
export function mintVoiceDraftConversation(): string {
  return prepareFreshConversation();
}
