/**
 * The front-door leg coordinator, shared by the live-voice session and the
 * phone call controller.
 *
 * A triaged voice turn opens on a fast, toolless front-door leg whose
 * leading tokens carry its verdict (see `voice-triage-escalate.ts`). The
 * coordinator reads that leg's raw stream through the verdict machine and
 * sequences what follows: an answer is released as speech, a hold discards
 * a speculative turn, and an escalate verdict hands the turn off to the
 * escalated leg with a spoken bridge. The hand-off order is the part that
 * must not drift between drivers: pause narration, abort the front-door
 * leg, resolve and speak the bridge, mark it as the floor holder, start the
 * escalated leg, re-arm narration. A leg that was cancelled never hands off.
 *
 * Everything transport-specific comes in through {@link FrontDoorLegHost}:
 * how answer text and the bridge are spoken, how a leg is started or
 * aborted, and the speculative hold and commit that only live voice has.
 */

import type { ProgressCadence } from "./voice-progress-cadence.js";
import {
  createFrontDoorVerdictMachine,
  ESCALATION_CONTINUATION_CONTENT,
  resolveSpokenEscalationBridge,
} from "./voice-triage-escalate.js";

/** The phrase spoken across the hand-off, as {@link resolveSpokenEscalationBridge} settles it. */
export type SpokenEscalationBridge = ReturnType<
  typeof resolveSpokenEscalationBridge
>;

/** The leg that answers for real after the front-door leg handed off. */
export interface EscalatedLeg {
  content: string;
  routingLeg: "escalated";
  /**
   * The bridge the listener heard, quoted to the escalated continuation
   * rule so the quality model does not re-announce it.
   */
  spokenEscalationBridge: string;
}

/**
 * The escalated leg for a hand-off whose bridge was `spokenBridge`. The
 * bridge pins this leg to the conversation's own profile, so no profile
 * override rides along.
 */
export function escalatedLegFor(spokenBridge: string): EscalatedLeg {
  return {
    content: ESCALATION_CONTINUATION_CONTENT,
    routingLeg: "escalated",
    spokenEscalationBridge: spokenBridge,
  };
}

/** The driver's half of a front-door leg. */
export interface FrontDoorLegHost {
  /**
   * Whether the turn is still live: not cancelled, not finalized. A dead
   * turn must not spawn an escalated leg.
   */
  isLive(): boolean;
  /** The turn's spoken language, for the canned bridge. */
  language(): string | undefined;
  /**
   * Progress narration to pause across the hand-off: the bridge holds the
   * floor, and audible-silence gating keeps narration quiet until it has
   * played on the escalated leg.
   */
  progress?: Pick<ProgressCadence, "clear" | "noteFloorHolder" | "arm">;
  /**
   * Speculative legs only: the model judged the speaker mid-thought, so the
   * leg is discarded and listening continues.
   */
  onHold?(): void;
  /**
   * Speculative legs only: commit the turn before acting on an answer or
   * escalate verdict. Returns false when the turn is gone, which stops the
   * verdict from being acted on.
   */
  commit?(): boolean;
  /**
   * Answer text released by the verdict machine, in stream order. On the
   * transition it includes the leading text held while the verdict was
   * pending. The driver runs its own control-marker holdback over it.
   */
  onAnswerText(text: string): void;
  /**
   * Abort the front-door leg so a model that keeps generating past the
   * bridge cap adds no latency before the escalated leg starts.
   */
  abortLeg(): void;
  /**
   * Speak the bridge so the strong-model call has no dead air. The model's
   * own bridge is real assistant speech; the canned fallback is audio-only,
   * matching the row the bridge's transcript hygiene deletes for it.
   */
  speakBridge(bridge: SpokenEscalationBridge): void;
  /** Start the escalated leg on the same turn. */
  startEscalatedLeg(leg: EscalatedLeg): void;
}

export interface FrontDoorLegCoordinator {
  /** Whether this leg handed the turn off to the escalated leg. */
  readonly handedOff: boolean;
  /** Feed one raw delta of the front-door leg's stream. */
  push(text: string): void;
  /**
   * The leg completed normally (not cancelled). A leg that stopped
   * mid-bridge (a bare escalate verdict, or a holding phrase with no
   * sentence terminator) hands off now with what arrived; the canned
   * fallback covers an empty bridge. Returns whether the leg handed off.
   */
  complete(): boolean;
}

export function createFrontDoorLegCoordinator(options: {
  /**
   * Whether the leg's decision rule teaches the hold token: true only for
   * speculative legs, whose leading tokens are interpreted.
   */
  holdEnabled: boolean;
  host: FrontDoorLegHost;
}): FrontDoorLegCoordinator {
  const { host } = options;
  const verdict = createFrontDoorVerdictMachine(options.holdEnabled);
  let handedOff = false;

  const handOff = (cappedBridge: string): void => {
    if (handedOff || !host.isLive()) {
      return;
    }
    handedOff = true;
    host.progress?.clear();
    host.abortLeg();
    const bridge = resolveSpokenEscalationBridge(cappedBridge, host.language());
    host.speakBridge(bridge);
    // The bridge is the turn's spoken acknowledgement: narration keeps its
    // minimum gap from it rather than following it back to back.
    host.progress?.noteFloorHolder();
    host.startEscalatedLeg(escalatedLegFor(bridge.spokenBridge));
    // The escalated leg runs the slowest work in the system, and the bridge
    // only covers its first couple of seconds: the dead air narration
    // exists for.
    host.progress?.arm();
  };

  return {
    get handedOff() {
      return handedOff;
    },
    push(text) {
      if (handedOff) {
        return;
      }
      const step = verdict.push(text);
      if (step.kind === "hold") {
        host.onHold?.();
        return;
      }
      if (
        (step.kind === "escalate" || step.kind === "answer") &&
        host.commit !== undefined &&
        !host.commit()
      ) {
        return;
      }
      if (step.kind === "answer") {
        host.onAnswerText(step.text);
        return;
      }
      if (
        (step.kind === "escalate" || step.kind === "bridge") &&
        step.bridge !== null
      ) {
        handOff(step.bridge);
      }
    },
    complete() {
      if (!handedOff && host.isLive()) {
        const step = verdict.finish();
        if (step.kind === "bridge") {
          handOff(step.bridge);
        }
      }
      return handedOff;
    },
  };
}
