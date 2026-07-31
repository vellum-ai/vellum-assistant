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
 * {@link startVoiceLiveActivity} resolving `false`, never as an error. There is
 * no separate availability probe: `start` resolving `false` already covers
 * every "no island here" case, and a probe that can itself be absent just moves
 * the problem.
 *
 * Reference: https://developer.apple.com/documentation/activitykit/activity
 */

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { ActiveLiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import { callNativeVoice } from "@/runtime/native-voice";
import { isNativeIOS } from "@/runtime/platform-detection";

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

interface VoiceLiveActivityPlugin {
  start(options: VoiceLiveActivityStart): Promise<{ started: boolean }>;
  update(content: VoiceLiveActivityContent): Promise<void>;
  end(): Promise<void>;
  addListener(
    eventName: "liveActivityPushToken",
    handler: (event: VoiceLiveActivityPushToken) => void,
  ): Promise<PluginListenerHandle>;
}

const VoiceLiveActivity =
  registerPlugin<VoiceLiveActivityPlugin>("VoiceLiveActivity");

/**
 * Show a Live Activity for a session that just became active. Resolves whether
 * one is now running — `false` off-iOS, on a shell without the plugin, and when
 * the user has disabled Live Activities for the app in Settings.
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

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  VoiceLiveActivity.addListener("liveActivityPushToken", handler)
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((err: unknown) => {
      // `console.debug`, not `captureError`, for the same reason
      // `callNativeVoice` swallows: a shell without this plugin is an expected
      // state on every web deploy, not a fault.
      console.debug("[native-live-activity] push token listener failed:", err);
    });

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
