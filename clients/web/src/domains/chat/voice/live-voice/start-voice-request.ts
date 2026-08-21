/**
 * "The user asked to talk" → live-voice session.
 *
 * The seam between the surfaces that can ask for a session from outside the
 * chat layout and the live-voice domain. Three ask today: the host-agnostic
 * deep-link consumer (`useGlobalDeepLinkConsumer`, mounted at `RootLayout`),
 * the macOS companion surface's Talk, which arrives as a `startVoice` command
 * from the Electron host, and the voice mode shortcut
 * (`useVoiceModeHotkey`). None of them knows anything about sessions;
 * everything about *how* one starts lives here, so they cannot drift into
 * three ideas of what talking means.
 *
 * Why a parked request instead of a direct call: the session `starter` is
 * registered by `useLiveVoiceSessionController`, which is mounted at
 * `ChatLayout` scope. On a cold launch (Siri, the Action Button, a Live
 * Activity tap) the deep link fires before that layout mounts, and on
 * settings / logs / account routes the controller does not exist at all. So the
 * request is parked in `usePendingDeepLinkStore` (the one-shot inbox
 * `deeplink.send` uses for exactly this race) and the controller drains it
 * when it registers a starter. No polling, no retry timer.
 */

import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  firstRunCardIntercepts,
  publishConfigNotice,
  voiceReadiness,
} from "@/domains/chat/voice/live-voice/voice-entry-guards";
import { supportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { whenAssistantVersionKnown } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/**
 * How long a parked start-voice request stays live.
 *
 * The park exists for one race — a deep link that lands before `ChatLayout`
 * mounts — which resolves in seconds or not at all. Without a bound it never
 * expires: a link whose `navigate(routes.assistant)` is bounced by a route
 * guard (unauthenticated, mid-onboarding) leaves the request sitting there
 * until some unrelated `ChatLayout` mount drains it and a full-screen voice
 * session opens out of nowhere. A minute is far longer than any legitimate
 * cold launch and far shorter than "later".
 */
export const PENDING_VOICE_START_TTL_MS = 60_000;

/**
 * Ask for a live-voice session.
 *
 * Always parks first, then drains: one code path for both the warm case (a
 * controller is already mounted, so the drain starts immediately) and the
 * cold-launch case (the drain no-ops and the controller picks the request up).
 */
export function requestVoiceStart(): void {
  usePendingDeepLinkStore.getState().setPendingVoiceStart();
  void drainPendingVoiceStart();
}

/**
 * Start a session on behalf of a surface that is not the chat composer: the
 * companion surface's Talk and the voice mode shortcut.
 *
 * Both are presses made from outside the conversation, and both mean the same
 * thing by it, so they run the same three steps rather than each growing its
 * own idea of what the press does:
 *
 * - **A session already running spends the press.** That session is the one
 *   the user is in; the starter refuses a second anyway, and navigating would
 *   only walk the app away from the composer that owns it. Callers that toggle
 *   handle the end themselves before reaching here.
 * - **The draft composer, so the session starts with no conversation** and the
 *   server assigns one on `ready`. Navigating is also what mounts `ChatLayout`
 *   and therefore the starter the request is waiting for.
 * - **The window is not raised for an ordinary start.** Every caller is a
 *   surface the user reached for precisely because they are working somewhere
 *   else, and that surface is where the call then shows itself. The one
 *   exception is the first-run card below: it asks a question, and a question
 *   drawn behind whatever the user is working in is a press that did nothing.
 */
export function startVoiceFromSurface(navigate: (to: string) => unknown): void {
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    return;
  }
  void navigate(routes.assistant);
  requestVoiceStart();
}

/**
 * Start a parked start-voice request, if there is one and a starter exists.
 * Called by {@link useLiveVoiceSessionController} right after it registers its
 * starter, and by {@link requestVoiceStart} for the warm path.
 * A no-op when nothing is parked, so the repeat calls are free.
 *
 * **The park is consumed last.** Everything before the consume is a *precondition
 * that can still become true* — no starter yet, an identity fetch that has not
 * landed, a controller that unmounted across the await — and on each of those
 * the request stays parked for the next drain rather than being thrown away
 * with nothing to show for it. Consuming up front would drop the command
 * outright on exactly the slowest path there is: a cold Siri / Action-Button
 * launch against a hibernating assistant, where the version resolution can hit
 * its timeout with `version` still `null`.
 */
export async function drainPendingVoiceStart(): Promise<void> {
  if (usePendingDeepLinkStore.getState().pendingVoiceStartAt === null) {
    return;
  }
  // No controller mounted yet — leave the request parked for the one that
  // eventually mounts.
  if (useLiveVoiceStore.getState().starter === null) {
    return;
  }
  // `supportsLiveVoice` reads `false` until the identity fetch lands, and a
  // cold-launch deep link fires squarely inside that window — so resolve the
  // version first rather than gating on the conservative default (this is the
  // "gated write" case `whenAssistantVersionKnown` documents). Store
  // subscription, not a poll.
  await whenAssistantVersionKnown();
  // Resolved by timing out, not by hydrating. The gate below would read the
  // conservative `false` and discard a request the user really made, so leave
  // it parked instead.
  if (useAssistantIdentityStore.getState().version === null) {
    return;
  }
  // Re-read: the controller may have unmounted across the await, leaving no
  // starter to hand this to. The next mount will drain it.
  const starter = useLiveVoiceStore.getState().starter;
  if (starter === null) {
    return;
  }
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  // Every remaining branch is a decision rather than a race, so each of them
  // spends the request. The consume itself stays at the bottom, below the last
  // await, so the one thing that can still become true — a controller that has
  // not registered yet — leaves the request parked rather than losing it.
  const consume = (): boolean =>
    usePendingDeepLinkStore
      .getState()
      .consumePendingVoiceStart(PENDING_VOICE_START_TTL_MS);
  // Same eligibility as the composer's entry point: on an assistant too old to
  // serve live voice the link navigates and stops there, exactly as the
  // composer renders no voice button.
  if (!supportsLiveVoice(assistantId)) {
    consume();
    return;
  }
  // The same two guards the composer's voice button runs. Without them a
  // session asked for from outside the chat window skipped the first-run card
  // and opened a room the composer would have refused. Each hands the entry to
  // something the user can see (the card, the notice), so each is an answer
  // rather than a drop.
  if (firstRunCardIntercepts()) {
    // **The one entry here that raises the app.** The card is a decision, and
    // it is drawn in the app's window; a press from the companion leaves that
    // window behind whatever the user is actually working in, so the press
    // reads as having done nothing at all. Raising is the whole point of the
    // beat: there is something to answer. Fire and forget, since nothing below
    // depends on the window being up.
    void ensureMainWindowVisible();
    consume();
    return;
  }
  const readiness = await voiceReadiness(assistantId);
  publishConfigNotice(readiness.notice);
  if (!readiness.allowed) {
    consume();
    return;
  }
  // Re-read across the readiness await, as above: a controller that unmounted
  // during the preflight leaves this parked for the next mount.
  const readyStarter = useLiveVoiceStore.getState().starter;
  if (readyStarter === null) {
    return;
  }
  if (!consume()) {
    return;
  }
  // `null` conversation is the supported "new conversation" start: the server
  // assigns one and echoes it on the `ready` frame (`LiveVoiceState.conversationId`).
  //
  // No `prewarm()` here, unlike the composer: prewarming exists to unlock
  // playback while a user gesture is still active, and this path has no gesture
  // to borrow (Siri, the Action Button, a Live Activity tap). `start()` creates
  // its own player when none was reserved.
  readyStarter.start(assistantId, null);
}
