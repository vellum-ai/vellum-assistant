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
 * domain owns the recording store, interim transcripts, and the voice error
 * taxonomy, so it decides when to call the `runtime/` bridge. Off Electron
 * the bridge no-ops, so this is safe to mount on web and iOS.
 *
 * The main process decides visibility: sessions that start while a Vellum
 * window is focused are suppressed there (the composer already shows interim
 * text inline), so this hook publishes unconditionally.
 *
 * @param interim   Live partial transcript while recording (`voiceInterim`).
 * @param errorCode Current voice error code (`voiceError`). Needed beyond
 *                  the store's own error phase because front-app insertion
 *                  failures (automation denied / paste blocked) set an error
 *                  code and then fall back to the composer, finalizing the
 *                  store into `done` — the overlay must show the error, not
 *                  a success check, or the user would believe the paste
 *                  landed in the app they were dictating into.
 */
export function useDictationOverlaySync({
  interim,
  errorCode,
}: {
  interim: string;
  errorCode: string | null;
}): void {
  const phase = useVoiceRecordingStore.use.phase();
  const storeErrorCode = useVoiceRecordingStore.use.errorCode();

  useEffect(() => {
    switch (phase) {
      case "recording":
        setDictationOverlayState({ kind: "recording", transcription: interim });
        break;
      case "processing":
        setDictationOverlayState({ kind: "processing" });
        break;
      case "done":
        setDictationOverlayState(
          errorCode
            ? { kind: "error", message: formatVoiceError(errorCode) }
            : { kind: "done" },
        );
        break;
      case "error":
        setDictationOverlayState({
          kind: "error",
          message: formatVoiceError(storeErrorCode ?? errorCode ?? "unknown"),
        });
        break;
      case "idle":
        setDictationOverlayState({ kind: "dismiss" });
        break;
    }
  }, [phase, interim, errorCode, storeErrorCode]);

  // Mount-scoped (not in the effect above — its cleanup runs on every dep
  // change, which would hide and re-show the overlay between interim
  // updates). If the composer unmounts mid-recording (e.g. navigating to
  // Settings), no idle transition is ever published, so dismiss explicitly
  // or the overlay would stay up until the next session. Harmless after a
  // terminal state: main pins done/error on their own timers and ignores
  // this dismiss.
  useEffect(() => {
    return () => {
      setDictationOverlayState({ kind: "dismiss" });
    };
  }, []);
}
