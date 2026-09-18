import type { SubagentParentNotification } from "../subagent/parent-notification.js";

export interface VoiceTaskOutcome extends SubagentParentNotification {
  source: "subagent" | "continuation";
}

interface Delivery {
  outcome: VoiceTaskOutcome | null;
  interrupted: boolean;
  lastPlayedReply: string | null;
}

/** Session-local delivery receipts. Generated text and context exposure are not receipts. */
export class VoiceTaskOutcomes {
  private readonly deliveries = new Map<string, Delivery>();
  private playback: {
    outcomes: readonly VoiceTaskOutcome[];
    announcement: boolean;
    reply: string;
    untilMs: number;
  } | null = null;

  get hasPending(): boolean {
    return this.next() !== undefined;
  }

  enqueue(outcome: VoiceTaskOutcome): void {
    const previous = this.deliveries.get(outcome.taskId);
    this.deliveries.set(outcome.taskId, {
      outcome,
      interrupted: previous?.interrupted ?? false,
      lastPlayedReply: previous?.lastPlayedReply ?? null,
    });
  }

  next(): VoiceTaskOutcome | undefined {
    for (const delivery of this.deliveries.values()) {
      if (delivery.outcome !== null) {
        return delivery.outcome;
      }
    }
    return undefined;
  }

  pendingOutcomes(): VoiceTaskOutcome[] {
    return [...this.deliveries.values()].flatMap(({ outcome }) =>
      outcome === null ? [] : [outcome],
    );
  }

  deliveryContext(outcome: VoiceTaskOutcome): string {
    const delivery = this.deliveries.get(outcome.taskId);
    const status = delivery?.interrupted
      ? "An earlier attempt to deliver this task's findings was interrupted before playback completed. Resume the useful unheard findings briefly."
      : "This update is still pending delivery.";
    const heard = delivery?.lastPlayedReply;
    return `${status} Generated assistant text in conversation history is not evidence that the user heard it. ${heard ? `The latest reply with completed audio playback for this task was: ${JSON.stringify(heard)}. Use that receipt to avoid repeating findings actually heard.` : "There is no completed audio playback receipt for this task."}`;
  }

  finish(outcome: VoiceTaskOutcome, playbackUntilMs: number, reply = ""): void {
    this.playback = {
      outcomes: [outcome],
      announcement: true,
      reply,
      untilMs: playbackUntilMs,
    };
  }

  finishContextReply(
    outcomes: readonly VoiceTaskOutcome[],
    playbackUntilMs: number,
    reply: string,
  ): void {
    if (outcomes.length > 0) {
      this.playback = {
        outcomes,
        announcement: false,
        reply,
        untilMs: playbackUntilMs,
      };
    }
  }

  acknowledgePlayback(now: number): void {
    const playback = this.playback;
    if (playback === null || now < playback.untilMs) {
      return;
    }
    for (const outcome of playback.outcomes) {
      const delivery = this.deliveries.get(outcome.taskId);
      if (delivery === undefined) {
        continue;
      }
      if (playback.reply.length > 0) {
        delivery.lastPlayedReply = playback.reply;
      }
      if (playback.announcement) {
        delivery.interrupted = false;
      }
      if (playback.announcement && delivery.outcome === outcome) {
        delivery.outcome = null;
      }
    }
    this.playback = null;
  }

  interrupt(outcome: VoiceTaskOutcome): void {
    const delivery = this.deliveries.get(outcome.taskId);
    if (delivery?.outcome != null) {
      delivery.interrupted = true;
    }
  }

  interruptPlayback(now: number): void {
    this.acknowledgePlayback(now);
    if (this.playback?.announcement) {
      for (const outcome of this.playback.outcomes) {
        this.interrupt(outcome);
      }
    }
    this.playback = null;
  }

  drain(now: number): VoiceTaskOutcome[] {
    this.acknowledgePlayback(now);
    const outcomes = this.pendingOutcomes();
    this.deliveries.clear();
    this.playback = null;
    return outcomes;
  }
}
