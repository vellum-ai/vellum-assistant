/**
 * Carries out a session control the user asked for out loud ("okay, I'm
 * gonna go", "mute for 30 seconds", "take a look at my screen"). The
 * assistant decides; this only acts, through the same paths the buttons use,
 * so a spoken mute and a pressed one are the same mute and a spoken share is
 * the same share as Option+S.
 *
 * The timed unmute lives here rather than in the assistant because a muted
 * mic sends silence: nothing upstream can hear the user ask to unmute, so the
 * timer has to be the client's.
 */

import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  requestLiveVoiceCameraLook,
  restoreVoiceRoom,
  setLiveVoiceMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import type {
  LiveVoiceEntry,
  LiveVoiceSessionControl,
  LiveVoiceSessionControlServerFrame,
} from "@/domains/chat/voice/live-voice/protocol";
import { liveVoiceCanBeShownTheScreen } from "@/domains/chat/voice/live-voice/screen-share-availability";
import { isVoiceCameraSupported } from "@/domains/chat/voice/voice-room/voice-camera";
import { isVisionModeOn } from "@/hooks/use-vision-mode-flag";
import { supportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import {
  canCompanionShareScreen,
  setCompanionScreenShare,
} from "@/runtime/companion-surface";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Entries whose call has no voice room: the companion's pill and the voice
 * key. The camera is the room's, so a call started from one of these cannot
 * be shown the camera without putting a room in front of the user.
 */
const ROOMLESS_ENTRIES: ReadonlySet<LiveVoiceEntry> = new Set([
  "companion",
  "voice_key",
  "voice_key_ask",
]);

/**
 * The controls a session about to start can carry out, for its start frame.
 *
 * End and mute everywhere. The looks by device: the screen where the shell
 * can share it (the macOS app), the camera where the room can run Live (the
 * vision flag, a camera, and a call that has a room). A macOS call from the
 * chat gets both and the assistant asks which; iOS and a browser get the
 * camera; the companion gets the screen. Both looks need an assistant that
 * takes frames at all.
 */
export function liveVoiceSessionControls(
  assistantId: string,
  entry: LiveVoiceEntry | undefined,
): LiveVoiceSessionControl[] {
  const controls: LiveVoiceSessionControl[] = ["end", "mute"];
  if (!supportsSightStream(assistantId)) {
    return controls;
  }
  if (canCompanionShareScreen()) {
    controls.push("look_screen");
  }
  const visionMode =
    useClientFeatureFlagStore.getState().stringFlags.visionMode ?? "off";
  if (
    isVisionModeOn(visionMode) &&
    isVoiceCameraSupported() &&
    (entry === undefined || !ROOMLESS_ENTRIES.has(entry))
  ) {
    controls.push("look_camera");
  }
  // Whatever can be started by voice can be stopped by voice.
  if (controls.includes("look_screen") || controls.includes("look_camera")) {
    controls.push("look_stop");
  }
  return controls;
}

interface TimedUnmute {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly unsubscribe: () => void;
}

let pendingUnmute: TimedUnmute | null = null;

function cancelTimedUnmute(): void {
  if (pendingUnmute === null) {
    return;
  }
  clearTimeout(pendingUnmute.timer);
  pendingUnmute.unsubscribe();
  pendingUnmute = null;
}

/**
 * Unmute once `durationMs` elapses, unless the mute is no longer the one this
 * timer was set for. The user unmuting by hand (and so any later mute too) or
 * the session ending cancels it: a timer must never unmute a mic the user
 * chose to mute themselves.
 *
 * **An unmute is the flag flipping inside a running session.** A hands-free
 * reconnect also clears the flag, in a reset that takes the session through
 * `idle` before restoring the carried-over mute, so a timer that read "not
 * muted" as the user unmuting would drop itself on every socket blip and leave
 * a timed mute muted for good. The logical session is its
 * `sessionGeneration`, which a reconnect keeps and a real end bumps.
 *
 * The reset also clears the registered controls, so a timer that lands in a
 * reconnect gap writes the flag itself; the store-backed flag is what the
 * capture reads and what the next connect carries over.
 */
function scheduleTimedUnmute(durationMs: number): void {
  const generation = useLiveVoiceStore.getState().sessionGeneration;
  const unsubscribe = useLiveVoiceStore.subscribe((state, previous) => {
    if (state.sessionGeneration !== generation) {
      cancelTimedUnmute();
      return;
    }
    const unmutedByHand =
      previous.muted &&
      !state.muted &&
      isLiveVoiceSessionActive(previous.state) &&
      isLiveVoiceSessionActive(state.state);
    if (unmutedByHand) {
      cancelTimedUnmute();
    }
  });
  const timer = setTimeout(() => {
    cancelTimedUnmute();
    const store = useLiveVoiceStore.getState();
    if (store.controls) {
      setLiveVoiceMuted(false);
    } else {
      store.setMuted(false);
    }
  }, durationMs);
  pendingUnmute = { timer, unsubscribe };
}

export function applyLiveVoiceSessionControl(
  frame: Pick<LiveVoiceSessionControlServerFrame, "action" | "durationMs">,
): void {
  switch (frame.action) {
    case "end":
      cancelTimedUnmute();
      endLiveVoiceSession();
      return;
    case "mute": {
      // A newer mute replaces an older timer, timed or not: the latest ask is
      // the one the user heard confirmed.
      cancelTimedUnmute();
      setLiveVoiceMuted(true);
      const { durationMs } = frame;
      if (
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs > 0 &&
        useLiveVoiceStore.getState().muted
      ) {
        scheduleTimedUnmute(durationMs);
      }
      return;
    }
    case "look_screen":
      // The screen under the pointer, as Option+S shares it. Where the mouse
      // is belongs to the host at the moment the ask lands. A share already
      // running is left alone: the user asked to be seen, and they are.
      if (
        liveVoiceCanBeShownTheScreen() &&
        useLiveVoiceStore.getState().screenShareTarget === null
      ) {
        setCompanionScreenShare({ kind: "pointerDisplay" });
      }
      return;
    case "look_camera":
      // The room owns the camera, so bring it back and leave the ask for it.
      restoreVoiceRoom();
      requestLiveVoiceCameraLook("start");
      return;
    case "look_stop":
      // Both, whichever is on: "stop looking" does not name which. The share
      // stops the way the pill's Share does; the camera ask waits for the
      // room, and a room that is not up has no camera running to close.
      if (useLiveVoiceStore.getState().screenShareTarget !== null) {
        setCompanionScreenShare();
      }
      requestLiveVoiceCameraLook("stop");
      return;
    default:
      // A control this client does not know; nothing to do.
      return;
  }
}
