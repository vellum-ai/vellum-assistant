/**
 * `useLiveActivityMirror()` — mirrors the running live-voice session into the
 * platform's out-of-app session surface: the Dynamic Island and Lock Screen on
 * iOS, the floating panel on macOS. Both are presence for a session that
 * otherwise lives entirely in the web layer.
 *
 * **One snapshot, two sinks.** The payload is identical because the two
 * surfaces show the same facts, so the content is computed once here and
 * handed to whichever transport the host has: `runtime/native-live-activity`
 * (Capacitor → ActivityKit) and `runtime/desktop-voice-activity` (Electron IPC
 * → BrowserWindow). Each no-ops off its own host, so this hook needs no
 * platform branch of its own. A mirror that asked "which platform am I on"
 * would have to be updated for each new surface, whereas a sink that answers
 * "not mine" degrades on its own.
 *
 * Mounted by {@link useLiveVoiceSessionController}, so the mirror's lifetime is
 * exactly the session's. It is deliberately a *separate module* from the
 * controller: the controller owns session lifecycle, this owns an optional
 * platform flourish. Nothing here may reach the session — every bridge call
 * no-ops off its host, on an older shell, and when the user has turned Live
 * Activities off in Settings (see each module's skew contract), and is then
 * fired and forgotten.
 *
 * **Everything runs inside an effect**, reading the store through
 * {@link subscribeSettledLiveVoiceState} rather than a reactive selector. The
 * controller sets `observeAudioState: false` precisely so the high-frequency
 * amplitude and transcript updates a live session emits never re-render the
 * mounting layout; a selector here would subscribe that layout to session churn
 * all over again. *Settled* state, not raw: a session transition is several
 * `set()` calls, and a reconnect's `reset()` → `setState("connecting")` pair
 * would otherwise end and immediately re-request the activity — a visible
 * island flicker on every retry.
 *
 * **Updates are pushed only when the content actually changes.** ActivityKit
 * rate-limits updates and silently drops the overflow, so an activity that
 * spends its budget on redundant pushes stops reflecting the session at all.
 * The desktop panel has no such budget (it is local IPC), but it is fed from
 * the same comparison anyway: two sinks diverging on *when* they update is how
 * the two surfaces would come to show different things.
 * The mirror therefore reads only what a `ContentState` is built from (phase,
 * reconnecting, `assistantAudioActive` for the label remap, muted, accent) and
 * compares each candidate against the last payload it pushed. `inputAmplitude`
 * is never read: it changes per animation frame and would exhaust the budget
 * within a second. `activityLabel` is read and is safe to: the daemon emits it
 * only on a change it wants surfaced, a few times per turn at most.
 */

import { useEffect } from "react";

