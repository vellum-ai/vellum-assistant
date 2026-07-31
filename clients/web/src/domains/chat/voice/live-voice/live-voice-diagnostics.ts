/**
 * Diagnostics for the live-voice audio path, aimed at one question a feedback
 * bundle currently cannot answer: did acoustic echo cancellation actually
 * engage?
 *
 * On iOS the assistant's own TTS reaches the microphone unless WebKit's
 * voice-processing unit is cancelling it, and when it does not the symptom is
 * indirect (the assistant transcribes fragments of its own speech and barges in
 * on itself). Nothing in the client reports whether the echo-cancelling output
 * route was taken, so the failure has to be reconstructed by reading phonetic
 * matches out of transcripts. These events replace that inference with a
 * measurement.
 *
 * ## Where these land
 *
 * Everything here writes to the *lifecycle* diagnostics ring
 * ({@link recordLifecycleDiagnostic}), not the main one. The main ring holds 200
 * events and a minute of ordinary chat/SSE traffic fills it, so a voice event
 * written there is usually evicted before the user gets round to submitting the
 * report. The lifecycle ring is reserved for low-frequency state changes and
 * routinely sits near-empty. Keep it that way: a session emits a handful of
 * events plus one per spoken utterance, and nothing here may fire per audio
 * frame.
 *
 * See `clients/web/docs/CAPACITOR.md` § "Full-duplex TTS must render through a
 * MediaStream track" for the routing contract these events observe.
 */

import { recordLifecycleDiagnostic } from "@/lib/diagnostics";

/**
 * Output amplitude above which the assistant counts as audible.
 *
 * Compared against the player's mapped 0-1 output meter, whose saturating curve
 * lifts even quiet speech well clear of this, so the threshold separates
 * "rendering audio" from "silent between utterances" rather than loud from
 * quiet.
 */
const AUDIBLE_OUTPUT_THRESHOLD = 0.05;

/**
 * Consecutive silent samples that close an utterance.
 *
 * At the capture chunk cadence (~50ms) this is roughly half a second, long
 * enough to bridge the gap between two sentences of one reply and short enough
 * that the summary lands while the turn it describes is still recognisable.
 */
const SILENT_SAMPLES_TO_CLOSE = 10;

/** Smallest amplitude treated as a real noise floor, so the ratio stays finite. */
const MIN_FLOOR_AMPLITUDE = 1e-4;

/**
 * Noise-floor window, in samples taken while the assistant is silent.
 *
 * The floor cannot be a mean of those samples: the user talking *is* a silent
 * assistant, so their own speech would be averaged into the baseline, and a
 * loud prompt would then mask the echo in the reply that follows by inflating
 * what the margin is measured against.
 *
 * Nor can it be a slow creep toward them. Speech and a genuinely noisier room
 * last about as long as each other, so no time constant separates them. What
 * does separate them is that speech is intermittent (there are gaps between
 * words and phrases) while room noise is continuous. So the floor is the
 * minimum over a window long enough to contain a pause: a talking user leaves
 * the floor where it was, while a room that is simply louder has no quiet block
 * to offer and the floor follows it within a window.
 *
 * Blocks rather than a flat window so the history is a fixed handful of numbers
 * instead of every sample. At the capture chunk cadence a block is roughly a
 * second and the window roughly ten.
 *
 * A strict minimum does mean one anomalously quiet sample can hold the floor
 * down for a window, which overstates the margin. That direction is deliberate:
 * this metric exists to catch echo, so reading high is a visible false alarm
 * while reading low would quietly hide the thing being looked for, and the
 * correlation is an independent cross-check either way.
 */
const FLOOR_BLOCK_SAMPLES = 20;
const FLOOR_BLOCK_COUNT = 10;

