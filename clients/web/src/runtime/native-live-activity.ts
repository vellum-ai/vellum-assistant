/**
 * JS ↔ native bridge for the `VoiceLiveActivity` Capacitor plugin registered by
 * `clients/ios/App/App/MyViewController.swift` +
 * `clients/ios/App/App/VoiceLiveActivityPlugin.swift`.
 *
 * The plugin mirrors a running live-voice session into an ActivityKit Live
 * Activity — the Dynamic Island and Lock Screen presence for a session that
 * otherwise lives entirely in the web layer. It holds at most one activity, so
 * calling {@link startVoiceLiveActivity} twice updates the running one instead
 * of stacking a second island.
 *
 * **Skew contract.** The iOS shell ships through App Store review while this
 * bundle deploys continuously (`clients/ios/README.md` § "Web content
 * delivery"), so an arbitrarily old shell may host this bundle with no such
 * plugin compiled in. Every call therefore goes through {@link callNativeVoice},
 * which returns the fallback off-iOS and on any bridge failure. A Live Activity
 * is a flourish: nothing here may throw, block, or otherwise reach a voice
 * session.
 *
 * That fallback also covers the case where the user has turned Live Activities
 * off for the app in iOS Settings — the plugin reports that as
 * {@link isVoiceLiveActivityAvailable} resolving `false` and
 * {@link startVoiceLiveActivity} resolving `false`, never as an error.
 *
 * Reference: https://developer.apple.com/documentation/activitykit/activity
 */

import { registerPlugin } from "@capacitor/core";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import { callNativeVoice } from "@/runtime/native-voice";

/**
 * Session phase the island renders. Exactly the non-`idle`
 * {@link LiveVoiceSessionState} values, derived rather than restated so the two
 * cannot drift.
 *
 * `idle` is excluded because an idle session has no Live Activity at all — the
 * mirror ends the activity instead of pushing an idle phase.
 *
 * These raw strings cross the bridge and are decoded by
 * `VoiceSessionAttributes.ContentState.Phase` in
 * `clients/ios/App/App/Shared/VoiceSessionAttributes.swift`. **The two must
 * change together**: a value added or renamed here without a matching Swift
 * case fails to decode on the native side.
 */
export type VoiceLiveActivityPhase = Exclude<LiveVoiceSessionState, "idle">;

/** The mutable half of the activity — everything that can change mid-session. */
export interface VoiceLiveActivityContent {
  phase: VoiceLiveActivityPhase;
  /**
   * User-facing activity copy. Pass `liveVoiceStateLabel(state, reconnecting)`
   * so the island shows exactly what the voice room shows; the native side
   * deliberately owns no phase wording of its own.
   */
  label: string;
  /** Avatar accent as `#RRGGBB`. Unparseable values fall back to a neutral gray natively. */
  accentHex: string;
  muted: boolean;
}

/** {@link VoiceLiveActivityContent} plus the fields fixed for the activity's lifetime. */
export interface VoiceLiveActivityStart extends VoiceLiveActivityContent {
  assistantName: string;
}

interface VoiceLiveActivityPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  start(options: VoiceLiveActivityStart): Promise<{ started: boolean }>;
  update(content: VoiceLiveActivityContent): Promise<void>;
  end(): Promise<void>;
}

const VoiceLiveActivity =
  registerPlugin<VoiceLiveActivityPlugin>("VoiceLiveActivity");

/**
 * Whether this device can show a voice Live Activity right now — `false`
 * off-iOS, on a shell without the plugin, and when the user has disabled Live
 * Activities for the app in Settings.
 *
 * Callers do not need this to be safe: {@link startVoiceLiveActivity} already
 * resolves `false` in every one of those cases. It exists for surfaces that
 * want to know before they ask.
 */
export async function isVoiceLiveActivityAvailable(): Promise<boolean> {
  return callNativeVoice(async () => {
    // Only the result crosses this `async` boundary, never `VoiceLiveActivity`
    // itself: per `docs/CAPACITOR.md` § "Capacitor plugins must be destructured
    // inline", a plugin Proxy in a Promise-resolution context dispatches a
    // native `then()` that never resolves and hangs the caller forever.
    const { available } = await VoiceLiveActivity.isAvailable();
    // Normalized rather than returned raw — the bridge payload is untyped at
    // runtime, and a shell that answers `{}` must read as "not available".
    return available === true;
  }, false);
}

/**
 * Show a Live Activity for a session that just became active. Resolves whether
 * one is now running.
 *
 * Safe to call when one is already running: the plugin updates it rather than
 * requesting a second island. Pair every call with {@link endVoiceLiveActivity}
 * — an activity that outlives its session sits on the Lock Screen showing a
 * phase nothing is driving.
 */
export async function startVoiceLiveActivity(
  options: VoiceLiveActivityStart,
): Promise<boolean> {
  return callNativeVoice(async () => {
    const { started } = await VoiceLiveActivity.start(options);
    return started === true;
  }, false);
}

/**
 * Push new content to the running activity. A no-op when none is running, and
 * off-iOS, and on an older shell. Never throws.
 *
 * ActivityKit rate-limits updates, so callers must push only on an actual
 * {@link VoiceLiveActivityContent} change — never on high-frequency store
 * fields such as input amplitude.
 */
export async function updateVoiceLiveActivity(
  content: VoiceLiveActivityContent,
): Promise<void> {
  return callNativeVoice(async () => {
    await VoiceLiveActivity.update(content);
  }, undefined);
}

/**
 * Dismiss the Live Activity at the end of a session. A no-op when none is
 * running, and off-iOS, and on an older shell. Never throws.
 */
export async function endVoiceLiveActivity(): Promise<void> {
  return callNativeVoice(async () => {
    await VoiceLiveActivity.end();
  }, undefined);
}
