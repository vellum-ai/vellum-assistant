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
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoiceEntry } from "@/domains/chat/voice/live-voice/protocol";
import {
  firstRunCardIntercepts,
  publishConfigNotice,
  voiceReadiness,
} from "@/domains/chat/voice/live-voice/voice-entry-guards";
import { mintVoiceDraftConversation } from "@/domains/chat/voice/voice-draft-conversation";
import { formatVoiceError } from "@/domains/chat/utils/chat";
import { supportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import { endVoiceActivity } from "@/runtime/desktop-voice-activity";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { whenAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { toast } from "@vellumai/design-library/components/toast";
import { VOICE_START_REQUEST_TTL_MS } from "@vellumai/ipc-contract";

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
 *
 * The contract's number, because the companion's dial is drawn against it:
 * the shell holds the dial for longer than this, so a request that could
 * still become a session is never one the pill has stopped showing.
 */
export const PENDING_VOICE_START_TTL_MS = VOICE_START_REQUEST_TTL_MS;

/**
 * The navigation a start needs from its caller: a path, and whether it
 * replaces the entry it lands on.
 *
 * Structural rather than react-router's `NavigateFunction` so a caller can
 * hand over a wrapper that reads its own `navigate` ref. The drain navigates
 * after two awaits, by which time a captured `navigate` may belong to a
 * location the app has moved on from.
 */
export type VoiceStartNavigate = (
  to: string,
  options?: { replace?: boolean },
) => unknown;

/**
 * The conversation a start-voice request opens into: a fresh draft, always.
 *
 * Never whatever the conversation store has selected. That selection survives
 * navigation and cold launches by design, so it is wherever the user last was,
 * while every surface that reaches this drain means *new*: the widget button,
 * the Action Button, Control Center, a Siri shortcut, the Talk shortcut.
 * Reading it would attach the call to an unrelated thread.
 *
 * Landing on the draft is the other half of the binding rather than a nicety.
 * A session is owned by the composer bound to its conversation
 * ({@link isLiveVoiceSessionOwnedBy}), and the composer on screen is the one
 * the URL names, so a draft minted while the URL sits elsewhere is a session
 * nothing on screen owns, leaving the title-bar pill standing in for the room
 * the user asked for. `replace` because the entry it overwrites is the
 * `routes.assistant` step on the way here, not a place the user chose.
 *
 * The conversation loader lands on the same draft rather than fighting this:
 * the id is in the store before the navigation, and the URL key it resolves
 * next is that same id.
 */
function bindFreshConversation(navigate: VoiceStartNavigate): string {
  const draftId = mintVoiceDraftConversation();
  void navigate(routes.conversation(draftId), { replace: true });
  return draftId;
}

/**
 * What a start-voice request carries besides the request itself.
 */
export interface VoiceStartRequestOptions {
  /**
   * Which control asked for the session. Required, because it is the one
   * thing the drain cannot work out for itself: by the time the request is
   * served, the press that made it is long gone.
   */
  entry: LiveVoiceEntry;
  /**
   * A question to put to the session as its first turn, spoken back and then
   * done: the session ends once the reply has been heard. For a press that
   * already knows what the user wants to say, such as a hold made over a
   * selection. The turn is the user's own words, so it renders as theirs.
   */
  ask?: string;
}

/**
 * Ask for a live-voice session.
 *
 * Always parks first, then drains: one code path for both the warm case (a
 * controller is already mounted, so the drain starts immediately) and the
 * cold-launch case (the drain no-ops and the controller picks the request up).
 *
 * `navigate` serves the warm case only. A parked request is drained by the
 * controller, which navigates with its own.
 */
export function requestVoiceStart(
  navigate: VoiceStartNavigate,
  options: VoiceStartRequestOptions,
): void {
  usePendingDeepLinkStore.getState().setPendingVoiceStart({
    entry: options.entry,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
  });
  void drainPendingVoiceStart(navigate);
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
 * - **The chat, so the layout that owns the starter is mounted.** That is all
 *   this navigation is for: the drain mints the conversation the session binds
 *   to and lands on it from here.
 * - **The window is not raised for an ordinary start.** Every caller is a
 *   surface the user reached for precisely because they are working somewhere
 *   else, and that surface is where the call then shows itself. The one
 *   exception is the first-run card below: it asks a question, and a question
 *   drawn behind whatever the user is working in is a press that did nothing.
 */
export function startVoiceFromSurface(
  navigate: VoiceStartNavigate,
  options: VoiceStartRequestOptions,
): void {
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    return;
  }
  void navigate(routes.assistant);
  requestVoiceStart(navigate, options);
}

/**
 * Start a session, or end the one that is running: the keyboard's version of
 * Talk.
 *
 * A key differs from a button in one way: the same press has to undo itself,
 * because a global gesture is often the only voice control within reach of
 * someone working in another app. Talk stays start-only, since the surface
 * that draws it also draws a way to stop. Both the voice mode shortcut and
 * the voice key's double tap come through here, so the two cannot drift.
 */
export function toggleVoiceFromSurface(
  navigate: VoiceStartNavigate,
  entry: LiveVoiceEntry,
): void {
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    endLiveVoiceSession();
    return;
  }
  startVoiceFromSurface(navigate, { entry });
}

/**
 * Take back a start that has been asked for and not yet served.
 *
 * What ending the companion's dial means: the request behind it is either
 * still parked or partway through its preflight, and spending it here is what
 * stops that preflight from opening the room a second after the user closed
 * the pill. Reached through the `cancelVoiceStart` command, which the root
 * layout consumes on every route, so the press lands whether or not the
 * layout that owns sessions is mounted yet. The companion itself closes on
 * the press; this is the half it cannot reach.
 */
export function cancelPendingVoiceStart(): void {
  usePendingDeepLinkStore
    .getState()
    .consumePendingVoiceStart(PENDING_VOICE_START_TTL_MS);
}

/**
 * Say that a question asked out loud could not be taken.
 *
 * The question came from another application, and the answer was going to
 * come back through the companion. A notice drawn in the app's window sits
 * behind whatever the user is working in, so this is the one refusal that
 * raises the window: the alternative is a hold that did nothing.
 */
export function announceAskRefused(): void {
  void ensureMainWindowVisible();
  toast.error(formatVoiceError("voice-ask-unavailable"), {
    id: "voice-error:voice-ask-unavailable",
  });
}

/**
 * Put a question to the assistant out loud, from a surface outside the chat.
 *
 * A session already running is the one the user is in, so the question goes
 * to it as a turn and the session carries on as it was. Otherwise one is
 * started for the question alone: it asks, the reply is spoken, and it ends,
 * so a question asked from another application does not leave the user on an
 * open call they did not reach for.
 *
 * Returns whether the question was taken. A running session that cannot take
 * typed turns (an older assistant) declines rather than dropping the words
 * silently.
 */
export function askVoiceFromSurface(
  navigate: VoiceStartNavigate,
  ask: string,
  entry: LiveVoiceEntry,
): boolean {
  const store = useLiveVoiceStore.getState();
  if (isLiveVoiceSessionActive(store.state)) {
    return store.starter?.sendText(ask) === true;
  }
  void navigate(routes.assistant);
  requestVoiceStart(navigate, { entry, ask });
  return true;
}

/**
 * Start a parked start-voice request, if there is one and a starter exists.
 * Called by {@link useLiveVoiceSessionController} right after it registers its
 * starter and again whenever the active assistant changes, and by
 * {@link requestVoiceStart} for the warm path.
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
export async function drainPendingVoiceStart(
  navigate: VoiceStartNavigate,
): Promise<void> {
  if (usePendingDeepLinkStore.getState().pendingVoiceStartAt === null) {
    return;
  }
  // No controller mounted yet — leave the request parked for the one that
  // eventually mounts.
  if (useLiveVoiceStore.getState().starter === null) {
    return;
  }
  // Who a fresh start means, read before the wait below rather than after it,
  // because the wait is scoped to this assistant.
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  // `supportsLiveVoice` reads `false` until the identity fetch lands, and a
  // cold-launch deep link fires squarely inside that window, so resolve the
  // version first rather than gating on the conservative default (this is the
  // "gated write" case `whenAssistantVersionKnownFor` documents). Store
  // subscription, not a poll.
  //
  // Scoped to `assistantId`, because the eligibility gate below is: it checks
  // the hydrated version's *owner*, and the unscoped wait is satisfied by a
  // version still held for the assistant the user just left. That is not an
  // edge case here. The other trigger for this drain is the assistant switch
  // itself, which fires on the resolved-assistants change, ahead of the
  // identity store being cleared and rehydrated for the assistant switched to,
  // so an unscoped wait would resolve instantly on the previous assistant's
  // version and the owner check would then read the request as unsupported and
  // throw a press the user really made away.
  await whenAssistantVersionKnownFor(assistantId);
  // Resolved by timing out, not by this assistant's identity hydrating. The
  // gate below would read the conservative `false` and discard a request the
  // user really made, so leave it parked instead: the wait is bounded well
  // inside the park's TTL, and the next drain runs everything again against
  // whoever is active by then.
  const identity = useAssistantIdentityStore.getState();
  if (identity.version === null || identity.assistantId !== assistantId) {
    return;
  }
  // Re-read: the controller may have unmounted across the await, leaving no
  // starter to hand this to. The next mount will drain it.
  const starter = useLiveVoiceStore.getState().starter;
  if (starter === null) {
    return;
  }
  // Every branch from here that is a decision rather than a race spends the
  // request. The consume itself stays at the bottom, below the last await, so
  // the things that can still become true (a controller that has not
  // registered yet, an assistant switched away from mid-preflight) leave the
  // request parked rather than losing it.
  const consume = () =>
    usePendingDeepLinkStore
      .getState()
      .consumePendingVoiceStart(PENDING_VOICE_START_TTL_MS);
  // A plain start that stops here has handed the user something to look at
  // instead (no button, the card, the notice). A question that stops here has
  // been dropped, and the user who asked it from another application is
  // watching the companion for an answer, so the drop is said where they can
  // see it.
  //
  // Either way the companion is told. Its Talk draws a dial the moment it is
  // pressed and holds it until a session answers, and a refusal is the answer
  // "none is coming": with no session running, `end` is exactly that, and the
  // pill closes on it rather than on a timeout. Only for a request actually
  // spent here: the drain runs on every mount and every switch of assistant,
  // and a refusal of nothing is not an answer to anything.
  const refuse = () => {
    const consumed = consume();
    if (consumed === null) {
      return;
    }
    if (consumed.ask !== null) {
      announceAskRefused();
    }
    endVoiceActivity();
  };
  // Same eligibility as the composer's entry point: on an assistant too old to
  // serve live voice the link navigates and stops there, exactly as the
  // composer renders no voice button.
  if (!supportsLiveVoice(assistantId)) {
    refuse();
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
    refuse();
    return;
  }
  const readiness = await voiceReadiness(assistantId);
  // Everything below decides on state read before a network round trip, so
  // re-read it first. This is the same re-check the composer's voice button
  // runs across its own preflight, and for the same reason: the tail of this
  // drain navigates and mints, and doing either against state the app has
  // moved on from walks the user away from what they are actually doing. The
  // notice waits until after the guards too, so an answer about the assistant
  // the user left never surfaces against the one they moved to.
  //
  // A session started from the composer mid-preflight is the session the user
  // is in, so the press is spent exactly as `startVoiceFromSurface` spends one
  // it finds already running: the starter would refuse a second anyway, and
  // navigating would only leave the composer that owns it.
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    // That session is the one the user is in, so a question goes to it.
    const ask = consume()?.ask ?? null;
    if (
      ask !== null &&
      useLiveVoiceStore.getState().starter?.sendText(ask) !== true
    ) {
      announceAskRefused();
    }
    return;
  }
  // A switch to another assistant mid-preflight, on the other hand, is a race
  // rather than a decision: both the eligibility gate and this verdict answered
  // for an assistant that is no longer the one a fresh start means. Nothing has
  // been navigated or minted yet, so the request stays parked and the next
  // drain runs both against whoever is active by then. That next drain is the
  // switch itself: `useLiveVoiceSessionController` runs one on every change of
  // active assistant, so the repark is a retry rather than a wait for the TTL.
  if (useResolvedAssistantsStore.getState().activeAssistantId !== assistantId) {
    return;
  }
  publishConfigNotice(readiness.notice);
  if (!readiness.allowed) {
    refuse();
    return;
  }
  // Re-read across the readiness await, as above: a controller that unmounted
  // during the preflight leaves this parked for the next mount.
  const readyStarter = useLiveVoiceStore.getState().starter;
  if (readyStarter === null) {
    return;
  }
  const consumed = consume();
  if (consumed === null) {
    return;
  }
  // No `prewarm()` here, unlike the composer: prewarming exists to unlock
  // playback while a user gesture is still active, and this path has no gesture
  // to borrow (Siri, the Action Button, a Live Activity tap). `start()` creates
  // its own player when none was reserved.
  const conversationId = bindFreshConversation(navigate);
  // The control that parked the request, carried to the daemon's telemetry.
  // Absent only from a park written by code that predates the field.
  const entry = consumed.entry ? { entry: consumed.entry } : {};
  if (consumed.ask === null) {
    readyStarter.start(assistantId, conversationId, entry);
    return;
  }
  // The question is the user's own words, so it renders as theirs, and the
  // session is for the question alone: it ends once the reply has been heard.
  readyStarter.start(assistantId, conversationId, {
    ...entry,
    seedText: consumed.ask,
    seedVisible: true,
    endAfterSeedReply: true,
  });
}
