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
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
 */
export async function drainPendingVoiceStartDeepLink(): Promise<void> {
  // No controller mounted yet — leave the request parked for the one that
  // eventually mounts. Checked before consuming so the intent is never dropped.
  if (useLiveVoiceStore.getState().starter === null) {
    return;
  }
  if (!usePendingDeepLinkStore.getState().consumePendingVoiceStart()) {
    return;
  }
  // `supportsLiveVoice` reads `false` until the identity fetch lands, and a
  // cold-launch deep link fires squarely inside that window — so resolve the
  // version first rather than gating on the conservative default (this is the
  // "gated write" case `whenAssistantVersionKnown` documents). Store
  // subscription, not a poll.
  await whenAssistantVersionKnown();
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  // Same eligibility as the composer's entry point: on an assistant too old to
  // serve live voice the link navigates and stops there, exactly as the
  // composer renders no voice button.
  if (!supportsLiveVoice(assistantId)) {
    return;
  }
  // `null` conversation is the supported "new conversation" start: the server
  // assigns one and echoes it on the `ready` frame (`LiveVoiceState.conversationId`).
  // Re-read the starter — the controller may have unmounted across the await.
  useLiveVoiceStore.getState().starter?.(assistantId, null);
}
