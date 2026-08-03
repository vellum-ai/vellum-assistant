/**
 * Registers the running Live Activity's ActivityKit push token with the
 * platform, so the *server* can update the island when this web layer cannot.
 *
 * Every other update in this domain is pushed from here — see
 * `use-live-activity-mirror.ts`. That path has one structural flaw it cannot
 * fix from the inside: it runs on the JS main thread of a `WKWebView` that iOS
 * throttles and eventually suspends once the app is backgrounded, which is the
 * only state in which the Lock Screen and the Dynamic Island are on screen at
 * all. Registering the token gives the same activity a second driver — the
 * daemon reports each phase change to the platform, which pushes it through
 * APNs, and iOS applies it with no app process involved.
 *
 * The two drivers coexist by design rather than by arbitration. They carry the
 * same `ContentState`, ActivityKit takes the newest, and whichever of them is
 * alive at the time wins: foregrounded, the local push lands first because it
 * skips a round trip through Apple; backgrounded, it is the only one that
 * arrives.
 *
 * **The lexicon travels with the token.** Phase wording belongs to the web
 * layer — `liveVoiceSurfaceLabel` is the same call the voice room makes, and
 * the native side deliberately owns none of it because the shell ships on App
 * Store cadence while this bundle deploys continuously. A server composing its
 * own strings would reintroduce exactly that drift one layer further out, so
 * registration hands over a phase→label map and the platform only ever looks a
 * phase up in it. The accent and mute state travel the same way and for the
 * same underlying reason. See {@link LiveActivityRegistration}.
 *
 * Best-effort throughout, like everything else that touches the island: a
 * failure here costs a background update, never a voice session.
 */

import {
  assistantsLiveActivityTokensDelete,
  assistantsLiveActivityTokensUpsert,
} from "@/generated/api/sdk.gen";
import {
  isLiveVoiceSessionActive,
  LIVE_VOICE_STATE_LABELS,
  liveVoiceSurfaceLabel,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { captureError } from "@/lib/sentry/capture-error";
import { resolveSignedApnsEnvironment } from "@/runtime/apns-environment";
import { createStorageAccessor } from "@/utils/typed-storage";

/**
 * Every phase an activity can be pushed into, paired with its wording.
 *
 * Derived from the label table rather than restated, so a phase added to the
 * session cannot quietly ship without server-side copy. `idle` and `failed` are
 * filtered out for the same reason they have no `ContentState.Phase` case:
 * neither has an activity to address.
 */
function phaseLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  const phases = (
    Object.keys(LIVE_VOICE_STATE_LABELS) as LiveVoiceSessionState[]
  ).filter(isLiveVoiceSessionActive);
  for (const phase of phases) {
    // Read through the same helper the room and the mirror use rather than the
    // raw table, so a server-pushed label is the string the user would have
    // seen locally — including the relabel rules, resolved for their steady
    // state. `reconnecting` and silent-`speaking` are transient conditions the
    // server does not observe, so they resolve false here.
    labels[phase] = liveVoiceSurfaceLabel(phase, false, true);
  }
  return labels;
}

interface ActivityRegistration {
  token: string;
  assistantId: string;
}

function parseRegistration(raw: string): ActivityRegistration | null {
  const value = JSON.parse(raw) as Partial<ActivityRegistration>;
  if (
    typeof value.token === "string" &&
    typeof value.assistantId === "string"
  ) {
    return { token: value.token, assistantId: value.assistantId };
  }
  return null;
}

/**
 * The registration currently held, so it can be retired when the session is.
 *
 * Persisted rather than kept in module memory alone, for the same reason
 * `runtime/push-registration.ts` persists its device-token registration: the
 * web view can reload mid-session — and on iOS, reloading is exactly what
 * happens when the app is resumed after a long suspension — which would drop
 * the module state and with it any way to name the token that needs deleting.
 * The registration would then survive until the platform expired it.
 *
 * The stored value is a push-routing address, not auth material; losing it to
 * XSS grants nothing.
 */
const persistedRegistration =
  createStorageAccessor<ActivityRegistration | null>({
    key: "vellum:live_activity_registration",
    scope: "user",
    parse: parseRegistration,
    serialize: JSON.stringify,
    fallback: null,
  });

let registered: ActivityRegistration | null = null;

/**
 * Upserts still in flight.
 *
 * A registration is only recorded once its POST resolves, so an unregister that
 * lands mid-POST would see nothing to delete, return — and then the POST would
 * complete, leaving a token registered for an activity that has already ended
 * or a user who has already logged out. Draining first closes that window.
 * `runtime/push-registration.ts` carries the same machinery for device tokens
 * and for the same reason; a set rather than a single promise, because a token
 * rotation can overlap the upsert it supersedes.
 */
