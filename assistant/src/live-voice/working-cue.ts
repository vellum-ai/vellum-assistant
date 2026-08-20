/**
 * The working cue: a short, wordless tone that holds the floor while the
 * assistant is busy on a tool-heavy turn.
 *
 * Words are the wrong instrument for that job. A spoken progress line makes a
 * claim ("still working on it") that has to be true, has to be translated, and
 * has to be re-said every few seconds before it starts sounding anxious. A
 * tone claims nothing, needs no language, and reads as "the line is still
 * open" the way a hold tone does on a phone call.
 */

/** The tunable dimensions of the cue. Every field is meant to be tried by ear. */
export interface WorkingCueShape {
  /** Fundamental in Hz. Low reads as a hum, high as a chime. */
  frequencyHz: number;
  /** Total length including fade in and out. */
  durationMs: number;
  /** Peak amplitude, 0..1. Well below speech so it sits under the call. */
  gain: number;
}

/**
 * Starting point for the cue, chosen to sound like a soft hum under the call
 * rather than a notification demanding attention: low enough to sit beneath a
 * speaking voice, short enough to read as punctuation, quiet enough that a
 * listener notices the room is still occupied without listening *to* it.
 *
 * Every number here is a first guess, not a result. All three become config
 * values, so treat them as defaults to override rather than as constants that
 * carry meaning.
 */
export const DEFAULT_WORKING_CUE_SHAPE: WorkingCueShape = {
  frequencyHz: 220,
  durationMs: 260,
  gain: 0.09,
};

/**
 * Portion of the buffer given to the attack, and the same again to the
 * release. A fifteenth-ish of a quarter-second is a few tens of milliseconds:
 * long enough to remove the click (see below), short enough that the cue still
 * has an audible body between the two ramps.
 */
const FADE_FRACTION = 0.15;

/**
 * Full-scale for signed 16-bit samples. 32767 rather than 32768 so a peak of
 * exactly `gain` cannot round to -32768, which has no positive counterpart.
 */
const INT16_PEAK = 32767;

/**
 * Render the cue as mono signed 16-bit little-endian PCM at `sampleRate`.
 *
 * Rendered rather than shipped as an asset: the session's sample rate is
 * whatever the client asked for on the start frame, so an asset would need
 * resampling, and every parameter here is a number worth tuning by ear.
 *
 * Raw samples only, with no WAV or other container header. The bytes ride the
 * same `tts_audio` frame path as synthesized speech, and the session's echo
 * canceller feeds its reference from that path by treating the payload as
 * bare `audio/pcm` at the session rate. A header would be interpreted as
 * leading samples: audible as a tick, and worse, wrong in the echo reference.
 */
export function renderWorkingCuePcm(
  sampleRate: number,
  shape: WorkingCueShape,
): Buffer {
  const frameCount = Math.max(
    0,
    Math.round((sampleRate * shape.durationMs) / 1_000),
  );
  const pcm = Buffer.alloc(frameCount * 2);

  // Both ramps have to fit, so a cue too short for the nominal fraction
  // degrades to all attack and release rather than letting the two envelopes
  // overlap. At least one fade frame whenever there is room for one: dropping
  // the ramp on a very short cue would reintroduce exactly the click the
  // envelope exists to remove.
  const fadeFrames = Math.min(
    Math.max(1, Math.floor(frameCount * FADE_FRACTION)),
    Math.floor(frameCount / 2),
  );
  const radiansPerFrame = (2 * Math.PI * shape.frequencyHz) / sampleRate;
  // Gain is clamped here rather than per sample: it arrives from config, and a
  // value outside 0..1 would otherwise make `writeInt16LE` throw partway
  // through the render on the first sample that overflows.
  const peak = Math.min(1, Math.max(0, shape.gain)) * INT16_PEAK;

  for (let frame = 0; frame < frameCount; frame++) {
    const sample =
      envelopeAt(frame, frameCount, fadeFrames) *
      peak *
      Math.sin(radiansPerFrame * frame);
    pcm.writeInt16LE(Math.round(sample), frame * 2);
  }

  return pcm;
}

/**
 * Raised-cosine attack and release, 0 at both edges and 1 across the sustain.
 *
 * This is required, not cosmetic. A sine that begins or ends at a nonzero
 * amplitude is a step discontinuity, and a step is broadband: the listener
 * hears a click. A click does not read as a cue that the assistant is working,
 * it reads as a glitch in the call, which is the opposite of the reassurance
 * the tone exists to give. The raised cosine is chosen over a linear ramp
 * because its slope is also zero at the edges, so neither the amplitude nor
 * its first derivative jumps.
 */
function envelopeAt(
  frame: number,
  frameCount: number,
  fadeFrames: number,
): number {
  if (fadeFrames <= 0) {
    return 1;
  }
  // Distance from whichever edge is nearer, so the release mirrors the attack.
  const framesFromEdge = Math.min(frame, frameCount - 1 - frame);
  if (framesFromEdge >= fadeFrames) {
    return 1;
  }
  return 0.5 * (1 - Math.cos((Math.PI * framesFromEdge) / fadeFrames));
}