/** Summary of one spoken utterance's echo behaviour. */
export interface EchoMarginSummary {
  /** Samples where the assistant was audible. */
  audibleSamples: number;
  /** Mean mic amplitude while the assistant was audible. */
  micDuringTts: number;
  /** Peak mic amplitude while the assistant was audible. */
  micPeakDuringTts: number;
  /**
   * The room's quiet-end mic level, tracked across the session while the
   * assistant is silent. `null` until at least one such sample exists.
   */
  micFloor: number | null;
  /**
   * How far above the room's noise floor the mic sat while the assistant spoke,
   * in dB. Near 0 means the mic heard nothing extra, so cancellation is working.
   * A large positive value means the mic is hearing the loudspeaker.
   */
  marginDb: number | null;
  /**
   * Pearson correlation between mic and speaker amplitude across the utterance
   * window. Near 0 when the two are independent; strongly positive when the mic
   * is tracking the assistant's own output envelope, which is echo regardless of
   * how loud it is in absolute terms.
   */
  correlation: number | null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Accumulates paired microphone and speaker amplitudes and summarises each
 * utterance.
 *
 * Fed from the capture amplitude callback, so it samples at the PCM chunk
 * cadence and allocates nothing per sample. Audibility is decided from the
 * measured output amplitude rather than the player's scheduling state: buffers
 * are scheduled ahead of the playhead, so `isPlaying` leads what the room can
 * actually hear, while the analyser reads what is rendering right now.
 */
export class EchoMarginProbe {
  /** Rolling per-block minima of the mic while the assistant is silent. */
  private readonly floorBlocks = new Array<number>(FLOOR_BLOCK_COUNT).fill(
    Infinity,
  );
  private floorBlockIndex = 0;
  private currentBlockMin = Infinity;
  private currentBlockSamples = 0;

  /** Current utterance, reset by {@link summarize}. */
  private audibleSamples = 0;
  private audibleMicSum = 0;
  private audibleMicPeak = 0;
  private silentRun = 0;

  /** Correlation accumulators over the whole utterance window. */
  private pairs = 0;
  private sumMic = 0;
  private sumOut = 0;
  private sumMicOut = 0;
  private sumMicSq = 0;
  private sumOutSq = 0;

  /**
   * Record one paired sample. Returns a summary at the moment an utterance
   * closes (the assistant has been silent long enough after speaking), else
   * `null`.
   */
  sample(
    micAmplitude: number,
    outputAmplitude: number,
  ): EchoMarginSummary | null {
    const audible = outputAmplitude >= AUDIBLE_OUTPUT_THRESHOLD;

    if (!audible) {
      this.trackFloor(micAmplitude);
    }

    // Only accumulate correlation once the utterance has started, so the
    // arbitrarily long silence before it cannot swamp the statistic.
    if (this.audibleSamples > 0 || audible) {
      this.pairs += 1;
      this.sumMic += micAmplitude;
      this.sumOut += outputAmplitude;
      this.sumMicOut += micAmplitude * outputAmplitude;
      this.sumMicSq += micAmplitude * micAmplitude;
      this.sumOutSq += outputAmplitude * outputAmplitude;
    }

    if (audible) {
      this.silentRun = 0;
      this.audibleSamples += 1;
      this.audibleMicSum += micAmplitude;
      this.audibleMicPeak = Math.max(this.audibleMicPeak, micAmplitude);
      return null;
    }

    if (this.audibleSamples === 0) {
      return null;
    }
    this.silentRun += 1;
    if (this.silentRun < SILENT_SAMPLES_TO_CLOSE) {
      return null;
    }
    return this.summarize();
  }

