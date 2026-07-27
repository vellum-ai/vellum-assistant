/**
 * `useLiveActivityMirror()` — mirrors the running live-voice session into the
 * iOS Live Activity (the Dynamic Island and Lock Screen presence for a session
 * that otherwise lives entirely in the web layer).
 *
 * Mounted by {@link useLiveVoiceSessionController}, so the mirror's lifetime is
 * exactly the session's. It is deliberately a *separate module* from the
 * controller: the controller owns session lifecycle, this owns an optional
 * platform flourish. Nothing here may reach the session — every bridge call
 * goes through `runtime/native-live-activity`, which no-ops off iOS, on an
 * older App Store shell, and when the user has turned Live Activities off in
 * Settings (see that module's skew contract), and is then fired and forgotten.
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
 * The mirror therefore reads only what a `ContentState` is built from (phase,
 * reconnecting, `assistantAudioActive` for the label remap, muted, accent) and
 * compares each candidate against the last payload it pushed. `inputAmplitude`
 * is never read: it changes per animation frame and would exhaust the budget
 * within a second.
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
import {
  endVoiceLiveActivity,
  startVoiceLiveActivity,
  updateVoiceLiveActivity,
  type VoiceLiveActivityContent,
} from "@/runtime/native-live-activity";
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
    // The room's label, verbatim — the same `liveVoiceSurfaceLabel` call the
    // room makes, including both its "Reconnecting…" relabel and its
    // silent-`speaking` → "Thinking…" remap — so the island never has wording
    // of its own to drift from.
    label: liveVoiceSurfaceLabel(
      session.state,
      session.reconnecting,
      session.assistantAudioActive,
    ),
    // The accent the avatar (and therefore the voice room) renders. `""` for
    // an avatar with no color to match: the native side canonicalizes
    // unparseable input to its neutral gray. An avatar still loading when the
    // session starts is picked up by the next phase change — it is content,
    // not an attribute, so it is not frozen at `start`.
    accentHex: getRenderedAvatarAccentHex() ?? "",
    muted: session.muted,
  };
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
    a.muted === b.muted
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

    const sync = (session: LiveVoiceState): void => {
      const content = toActivityContent(session);

      if (content === null) {
        if (pushed === null) {
          return;
        }
        pushed = null;
        void endVoiceLiveActivity();
        return;
      }

      if (pushed === null) {
        pushed = content;
        void startVoiceLiveActivity({
          ...content,
          // An `ActivityAttributes` field, not `ContentState`: fixed for the
          // activity's lifetime, so it is read once here and never pushed
          // again.
          assistantName: assistantDisplayName(
            useAssistantIdentityStore.getState().name,
          ),
        });
        return;
      }

      if (sameContent(pushed, content)) {
        return;
      }
      pushed = content;
      void updateVoiceLiveActivity(content);
    };

    // A session can already be running when this mounts — the controller
    // remounts across layout-level route changes while the store persists. The
    // plugin holds at most one activity, so a redundant `start` updates the
    // running one rather than stacking a second island.
    sync(useLiveVoiceStore.getState());
    const unsubscribe = subscribeSettledLiveVoiceState(sync);

    return () => {
      unsubscribe();
      // An activity that outlives its mirror sits on the Lock Screen showing a
      // phase nothing is driving.
      if (pushed !== null) {
        pushed = null;
        void endVoiceLiveActivity();
      }
    };
  }, []);
}
