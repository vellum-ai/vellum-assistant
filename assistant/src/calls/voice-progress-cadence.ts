/**
 * Progress narration cadence for one voice turn, shared by the live-voice
 * session and the phone call controller.
 *
 * A voice turn that runs tools is silent while they run. The cadence speaks
 * short audio-only progress updates into that dead air: a generated
 * sentence about what the turn is doing (see `progress-narration.ts`), or a
 * static fallback phrase when generation yields nothing. It follows the
 * turn's tool activity rather than the clock: an "ops" burst, a long
 * operation completing, or a full interval of audible silence with news
 * since the last update, with `maxSilenceMs` as the heartbeat ceiling.
 *
 * The cadence owns the per-turn state (the tool-activity log, epochs,
 * spacing, the self-re-arming idle timer). Everything transport-specific
 * comes in through {@link ProgressCadenceHost}: whether the turn's audio is
 * idle, when it last reached the listener, and how to speak a phrase.
 */

import type { VoiceProgressConfig } from "../config/schemas/voice.js";
import { fixedPhraseLanguage } from "../util/language-subtag.js";
import { getLogger } from "../util/logger.js";
import type {
  VoiceProgressNarrator,
  VoiceProgressTextInput,
} from "./progress-narration.js";
import {
  pickProgressPhrase,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "./progress-phrases.js";

const log = getLogger("voice-progress-cadence");

/**
 * One tool operation observed on a turn, fed by the bridge's structured tool
 * callbacks. `completedAtMs`/`isError`/`resultPreview` land with tool_result.
 */
export interface TurnProgressOp {
  toolName: string;
  toolUseId?: string;
  startedAtMs: number;
  completedAtMs?: number;
  isError?: boolean;
  resultPreview?: string;
}

/** What prompted a narration attempt. */
export type ProgressNarrationTrigger = "ops" | "idle" | "op_complete";

/** A tool completion as the bridge reports it. */
export interface ProgressToolResult {
  toolName: string;
  toolUseId?: string;
  isError?: boolean;
  resultPreview?: string;
}

/**
 * Newest incomplete op, optionally restricted to a tool name (the
 * tool_result fallback match when no toolUseId correlates).
 */
export function findLastIncompleteOp(
  ops: readonly TurnProgressOp[],
  toolName?: string,
): TurnProgressOp | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (
      op.completedAtMs === undefined &&
      (toolName === undefined || op.toolName === toolName)
    ) {
      return op;
    }
  }
  return undefined;
}

/**
 * The transport-specific half of progress narration, supplied by the driver
 * that owns the turn's audio.
 */
export interface ProgressCadenceHost {
  /** Identifies the turn in logs. */
  turnId: string;
  /** Dispatch timestamp of the turn (`Date.now()` at launch). */
  launchedAtMs: number;
  /** Aborts an in-flight narration generation with the turn. */
  signal: AbortSignal;
  /**
   * Whether the turn may still be narrated: it is the live turn, it has not
   * completed, and it is not waiting on a decision (a turn waiting on an
   * approval says so once and is quiet after that).
   */
  canNarrate(): boolean;
  /**
   * No assistant audio is buffered, queued, in flight, or (estimatedly)
   * still playing to the listener.
   */
  isAudioIdle(): boolean;
  /**
   * Wall-clock estimate of when audio already handed to the transport
   * finishes reaching the listener, 0 when nothing is playing. Together with
   * the cadence's own last-emitted stamp this anchors the dead-air countdown
   * to when the listener last heard something.
   */
  playbackTailUntilMs(): number;
  /** The caller's words this turn answers, for the narrator. */
  transcriptSoFar(): string;
  /** The turn's spoken language, when known. */
  language(): string | undefined;
  /**
   * Bumped on every assistant text delta. A narration generated while the
   * model was already speaking is stale and is dropped.
   */
  deltaEpoch(): number;
  /**
   * Speak one sanitized phrase, audio-only. `language` is the TTS hint the
   * phrase must carry ("en" for a static fallback the localized table lacks
   * in the turn's language); undefined rides the turn's language. Returns
   * false when nothing was spoken.
   */
  speak(phrase: string, language: string | undefined): boolean;
  /** Called after a narration was actually enqueued (metrics). */
  onNarrationSpoken?(): void;
}

export interface ProgressCadenceOptions {
  config: VoiceProgressConfig;
  /** Null disables narration for the turn (no TTS, or narration off). */
  narrator: VoiceProgressNarrator | null;
  host: ProgressCadenceHost;
  /**
   * Rotates the static fallback phrase across turns so a session with
   * repeated dead air does not repeat one sentence.
   */
  nextFallbackPhraseIndex: () => number;
}

