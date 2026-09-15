/**
 * Provenance marker for a `?prompt=` navigation the app issued itself.
 *
 * `?prompt=<text>` is how a conversation URL carries a message to seed the
 * chat with. It has two kinds of author:
 *
 * - **In-app code**: the quick input, document feedback, the app-viewer
 *   relay, onboarding suggestions, `PromptLaunchButton`. These navigate with
 *   `navigate()` and intend the message to be sent on the user's behalf.
 * - **A link the user clicked**: the marketing "open in Vellum" menus, the
 *   Day-2 check-in email, or any page a user was sent a URL from. Nothing
 *   vouches for that text, so it must only pre-fill the composer and leave
 *   the send to the user. This is the same call the native deep-link path
 *   already makes (`pendingComposerMessage` is pre-fill only by design).
 *
 * Router history state tells the two apart. In-app callers attach this marker
 * to the navigation they issue; a URL opened from outside the SPA (new tab,
 * email, another site) lands with `location.state === null`, and a
 * cross-origin page cannot write history state on this origin. So the chat
 * view auto-sends only when the marker is present and pre-fills otherwise.
 */

const AUTO_SEND_PROMPT_STATE_KEY = "autoSendPrompt";

/**
 * History state for a `?prompt=` navigation that should auto-send. Merges
 * onto `state` so callers that already carry state (the document return
 * entry, say) keep it.
 */
export function autoSendPromptState(state?: unknown): Record<string, unknown> {
  const base =
    state !== null && typeof state === "object"
      ? (state as Record<string, unknown>)
      : {};
  return { ...base, [AUTO_SEND_PROMPT_STATE_KEY]: true };
}

/** Whether `state` carries the in-app auto-send marker. */
export function hasAutoSendPromptState(state: unknown): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    (state as Record<string, unknown>)[AUTO_SEND_PROMPT_STATE_KEY] === true
  );
}
