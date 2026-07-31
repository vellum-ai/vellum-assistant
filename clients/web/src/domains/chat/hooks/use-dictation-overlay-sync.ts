import { useEffect } from "react";

import { formatVoiceError } from "@/domains/chat/utils/chat";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { setDictationOverlayState } from "@/runtime/dictation-overlay";

/**
 * Mirrors the dictation lifecycle to the Electron system-wide overlay — the
 * floating panel pinned top-center of the screen that shows the user's words
 * live while they dictate via push-to-talk into another app.
 *
 * Domain hook per the Electron conventions (`docs/ELECTRON.md`): the chat
 * domain owns the recording store and the voice error taxonomy, so it
 * decides when to call the `runtime/` bridge. Off Electron the bridge
 * no-ops, so this is safe to mount on web and iOS.
 *
 * Everything it publishes is read from `useVoiceRecordingStore` — phase,
 * live interim transcript, audio level, and error codes — so it must be mounted exactly
 * ONCE per window, in `GlobalPushToTalkBridge` (always present in
 * `RootLayout`). That covers dictation hosted by any `VoiceInputButton`
 * instance: the chat composer's on chat routes, and the bridge's headless
 * fallback on every other route (Settings, onboarding, …). A second
 * mounted instance would publish duplicate messages racing this one.
 *
 * The main process owns visibility. The Electron shell shows the same
 * top-center recording overlay for both in-app and global dictation, so this
 * hook publishes unconditionally.
 *
 * `dictationInsertionError` exists because front-app insertion failures
 * (automation denied / paste blocked) flag an error and then still
 * finalize the store into `done` while the transcript soft-lands in the
 * composer — the overlay must show the error, not a success check, or the
 * user would believe the paste landed in the app they were dictating into.
 */
export function useDictationOverlaySync(): void {
  const phase = useVoiceRecordingStore.use.phase();
  const errorCode = useVoiceRecordingStore.use.errorCode();
  const interim = useVoiceRecordingStore.use.interimTranscript();
  const audioLevel = useVoiceRecordingStore.use.audioLevel();
  const insertionError = useVoiceRecordingStore.use.dictationInsertionError();

  useEffect(() => {
    switch (phase) {
      case "recording":
        setDictationOverlayState({
          kind: "recording",
          transcription: interim,
          audioLevel,
        });
        break;
      case "processing":
        setDictationOverlayState({ kind: "processing" });
        break;
      case "done":
        setDictationOverlayState(
          insertionError
            ? { kind: "error", message: formatVoiceError(insertionError) }
            : { kind: "done" },
        );
        break;
      case "error":
        setDictationOverlayState({
          kind: "error",
          message: formatVoiceError(errorCode ?? insertionError ?? "unknown"),
        });
        break;
      case "idle":
        setDictationOverlayState({ kind: "dismiss" });
        break;
    }
  }, [phase, interim, audioLevel, errorCode, insertionError]);

  // Mount-scoped (not in the effect above — its cleanup runs on every dep
  // change, which would hide and re-show the overlay between interim
  // updates). If the host window tears down mid-recording, no idle
  // transition is ever published, so dismiss explicitly or the overlay
  // would stay up until the next session. Harmless after a terminal state:
  // main pins done/error on their own timers and ignores this dismiss.
  useEffect(() => {
    return () => {
      setDictationOverlayState({ kind: "dismiss" });
    };
  }, []);
}
