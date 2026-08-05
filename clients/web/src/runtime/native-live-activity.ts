/**
 * JS ↔ native bridge for the `VoiceLiveActivity` Capacitor plugin implemented
 * by both mobile shells.
 *
 * The plugin mirrors a running live-voice session into the platform status
 * surface: an ActivityKit Live Activity on iOS or an ongoing notification on
 * Android. It holds at most one surface, so calling
 * {@link startVoiceLiveActivity} twice updates the running one.
 *
 * **Skew contract.** An installed mobile shell may not include this plugin.
 * Every call therefore returns its fallback outside a native mobile shell and
 * goes through {@link callNativeVoice} on mobile. The status surface is
 * optional and must never block or end a voice session.
 *
 * That fallback also covers the case where the user has turned Live Activities
 * off for the app in iOS Settings — the plugin reports that as
 * {@link startVoiceLiveActivity} resolving `false`, never as an error. There is
 * no separate availability probe: `start` resolving `false` already covers
 * every "no island here" case, and a probe that can itself be absent just moves
 * the problem.
 *
 * Reference: https://developer.apple.com/documentation/activitykit/activity
 */

import { registerPlugin } from "@capacitor/core";

import type { ActiveLiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  callNativeVoice,
  subscribeNativeVoiceListener,
} from "@/runtime/native-voice";
import {
  isNativeIOS,
  isNativeMobile,
} from "@/runtime/platform-detection";

/** The mutable half of the activity — everything that can change mid-session. */
export interface VoiceLiveActivityContent {
  /**
   * Session phase the island renders — exactly the phases of a *running*
   * session, which is why the type is `isLiveVoiceSessionActive`'s narrowed
   * result rather than a restated union that could drift from it. `idle` is the
   * absence of a session and `failed` ends the activity rather than rendering
   * as a phase, so neither has an island to appear on.
   *
   * These raw strings cross the bridge and are decoded by
   * `VoiceSessionAttributes.ContentState.Phase` in
   * `clients/ios/App/App/Shared/VoiceSessionAttributes.swift`. **The two must
   * change together**: a value added or renamed here without a matching Swift
   * case fails to decode on the native side.
   */
  phase: ActiveLiveVoiceSessionState;
  /**
   * User-facing activity copy. Pass
   * `liveVoiceSurfaceLabel(state, reconnecting, assistantAudioActive)` so the
   * island shows exactly what the voice room shows; the native side
   * deliberately owns no phase wording of its own.
   */
  label: string;
  /** Avatar accent as `#RRGGBB`. Unparseable values fall back to a neutral gray natively. */
  accentHex: string;
  muted: boolean;
  /**
   * Whether the assistant's audio is muted — the state the island's speaker
   * button renders against.
   *
   * Only this local path carries it; the APNs path composes content from what
   * `live-activity-push-registration.ts` registered, which does not include it,
   * so a server-driven island shows the assistant as audible until this layer
   * wakes and pushes.
   *
   * The *action* survives that gap — each button sends the state its own label
   * promised, so a press against a stale island is a no-op rather than an
   * inversion (see {@link VoiceLiveActivityControlAction}). The *display* does
   * not: until the registration carries this field, a server-driven island can
   * show the assistant as audible while it is muted. See
   * `VoiceSessionAttributes.swift`.
   */
  outputMuted: boolean;
  /**
   * One short line describing what the current turn is doing ("Reading a
   * file"), or `""` for none. Pass the live-voice store's `activityLabel`
   * verbatim: the daemon words it so that this local push and the APNs push it
   * dispatches carry identical content.
   */
  detail: string;
  /**
   * The confirmation the turn is waiting on, or `""` when it is waiting on
   * none. Non-empty is what puts Approve/Deny on the island's roomy
   * presentations, and the id travels with them so a decision answers the
   * request the user was shown.
   *
   * Local path only, like `outputMuted`: the APNs path composes content from
   * the push registration, which has no approval in it, so an island being
   * driven by the server while this layer is suspended reports the wait in
   * `detail` (the daemon words both) but offers no buttons. That is the honest
   * degradation rather than a gap — a suspended web layer is exactly the state
   * in which nothing here could act on a press anyway.
   */
  approvalRequestId: string;
}

