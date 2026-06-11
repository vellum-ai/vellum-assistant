/**
 * Runtime wrapper for the mac helper's local speech-recognition partials.
 *
 * The helper runs `SFSpeechRecognizer` against its own mic tap and streams
 * cumulative partial transcriptions — the dictation overlay's live-text
 * source when daemon streaming STT is unreachable (platform-managed
 * assistants whose runtime traffic rides the platform proxy have no gateway
 * WebSocket the renderer could stream against). The same role the native
 * recognizer played in the legacy Swift client.
 *
 * Off Electron, and on shells that predate the channel, this no-ops by
 * resolving `null`.
 */

import { isElectron } from "@/runtime/is-electron";

/**
 * Start native dictation partials, delivering cumulative transcription text
 * to `onPartial`. Resolves a stop function on success, or `null` when the
 * capability is unavailable (off Electron, old shell, speech permission
 * denied, recognizer unavailable).
 *
 * `deviceName` is the recording stream's track label — the helper taps that
 * same device so the recognizer hears what the MediaRecorder hears instead
 * of the system-default input (which on a docked Mac is often a dormant
 * built-in mic).
 */
export async function startNativeDictationPartials(
  onPartial: (text: string) => void,
  deviceName?: string,
): Promise<(() => void) | null> {
  const dictation = isElectron()
    ? window.vellum?.helper?.dictation
    : undefined;
  if (!dictation) {
    return null;
  }

  // Subscribe before enabling so a fast first partial isn't dropped.
  const unsubscribe = dictation.onPartial((event) => {
    onPartial(event.text);
  });

  try {
    const result = await dictation.setPartials(true, deviceName);
    if (!result.ok) {
      console.info("native-dictation-partials: unavailable:", result.reason);
      unsubscribe();
      return null;
    }
  } catch (err) {
    console.warn("native-dictation-partials: setPartials failed", err);
    unsubscribe();
    return null;
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    dictation.setPartials(false).catch(() => {
      // Helper may have exited; nothing to stop.
    });
  };
}
