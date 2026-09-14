/**
 * The sustained-speech barge-in guard, shared by the live-voice session and
 * the phone media-stream path.
 *
 * A single above-gate audio chunk is not an interruption: brief TTS bleed
 * through imperfect echo cancellation, a cough, a line click. Speech has to
 * accumulate to `minSpeechMs` before the assistant is cut off. Short gaps
 * inside a run are tolerated (a browser's half-duplex echo canceller ducks
 * the near-end voice into intermittent above-gate chunks; a phone line
 * drops frames), but a longer continuous silence, or a run that is mostly
 * silence, resets it, so sparse periodic blips can never sum into a
 * barge-in.
 *
 * The guard is pure accounting over classified chunks. What arms it, what
 * classifies a chunk, and what happens when it fires belong to the driver.
 */

/** Sustained speech required before a barge-in fires. */
export const DEFAULT_BARGE_IN_MIN_SPEECH_MS = 250;

/**
 * Longest continuous sub-threshold gap tolerated inside a run. A gap of
 * exactly this length still counts as inside the run: the web client
 * batches PCM into 50 ms frames, so a run of ducked frames lands on the
 * boundary exactly (four frames = 200 ms).
 */
export const BARGE_IN_GAP_TOLERANCE_MS = 200;

/**
 * Ceiling on cumulative sub-threshold time across a whole run, as a
 * multiple of `minSpeechMs`. Per-gap tolerance alone lets sparse isolated
 * blips (a 10 ms echo spike every 200 ms) each clear the consecutive-gap
 * timer while retaining prior speech, so they would sum to the guard over
 * several seconds. Capping total tolerated silence imposes a minimum
 * above-gate duty cycle (1 / (1 + ratio), about 20%): once the run is mostly
 * silence it resets, so genuine choppy speech still lands but periodic noise
 * cannot accumulate into one.
 */
export const BARGE_IN_MAX_TOLERATED_SILENCE_RATIO = 4;

/**
 * How a chunk reads to the guard. `echo` is the assistant's own playback
 * heard back through the microphone, which live voice classifies; a phone
 * line carries only the caller's track and never produces it.
 */
export type BargeInChunkClassification = "speech" | "silence" | "echo";

/**
 * What one chunk did to the run: `pending` (still accumulating, or a
 * tolerated gap), `reset` (echo, or a gap past the limits, dropped the run),
 * `fired` (sustained speech reached the threshold; the guard is spent).
 */
export type BargeInGuardStep = "pending" | "reset" | "fired";

export interface BargeInGuard {
  /** Speech accumulated in the current run. */
  readonly speechMs: number;
  /** Feed one classified chunk of `chunkMs` audio. */
  track(
    classification: BargeInChunkClassification,
    chunkMs: number,
  ): BargeInGuardStep;
}

/**
 * Build a guard that fires after `minSpeechMs` of sustained speech. A zero
 * threshold fires on the first speech chunk (instant barge-in).
 */
export function createBargeInGuard(minSpeechMs: number): BargeInGuard {
  let speechMs = 0;
  // Consecutive sub-threshold time since the last speech chunk.
  let silenceMs = 0;
  // Cumulative sub-threshold time over the whole run, never reset by speech.
  let toleratedSilenceMs = 0;
  let fired = false;

  const reset = (): BargeInGuardStep => {
    speechMs = 0;
    silenceMs = 0;
    toleratedSilenceMs = 0;
    return "reset";
  };

  return {
    get speechMs() {
      return speechMs;
    },
    track(classification, chunkMs) {
      if (fired) {
        return "fired";
      }
      if (classification === "echo") {
        return reset();
      }
      if (classification === "silence") {
        silenceMs += chunkMs;
        toleratedSilenceMs += chunkMs;
        // Strictly greater on the per-gap check: a gap of exactly the
        // tolerance is still inside the run.
        if (
          silenceMs > BARGE_IN_GAP_TOLERANCE_MS ||
          toleratedSilenceMs >
            minSpeechMs * BARGE_IN_MAX_TOLERATED_SILENCE_RATIO
        ) {
          return reset();
        }
        return "pending";
      }
      silenceMs = 0;
      speechMs += chunkMs;
      if (speechMs < minSpeechMs) {
        return "pending";
      }
      fired = true;
      return "fired";
    },
  };
}