export interface ProgressCadence {
  /** Tool operations this turn, in start order. */
  readonly ops: readonly TurnProgressOp[];
  /** Narrations actually spoken this turn. */
  readonly updatesSpoken: number;
  /** A tool started: counts toward the "ops" trigger and is news for idle. */
  toolStarted(toolName: string, toolUseId?: string): void;
  /**
   * A tool finished. A long operation completing narrates on its own beat;
   * a quick one only counts as news.
   */
  toolFinished(event: ProgressToolResult): void;
  /** The turn's audio last finished emitting now: restarts the dead-air clock. */
  noteAudioSettled(): void;
  /**
   * Something else held the floor now (a spoken approval line, a bridge):
   * narration keeps `minGapMs` from it.
   */
  noteFloorHolder(): void;
  /**
   * Arm (or re-arm) the dead-air timer. A no-op when narration is off for
   * the turn.
   */
  arm(): void;
  /** Stop the dead-air timer; the turn ended, was cancelled, or handed off. */
  clear(): void;
}

export function createProgressCadence(
  options: ProgressCadenceOptions,
): ProgressCadence {
  const { config, narrator, host, nextFallbackPhraseIndex } = options;
  const ops: TurnProgressOp[] = [];
  // Ops accumulated toward the next ops-triggered narration. Counted once
  // per op, on start (not completion), so a burst of slow tools still trips
  // the threshold while they run.
  let opsSinceNarration = 0;
  // Bumped by every observable change to the turn's tool activity. The idle
  // trigger compares it against `narratedEpoch` so a tick with nothing new
  // to report stays silent.
  let stateEpoch = 0;
  let narratedEpoch = 0;
  let updatesSpoken = 0;
  // When the last spoken floor-holder enqueued; gates `minGapMs`.
  let lastFloorHolderAtMs: number | null = null;
  // When the turn's audio last finished emitting (turn launch until anything
  // speaks). Idle time is measured from when the listener last heard
  // something, not from when the turn started.
  let lastAudibleAtMs = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // A narration generation is awaiting the narrator; serializes narrations.
  let narrationInFlight = false;

  const enabled = config.enabled && narrator !== null;

  // When the turn's current audible silence began: the latest of the last
  // emitted segment, the estimated playback end, and the last floor holder.
  const silenceSinceMs = (): number =>
    Math.max(
      lastAudibleAtMs,
      host.playbackTailUntilMs(),
      lastFloorHolderAtMs ?? 0,
    );

  const canNarrate = (): boolean => host.canNarrate() && host.isAudioIdle();

  const withinMinGap = (): boolean =>
    lastFloorHolderAtMs !== null &&
    Date.now() - lastFloorHolderAtMs < config.minGapMs;

  // The idle tick has something worth saying when the turn's tool activity
  // has moved since the last narration described it, or when the silence has
  // run past `maxSilenceMs`, the heartbeat ceiling that proves the assistant
  // is still alive on a turn with no observable activity at all.
  const idleHasSomethingToSay = (): boolean => {
    if (stateEpoch !== narratedEpoch) {
      return true;
    }
    const silentForMs = Date.now() - silenceSinceMs();
    if (silentForMs >= config.maxSilenceMs) {
      return true;
    }
    log.debug(
      { turnId: host.turnId, silentForMs },
      "Voice progress narration held: nothing new since the last update",
    );
    return false;
  };

  const clearTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // Arms the dead-air timer. The countdown measures audible silence, not
  // time since launch, so it covers mid-turn silences for the whole turn. On
  // expiry with audio still pending, or with the silence not yet a full
  // interval old, it re-arms for the remainder; only a full interval of
  // audible silence reaches the gatekeeper. The interval is a polling
  // cadence, not a speaking cadence: most ticks find nothing new and stay
  // quiet.
  const armTimer = (delayMs?: number): void => {
    clearTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!host.canNarrate()) {
        return;
      }
      if (!host.isAudioIdle()) {
        armTimer();
        return;
      }
      const remaining = silenceSinceMs() + config.idleIntervalMs - Date.now();
      if (remaining > 0) {
        armTimer(remaining);
        return;
      }
      maybeNarrate("idle");
      armTimer();
    }, delayMs ?? config.idleIntervalMs);
  };

  // Generate and speak one audio-only progress narration. On a null result,
  // idle narration falls back to a static phrase while activity-triggered
  // narration stays silent.
  const speakUpdate = async (
    activeNarrator: VoiceProgressNarrator,
    trigger: ProgressNarrationTrigger,
  ): Promise<void> => {
    narrationInFlight = true;
    const deltaEpochAtLaunch = host.deltaEpoch();
    // The activity this update describes. Tool events that land
    // mid-generation are news the generated text cannot carry, so they must
    // leave the idle trigger armed rather than count as already narrated.
    const stateEpochAtLaunch = stateEpoch;
    try {
      const now = Date.now();
      const currentOp = findLastIncompleteOp(ops);
      const language = host.language();
      const input: VoiceProgressTextInput = {
        transcriptSoFar: host.transcriptSoFar(),
        completedOps: ops
          .filter(
            (op): op is TurnProgressOp & { completedAtMs: number } =>
              op.completedAtMs !== undefined,
          )
          // `ops` is in start order; the narrator wants completion order,
          // which differs when parallel tools finish out of order.
          .sort((a, b) => a.completedAtMs - b.completedAtMs)
          .map((op) => ({
            toolName: op.toolName,
            ...(op.isError !== undefined ? { isError: op.isError } : {}),
            ...(op.resultPreview !== undefined
              ? { resultPreview: op.resultPreview }
              : {}),
          })),
        currentOp: currentOp
          ? {
              toolName: currentOp.toolName,
              elapsedMs: now - currentOp.startedAtMs,
            }
          : null,
        turnElapsedMs: now - host.launchedAtMs,
        updateIndex: updatesSpoken + 1,
        ...(language !== undefined ? { languageHint: language } : {}),
      };
      const generated = await activeNarrator
        .generateProgressText(input, host.signal)
        // The narrator contract never rejects. Keep test stubs fail-soft too.
        .catch(() => null);
      // Re-check liveness and staleness after the provider call.
      if (
        !canNarrate() ||
        host.deltaEpoch() !== deltaEpochAtLaunch ||
        withinMinGap()
      ) {
        return;
      }
      let raw = generated;
      // Generated text is in the turn's language; only the static fallback
      // comes from a localized table and may need the "en" override.
      let fillerLanguage: string | undefined;
      if (raw === null) {
        if (trigger !== "idle") {
          return;
        }
        raw = pickProgressPhrase(nextFallbackPhraseIndex(), language);
        fillerLanguage = fixedPhraseLanguage(
          PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
          language,
        );
      }
      if (!host.speak(raw, fillerLanguage)) {
        return;
      }
      lastFloorHolderAtMs = Date.now();
      opsSinceNarration = 0;
      narratedEpoch = stateEpochAtLaunch;
      updatesSpoken += 1;
      host.onNarrationSpoken?.();
      // Restart the dead-air countdown from this narration.
      armTimer();
    } finally {
      narrationInFlight = false;
    }
  };

  // Gatekeeper. Speaks only while the turn is audibly silent, with one
  // generation at a time and the configured spacing.
  const maybeNarrate = (trigger: ProgressNarrationTrigger): void => {
    if (
      !enabled ||
      narrator === null ||
      !canNarrate() ||
      narrationInFlight ||
      withinMinGap() ||
      (trigger === "ops" && opsSinceNarration < config.opsThreshold) ||
      (trigger === "idle" && !idleHasSomethingToSay())
    ) {
      return;
    }
    void speakUpdate(narrator, trigger);
  };

  return {
    get ops() {
      return ops;
    },
    get updatesSpoken() {
      return updatesSpoken;
    },
    toolStarted(toolName, toolUseId) {
      ops.push({
        toolName,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        startedAtMs: Date.now(),
      });
      opsSinceNarration += 1;
      stateEpoch += 1;
      maybeNarrate("ops");
    },
    toolFinished(event) {
      // Match by toolUseId when present; otherwise the last-started
      // incomplete op with the same name (parallel same-name ops resolve
      // newest-first).
      const op =
        (event.toolUseId !== undefined
          ? ops.find((o) => o.toolUseId === event.toolUseId)
          : undefined) ?? findLastIncompleteOp(ops, event.toolName);
      // A long-running op finishing is the beat the listener has been
      // waiting through: it narrates immediately rather than waiting for
      // `opsThreshold` more ops, which on a one-slow-tool turn never arrive.
      // Short ops stay on the ops trigger.
      let trigger: ProgressNarrationTrigger = "ops";
      if (op) {
        op.completedAtMs = Date.now();
        if (event.isError !== undefined) {
          op.isError = event.isError;
        }
        if (event.resultPreview !== undefined) {
          op.resultPreview = event.resultPreview;
        }
        if (op.completedAtMs - op.startedAtMs >= config.longOpMs) {
          trigger = "op_complete";
        }
      }
      stateEpoch += 1;
      maybeNarrate(trigger);
    },
    noteAudioSettled() {
      lastAudibleAtMs = Date.now();
    },
    noteFloorHolder() {
      lastFloorHolderAtMs = Date.now();
    },
    arm() {
      if (!enabled) {
        return;
      }
      armTimer();
    },
    clear: clearTimer,
  };
}
