/**
 * Start-voice deep link → live-voice session.
 *
 * The seam between the host-agnostic deep-link consumer
 * (`useGlobalDeepLinkConsumer`, mounted at `RootLayout`) and the live-voice
 * domain. The consumer knows only "the user asked to talk"; everything about
 * *how* a session starts lives here.
 *
 * Why a parked request instead of a direct call: the session `starter` is
 * registered by `useLiveVoiceSessionController`, which is mounted at
 * `ChatLayout` scope. On a cold launch (Siri, the Action Button, a Live
 * Activity tap) the deep link fires before that layout mounts, and on
 * settings / logs / account routes the controller does not exist at all. So the
 * request is parked in `usePendingDeepLinkStore` — the same one-shot inbox
 * `deeplink.send` uses for exactly this race — and the controller drains it
 * when it registers a starter. No polling, no retry timer.
 */

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { supportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import { whenAssistantVersionKnown } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
 * Ask for a live-voice session on behalf of a start-voice deep link.
 *
 * Always parks first, then drains — one code path for both the warm case (a
 * controller is already mounted, so the drain starts immediately) and the
 * cold-launch case (the drain no-ops and the controller picks the request up).
 */
export function requestVoiceStartFromDeepLink(): void {
  usePendingDeepLinkStore.getState().setPendingVoiceStart();
  void drainPendingVoiceStartDeepLink();
}

/**
 * Start a parked start-voice deep link, if there is one and a starter exists.
 * Called by {@link useLiveVoiceSessionController} right after it registers its
 * starter, and by {@link requestVoiceStartFromDeepLink} for the warm path.
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
export async function drainPendingVoiceStartDeepLink(): Promise<void> {
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
  // Every remaining branch is a decision rather than a race, so the request is
  // spent from here — and nothing below awaits, so it cannot be lost between
  // the consume and the start.
  if (
    !usePendingDeepLinkStore
      .getState()
      .consumePendingVoiceStart(PENDING_VOICE_START_TTL_MS)
  ) {
    return;
  }
  // Same eligibility as the composer's entry point: on an assistant too old to
  // serve live voice the link navigates and stops there, exactly as the
  // composer renders no voice button.
  if (!supportsLiveVoice(assistantId)) {
    return;
  }
  // `null` conversation is the supported "new conversation" start: the server
  // assigns one and echoes it on the `ready` frame (`LiveVoiceState.conversationId`).
  //
  // No `prewarm()` here, unlike the composer: prewarming exists to unlock
  // playback while a user gesture is still active, and this path has no gesture
  // to borrow (Siri, the Action Button, a Live Activity tap). `start()` creates
  // its own player when none was reserved.
  starter.start(assistantId, null);
}