/** {@link VoiceLiveActivityContent} plus the fields fixed for the activity's lifetime. */
export interface VoiceLiveActivityStart extends VoiceLiveActivityContent {
  assistantName: string;
  /**
   * The assistant's avatar as base64 PNG or JPEG, sized to fit ActivityKit's
   * payload ceiling by `encodeAvatarForIsland`. Omitted when there is no
   * avatar or none small enough, which the island renders as its accent glyph.
   *
   * An attribute rather than content: it is fixed for the activity's lifetime,
   * so it is sent once at `start` and never re-sent. Pushing image bytes
   * through `update` would burn the ActivityKit update budget this module's
   * caller works to stay inside.
   */
  avatarBase64?: string;
}

/** The `liveActivityPushToken` event payload. */
export interface VoiceLiveActivityPushToken {
  /** APNs device token for the running activity, hex-encoded. */
  token: string;
}

/**
 * What an island button asks of the session.
 *
 * Each mute is **absolute — the state the button's own label promised** — not a
 * toggle. The island renders content that can be seconds old, and on the APNs
 * path is composed without `outputMuted` at all, so the two disagree exactly
 * when it matters. A toggle resolved against live session state is
 * self-consistent and still wrong for the user: a button reading "Mute
 * assistant" over an already-muted session would unmute. Sending what the
 * button said makes that press a no-op instead, which the next push corrects.
 *
 * Mirrors `VoiceSessionControlAction` in
 * `clients/ios/App/App/Shared/VoiceSessionControlIntent.swift`; the raw strings
 * cross the bridge, so **the two must change together**.
 */
export type VoiceLiveActivityControlAction =
  | "muteMicrophone"
  | "unmuteMicrophone"
  | "muteAssistantAudio"
  | "unmuteAssistantAudio"
  | "endSession"
  | "approveRequest"
  | "denyRequest";

/** The `liveActivityControl` event payload. */
export interface VoiceLiveActivityControl {
  action: VoiceLiveActivityControlAction;
  /**
   * The confirmation an `approveRequest` / `denyRequest` press was drawn
   * against; absent on every other action.
   *
   * The same principle as the absolute mutes, carried one step further. A mute
   * that arrives stale is a no-op the next push corrects; an approval that
   * arrived stale would answer a *different question* than the one the user
   * was shown — the request it named may since have been decided in the app,
   * timed out, or been superseded. So the press names its request, and the
   * consumer answers that one or drops the press entirely.
   */
  requestId?: string;
}