  /**
   * Close the current utterance and return its summary, or `null` when the
   * assistant never became audible. Used at session end to flush a reply that
   * was still playing.
   */
  summarize(): EchoMarginSummary | null {
    if (this.audibleSamples === 0) {
      this.resetUtterance();
      return null;
    }

    const micDuringTts = this.audibleMicSum / this.audibleSamples;
    const micFloor = this.micFloor;
    const marginDb =
      micFloor === null
        ? null
        : 20 *
          Math.log10(
            Math.max(micDuringTts, MIN_FLOOR_AMPLITUDE) /
              Math.max(micFloor, MIN_FLOOR_AMPLITUDE),
          );

    const summary: EchoMarginSummary = {
      audibleSamples: this.audibleSamples,
      micDuringTts: round(micDuringTts, 4),
      micPeakDuringTts: round(this.audibleMicPeak, 4),
      micFloor: micFloor === null ? null : round(micFloor, 4),
      marginDb: marginDb === null ? null : round(marginDb, 1),
      correlation: this.correlation(),
    };
    this.resetUtterance();
    return summary;
  }

  /** Fold a sample taken while the assistant was silent into the floor window. */
  private trackFloor(micAmplitude: number): void {
    this.currentBlockMin = Math.min(this.currentBlockMin, micAmplitude);
    this.currentBlockSamples += 1;
    if (this.currentBlockSamples < FLOOR_BLOCK_SAMPLES) {
      return;
    }
    this.floorBlocks[this.floorBlockIndex] = this.currentBlockMin;
    this.floorBlockIndex = (this.floorBlockIndex + 1) % FLOOR_BLOCK_COUNT;
    this.currentBlockMin = Infinity;
    this.currentBlockSamples = 0;
  }

  /**
   * Quietest the mic has been over the floor window, or `null` before any
   * silent sample. The in-progress block counts too, so a session that ends
   * before its first block closes still reports a floor.
   */
  private get micFloor(): number | null {
    let quietest =
      this.currentBlockSamples > 0 ? this.currentBlockMin : Infinity;
    for (const block of this.floorBlocks) {
      quietest = Math.min(quietest, block);
    }
    return Number.isFinite(quietest) ? quietest : null;
  }

  private correlation(): number | null {
    const n = this.pairs;
    if (n < 2) {
      return null;
    }
    const numerator = n * this.sumMicOut - this.sumMic * this.sumOut;
    const micVariance = n * this.sumMicSq - this.sumMic * this.sumMic;
    const outVariance = n * this.sumOutSq - this.sumOut * this.sumOut;
    const denominator = Math.sqrt(micVariance * outVariance);
    if (!Number.isFinite(denominator) || denominator <= 0) {
      return null;
    }
    return round(numerator / denominator, 2);
  }

  private resetUtterance(): void {
    this.audibleSamples = 0;
    this.audibleMicSum = 0;
    this.audibleMicPeak = 0;
    this.silentRun = 0;
    this.pairs = 0;
    this.sumMic = 0;
    this.sumOut = 0;
    this.sumMicOut = 0;
    this.sumMicSq = 0;
    this.sumOutSq = 0;
  }
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Record how a session began: whether it inherited a player prewarmed inside a
 * user gesture, and whether it is a fresh start or a reconnect.
 *
 * `playerSource` is the gesture provenance that matters. A session that built
 * its own player started outside any user activation (the Siri / Action Button
 * deep link is the path that does this by design), which is exactly when
 * `HTMLAudioElement.play()` can be refused and the echo-cancelling route lost.
 */
export function recordLiveVoiceSessionStart(details: {
  playerSource: "prewarmed" | "created";
  isReconnect: boolean;
  handsFree: boolean;
}): void {
  recordLifecycleDiagnostic("live_voice_session_start", details);
}

/**
 * Record the resolved TTS output route once capture is running, alongside the
 * native audio session's own view of itself.
 *
 * This is the event that says whether echo cancellation could possibly be
 * working: `route: "media-stream"` is the cancelling path, `"direct"` is not.
 */
export function recordLiveVoiceOutputRoute(
  details: Record<string, unknown>,
): void {
  recordLifecycleDiagnostic("live_voice_output_route", details);
}

/** Record one utterance's echo measurement. */
export function recordLiveVoiceEchoMargin(
  summary: EchoMarginSummary,
  route: string,
): void {
  recordLifecycleDiagnostic("live_voice_echo_margin", { ...summary, route });
}