const pendingUpserts = new Set<Promise<void>>();

function trackUpsert(upsert: Promise<void>): void {
  pendingUpserts.add(upsert);
  void upsert.finally(() => {
    pendingUpserts.delete(upsert);
  });
}

/**
 * Tail of the upsert chain, so registrations reach the platform in the order
 * they were made.
 *
 * The row is now content the platform composes its pushes from, which makes
 * ordering load-bearing: two registrations in flight at once (a mute toggled
 * twice, or a mute landing while an avatar that loaded late re-registers the
 * accent) can arrive in either order, and the loser is what every subsequent
 * background push renders. Serializing costs nothing here, because a
 * registration is never on a latency path, and it makes "last call wins" true.
 */
let upsertChain: Promise<void> = Promise.resolve();

/** Everything the platform needs to push at one running activity. */
export interface LiveActivityRegistration {
  token: string;
  assistantId: string;
  conversationId: string;
  /**
   * The island's accent and mute state, as {@link VoiceLiveActivityContent}
   * carries them.
   *
   * **They register rather than dispatch because the daemon cannot see
   * them.** The accent is the avatar color this layer renders and mute is a
   * local control the session never hears about, yet both are `ContentState`
   * fields, and a server push replaces that state wholesale, so a dispatch
   * composed without them would gray out the island and drop its mute glyph on
   * the first phase change after the app is backgrounded, which is the only
   * state the island is ever seen in. The platform stores them on the token row
   * and composes every push from there; the caller re-registers when either
   * moves.
   */
  accentHex: string;
  muted: boolean;
}

/**
 * Register (or re-register) the activity's push token for a conversation.
 *
 * Safe to call repeatedly: iOS rotates tokens mid-activity and each value
 * invalidates the last, so every event re-registers. The platform keys on
 * `(user, token)`, so a rotation replaces the row rather than accumulating one.
 */
export async function registerLiveActivityPushToken(
  registration: LiveActivityRegistration,
): Promise<void> {
  const upsert = upsertChain.then(() => upsertToken(registration));
  // The chain must not inherit a rejection, or one failed upsert would poison
  // every later registration for the session. `upsertToken` already swallows
  // its own failures; this covers the boundary.
  upsertChain = upsert.catch(() => undefined);
  trackUpsert(upsert);
  await upsert;
}

async function upsertToken({
  token,
  assistantId,
  conversationId,
  accentHex,
  muted,
}: LiveActivityRegistration): Promise<void> {
  try {
    // `@capacitor/app` is a plugin Proxy — destructure inline (see CAPACITOR.md).
    const { App } = await import("@capacitor/app");
    const { id: bundleId } = await App.getInfo();
    // See `runtime/apns-environment.ts` for the shared-resolver rationale.
    const apnsEnvironment = await resolveSignedApnsEnvironment(bundleId);

    const result = await assistantsLiveActivityTokensUpsert({
      path: { assistant_id: assistantId },
      body: {
        token,
        bundle_id: bundleId,
        apns_environment: apnsEnvironment,
        conversation_id: conversationId,
        labels: phaseLabels(),
        accent_hex: accentHex,
        muted,
      },
      throwOnError: false,
    });

    if (result.error) {
      captureError(result.error, {
        context: "live_activity_push_registration",
        level: "warning",
        bestEffort: true,
      });
      return;
    }

    registered = { token, assistantId };
    persistedRegistration.save(registered);
  } catch (err) {
    captureError(err, {
      context: "live_activity_push_registration",
      level: "warning",
      bestEffort: true,
    });
  }
}

/**
 * Retire the registration when the session ends — or when the user logs out,
 * which `stores/auth-store.ts` calls before clearing the session cookie so the
 * platform delete is still authenticated.
 *
 * Best-effort by nature — the session may be ending precisely because the app
 * is going away, and this request may never leave. The platform therefore
 * expires registrations on its own; this is the fast path, not the guarantee.
 */
export async function unregisterLiveActivityPushToken(): Promise<void> {
  // Let any in-flight upsert finish first, or its registration lands *after*
  // this decides there is nothing to delete and outlives the session.
  if (pendingUpserts.size > 0) {
    await Promise.allSettled([...pendingUpserts]);
  }
  // Falls back to storage: a reload between registering and ending leaves the
  // module state empty while the registration is still very much live.
  const current = registered ?? persistedRegistration.load();
  if (current === null) {
    return;
  }
  registered = null;
  persistedRegistration.remove();
  try {
    await assistantsLiveActivityTokensDelete({
      path: { assistant_id: current.assistantId, token: current.token },
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, {
      context: "live_activity_push_unregistration",
      level: "warning",
      bestEffort: true,
    });
  }
}