import {
  isLiveVoiceSessionActive,
  liveVoiceSurfaceLabel,
  subscribeSettledLiveVoiceState,
  useLiveVoiceStore,
  type LiveVoiceState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { getRenderedAvatarAccentHex } from "@/hooks/use-avatar-accent-var";
import { getIslandAvatarSource } from "@/hooks/use-island-avatar-source";
import {
  registerLiveActivityPushToken,
  unregisterLiveActivityPushToken,
} from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import {
  endVoiceLiveActivity,
  startVoiceLiveActivity,
  subscribeVoiceLiveActivityPushToken,
  updateVoiceLiveActivity,
  type VoiceLiveActivityContent,
  type VoiceLiveActivityStart,
} from "@/runtime/native-live-activity";
import {
  endVoiceActivity,
  startVoiceActivity,
  updateVoiceActivity,
} from "@/runtime/desktop-voice-activity";
import { memoizedAvatarEncode } from "@/utils/avatar-island-encode";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { assistantDisplayName } from "@/utils/assistant-display-name";

/**
 * The activity content for a session snapshot, or `null` when there should be
 * no activity at all.
 *
 * `idle` is the absence of a session; `failed` ends the activity rather than
 * rendering as a phase, because the failure is surfaced *in the app* (the
 * composer's error notice, the title-bar failure chip) where it can be
 * dismissed, and an island the user cannot act on is worse than none.
 */
function toActivityContent(
  session: LiveVoiceState,
): VoiceLiveActivityContent | null {
  if (!isLiveVoiceSessionActive(session.state)) {
    return null;
  }
  return {
    phase: session.state,
    // The room's label, verbatim: the same `liveVoiceSurfaceLabel` call the
    // room makes, including its "Reconnecting…" relabel, its
    // silent-`speaking` to "Thinking…" remap, and its muted-`listening` to
    // "Muted" remap, so the island never has wording of its own to drift from.
    label: liveVoiceSurfaceLabel(
      session.state,
      session.reconnecting,
      session.assistantAudioActive,
      session.muted,
    ),
    // The accent the avatar (and therefore the voice room) renders. `""` for
    // an avatar with no color to match: the native side canonicalizes
    // unparseable input to its neutral gray. An avatar still loading when the
    // session starts is picked up by the next phase change — it is content,
    // not an attribute, so it is not frozen at `start`.
    accentHex: getRenderedAvatarAccentHex() ?? "",
    muted: session.muted,
    // Only this path carries it — the APNs path composes content from the
    // push registration, which has no `outputMuted` in it. See the field's
    // docs in `native-live-activity.ts`.
    outputMuted: session.outputMuted,
    // The daemon's wording, verbatim, for the same reason the phase label is
    // the room's wording verbatim: the island has a second driver (the APNs
    // push the daemon dispatches while this layer is suspended) and the two
    // must render the same thing.
    detail: session.activityLabel,
    // Arrives on the same frame as the line above and is the other half of the
    // same fact: `detail` says the turn is waiting, this says which decision
    // it is waiting on, and only the second one makes the island's buttons
    // answerable. `""` for a turn that is not waiting, which is the state a
    // session spends nearly all of its time in.
    approvalRequestId: session.pendingApprovalRequestId ?? "",
  };
}

/**
 * The island avatar for the current assistant, encoding it on first use.
 *
 * The memo is shared with the Home Screen widget snapshot, which rasterizes the
 * same source through the same ladder at a budget of its own. Sharing it buys
 * one owner of the caching rules and the failure semantics rather than one
 * draw for both surfaces: the two run separate encodes, since each resolves its
 * own render and reads at its own budget. What reaches the island is unchanged:
 * the memo is keyed on the source's identity, exactly as this module's own
 * cache was, and holds a separate slot per budget so an island can never be
 * handed the widgets' larger encode and fail to start on it.
 */
async function islandAvatarBase64(): Promise<string | undefined> {
  const source = getIslandAvatarSource();
  if (source === null) {
    return undefined;
  }
  const encode = memoizedAvatarEncode(source);
  const base64 = encode.pending === null ? encode.base64 : await encode.pending;
  return base64 ?? undefined;
}

/**
 * Start the activity once the avatar is encoded.
 *
 * The encode is a canvas draw, so `start` is no longer synchronous with the
 * store transition that triggered it, and the session can move underneath it.
 * `currentStart` is therefore resolved *after* the await rather than captured
 * before it, and answers both questions the delay creates:
 *
 * - **The session ended.** It returns `null`, so `end` is not overtaken by a
 *   late `start` that would strand an island nothing is driving. That is the
 *   one failure the plugin's single-activity handle cannot clean up until the
 *   next launch.
 * - **The phase moved on.** It returns the *latest* content, not the phase that
 *   opened the window. Any `update` pushed while this was pending was dropped
 *   natively, because there was no activity to update yet, so starting from the
 *   captured payload would leave the island showing "Connecting…" until the
 *   next phase change happened to repaint it.
 */
async function startWithAvatar(
  currentStart: () => VoiceLiveActivityStart | null,
): Promise<void> {
  const avatarBase64 = await islandAvatarBase64();
  const start = currentStart();
  if (start === null) {
    return;
  }
  const payload = {
    ...start,
    ...(avatarBase64 ? { avatarBase64 } : {}),
  };
  // Handed to both sinks unchanged. `VoiceActivityStart`'s `phase` is the same
  // vocabulary as `ActiveLiveVoiceSessionState`, restated in the IPC contract
  // rather than imported across the package boundary. This assignment is what
  // holds the two in step, so a phase added to the store without a matching
  // case in `@vellumai/ipc-contract` fails to compile here.
  startVoiceActivity(payload);
  await startVoiceLiveActivity(payload);
}

/** Whether two payloads would render the same island. */
function sameContent(
  a: VoiceLiveActivityContent,
  b: VoiceLiveActivityContent,
): boolean {
  return (
    a.phase === b.phase &&
    a.label === b.label &&
    a.accentHex === b.accentHex &&
    a.muted === b.muted &&
    a.outputMuted === b.outputMuted &&
    a.detail === b.detail &&
    // Compared as well as pushed: a wait can be entered and left without the
    // rest of the content moving at all, and an island whose buttons outlive
    // the decision behind them is worse than one that never had any.
    a.approvalRequestId === b.approvalRequestId
  );
}

export function useLiveActivityMirror(): void {
  useEffect(() => {
    /**
     * The last payload handed to the bridge, or `null` when no activity has
     * been requested. Intent, not confirmation: `start` resolves `false` when
     * the user has Live Activities switched off, and tracking the resolved
     * value would make the mirror's own sequencing depend on bridge timing for
     * no gain — `update`/`end` are native no-ops when nothing is running.
     */
    let pushed: VoiceLiveActivityContent | null = null;
    /**
     * Bumped on every start and every end, so an in-flight `startWithAvatar`
     * can tell whether the session it was starting is still the current one.
     */
    let generation = 0;
    /**
     * The newest ActivityKit push token, or `null` before one arrives.
     *
     * It shows up some time *after* `start` resolves and can be reissued
     * mid-activity, so it is state rather than something `start` could return.
     */
    let pushToken: string | null = null;
    /**
     * What was last registered with the platform, as `token:assistant:
     * conversation:accent:muted`.
     *
     * Every part matters and none is stable: the token rotates; a session
     * started from a draft has no conversation id until the server's `ready`
     * assigns one; registering against `null` and never revisiting it would
     * leave the activity addressable by nothing; and the accent and mute state
     * are content the platform composes its pushes from, so a stale
     * registration would push the island back to whatever they were at start.
     * Comparing the whole tuple re-registers when any part moves and stays
     * quiet when none does.
     */
    let registeredKey: string | null = null;

    /**
     * Register the running activity with the platform once the token and the
     * session's identity are both known.
     *
     * This is what lets the island keep updating after iOS suspends this web
     * view — see `live-activity-push-registration.ts`.
     */
    const syncPushRegistration = (
      session: LiveVoiceState,
      content: VoiceLiveActivityContent,
    ): void => {
      const { assistantId, conversationId } = session;
      if (
        pushToken === null ||
        assistantId === null ||
        conversationId === null
      ) {
        return;
      }
      const { accentHex, muted } = content;
      const key = `${pushToken}:${assistantId}:${conversationId}:${accentHex}:${String(muted)}`;
      if (key === registeredKey) {
        return;
      }
      registeredKey = key;
      void registerLiveActivityPushToken({
        token: pushToken,
        assistantId,
        conversationId,
        accentHex,
        muted,
      });
    };

    const sync = (session: LiveVoiceState): void => {
      const content = toActivityContent(session);

      if (content === null) {
        if (pushed === null) {
          return;
        }
        pushed = null;
        generation += 1;
        // Dropped before the token is retired: the registration outlives the
        // activity otherwise, and the platform would push a phase at an island
        // that no longer exists.
        pushToken = null;
        registeredKey = null;
        void unregisterLiveActivityPushToken();
        void endVoiceLiveActivity();
        endVoiceActivity();
        return;
      }

      syncPushRegistration(session, content);

      if (pushed === null) {
        pushed = content;
        generation += 1;
        const started = generation;
        void startWithAvatar(() =>
          // Read at start time, not capture time. `pushed` tracks the newest
          // content, so a phase that landed during the avatar encode is what
          // the island opens on; its own `update` was dropped natively for
          // want of an activity to update.
          generation === started && pushed !== null
            ? {
                ...pushed,
                // An `ActivityAttributes` field, not `ContentState`: fixed for
                // the activity's lifetime, so it is read once here and never
                // pushed again. The avatar is added by `startWithAvatar` for
                // the same reason.
                assistantName: assistantDisplayName(
                  useAssistantIdentityStore.getState().name,
                ),
              }
            : null,
        );
        return;
      }

      if (sameContent(pushed, content)) {
        return;
      }
      pushed = content;
      void updateVoiceLiveActivity(content);
      updateVoiceActivity(content);
    };

    // A session can already be running when this mounts — the controller
    // remounts across layout-level route changes while the store persists. The
    // plugin holds at most one activity, so a redundant `start` updates the
    // running one rather than stacking a second island.
    sync(useLiveVoiceStore.getState());
    const unsubscribe = subscribeSettledLiveVoiceState(sync);
    // Subscribed for the mirror's whole lifetime rather than per activity: the
    // token can arrive before the next settled state does, and a listener
    // attached per `start` would miss it.
    const unsubscribeToken = subscribeVoiceLiveActivityPushToken(
      ({ token }) => {
        pushToken = token;
        const session = useLiveVoiceStore.getState();
        const content = toActivityContent(session);
        // A token for a session that has already ended registers nothing: the
        // activity it addresses is on its way out, and the `end` path has
        // already dropped the registration.
        if (content !== null) {
          syncPushRegistration(session, content);
        }
      },
    );

    return () => {
      unsubscribe();
      unsubscribeToken();
      // A surface that outlives its mirror sits on the Lock Screen, or floats
      // over the desktop, showing a phase nothing is driving.
      if (pushed !== null) {
        pushed = null;
        pushToken = null;
        registeredKey = null;
        void unregisterLiveActivityPushToken();
        void endVoiceLiveActivity();
        endVoiceActivity();
      }
    };
  }, []);
}