interface VoiceLiveActivityPlugin {
  start(options: VoiceLiveActivityStart): Promise<{ started: boolean }>;
  update(content: VoiceLiveActivityContent): Promise<void>;
  end(): Promise<void>;
  addListener(
    eventName: "liveActivityPushToken",
    handler: (event: VoiceLiveActivityPushToken) => void,
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    eventName: "liveActivityControl",
    handler: (event: VoiceLiveActivityControl) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

const VoiceLiveActivity =
  registerPlugin<VoiceLiveActivityPlugin>("VoiceLiveActivity");

async function callVoiceLiveActivity<T>(
  invoke: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!isNativeMobile()) {
    return fallback;
  }
  return callNativeVoice(invoke, fallback);
}

/**
 * Show a Live Activity for a session that just became active. Resolves whether
 * one is now running. Returns `false` off native mobile, on a shell without
 * the plugin, and when the user has disabled the platform status surface.
 *
 * Safe to call when one is already running: the plugin updates it rather than
 * requesting a second island. Pair every call with {@link endVoiceLiveActivity}
 * — an activity that outlives its session sits on the Lock Screen showing a
 * phase nothing is driving.
 */
export async function startVoiceLiveActivity(
  options: VoiceLiveActivityStart,
): Promise<boolean> {
  return callVoiceLiveActivity(async () => {
    // Only the result crosses this `async` boundary, never `VoiceLiveActivity`
    // itself: per `docs/CAPACITOR.md` § "Capacitor plugins must be destructured
    // inline", a plugin Proxy in a Promise-resolution context dispatches a
    // native `then()` that never resolves and hangs the caller forever.
    const { started } = await VoiceLiveActivity.start(options);
    // Normalized rather than returned raw — the bridge payload is untyped at
    // runtime, and a shell that answers `{}` must read as "not running".
    return started === true;
  }, false);
}

/**
 * Push new content to the running activity. A no-op when none is running,
 * off native mobile, and on an older shell. Never throws.
 *
 * ActivityKit rate-limits updates, so callers must push only on an actual
 * {@link VoiceLiveActivityContent} change — never on high-frequency store
 * fields such as input amplitude.
 */
export async function updateVoiceLiveActivity(
  content: VoiceLiveActivityContent,
): Promise<void> {
  return callVoiceLiveActivity(async () => {
    await VoiceLiveActivity.update(content);
  }, undefined);
}

/**
 * Dismiss the platform status surface at the end of a session. A no-op when
 * none is running, off native mobile, and on an older shell. Never throws.
 */
export async function endVoiceLiveActivity(): Promise<void> {
  return callVoiceLiveActivity(async () => {
    await VoiceLiveActivity.end();
  }, undefined);
}

/**
 * Subscribe to the ActivityKit push token for the running activity, returning
 * an unsubscribe.
 *
 * The token is what lets the *server* update the island. Every local push in
 * this module originates on the JS main thread, which WebKit throttles and
 * eventually suspends once the app is backgrounded — the only state in which
 * the island is ever on screen. Registering this token with the platform gives
 * the session a second path to the same activity, one that does not need this
 * web view to be running at all.
 *
 * Fires more than once: iOS may rotate a token mid-activity, and each value
 * invalidates the last, so treat every event as "re-register this".
 *
 * `addListener` is one of the few property names the Capacitor plugin Proxy
 * does not trap into a fabricated native method, so calling it on a shell
 * without the plugin is safe — it simply never fires, which is the correct
 * degradation for a shell too old to mint a token.
 */
export function subscribeVoiceLiveActivityPushToken(
  handler: (event: VoiceLiveActivityPushToken) => void,
): () => void {
  if (!isNativeIOS()) {
    return () => undefined;
  }
  return subscribeNativeVoiceListener(
    () => VoiceLiveActivity.addListener("liveActivityPushToken", handler),
    "native-live-activity",
  );
}

/**
 * Subscribe to island button presses, returning an unsubscribe.
 *
 * This is the one inbound path that *acts on* the session rather than
 * describing it, which is why it does not live beside the mirror: see
 * `use-live-activity-controls.ts`.
 *
 * The press is delivered by an App Intent iOS performs in the app process, so
 * it arrives as a plain bridge event with no network hop and no credential.
 * Unrecognized actions are dropped by the consumer rather than filtered here —
 * a shell newer than this bundle can send an action this build has never heard
 * of, and the type union is what makes that a compile-time question on the way
 * back down.
 *
 * Fires only while a session is live: nothing native queues these, so a press
 * that lands with no listener attached does nothing rather than replaying at
 * the next session. See `VoiceLiveActivityPlugin.deliverControl`.
 */
export function subscribeVoiceLiveActivityControl(
  handler: (event: VoiceLiveActivityControl) => void,
): () => void {
  if (!isNativeIOS()) {
    return () => undefined;
  }
  return subscribeNativeVoiceListener(
    () => VoiceLiveActivity.addListener("liveActivityControl", handler),
    "native-live-activity",
  );
}
