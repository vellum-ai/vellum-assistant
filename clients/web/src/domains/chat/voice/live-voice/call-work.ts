/**
 * The work a live-voice call is carrying, as the desktop companion's call bar
 * draws it: the foreground turn while it is on a tool step, and every
 * sub-agent the call's conversation set going.
 *
 * Pure apart from the {@link CallWorkTracker} the caller holds for the
 * session's lifetime, which remembers what this call has seen running. That is
 * what scopes the list to the call: a conversation carries every sub-agent it
 * has ever spawned, and one that finished an hour before the call started is
 * not the call's work.
 */

import {
  VOICE_ACTIVITY_WORK_MAX,
  VOICE_ACTIVITY_WORK_TEXT_MAX,
  type VoiceActivityWork,
} from "@vellumai/ipc-contract";

import { computeSubagentSteps } from "@/domains/chat/hooks/use-subagent-card-data";
import type { SubagentEntry } from "@/domains/chat/subagent-store";
import { truncate } from "@/domains/chat/utils/truncate";
import { isActiveStatus } from "@/utils/subagent-status";

/** How long a finished piece of work stays on the list, as "Done". */
export const CALL_WORK_SETTLED_LINGER_MS = 4000;

export interface CallWorkTracker {
  /** When the foreground's current run of steps began, or `null` between runs. */
  turnStartedAt: number | null;
  /** Sub-agents seen running during this call. */
  seenRunning: Set<string>;
  /** When each of those was first seen finished. */
  settledAt: Map<string, number>;
}

export const createCallWorkTracker = (): CallWorkTracker => ({
  turnStartedAt: null,
  seenRunning: new Set(),
  settledAt: new Map(),
});

export interface CallWorkInput {
  /** The session's activity label: the foreground's step, or `""`. */
  activityLabel: string;
  assistantName: string;
  /** The call's conversation, or `null` before the server has assigned one. */
  conversationId: string | null;
  subagents: readonly SubagentEntry[];
  now: number;
}

export interface CallWork {
  work: VoiceActivityWork[];
  /**
   * When the list next changes with nothing else moving (a finished item
   * lingering out), or `null` when nothing is lingering.
   */
  nextChangeAt: number | null;
}

/**
 * Model-worded text clamped to what the contract carries, so a long label or
 * activity sentence shortens on the bar rather than getting the whole update
 * refused at main's boundary.
 */
const clampText = (text: string): string =>
  truncate(text, VOICE_ACTIVITY_WORK_TEXT_MAX);

/** Keyed by the timeline array, which the store replaces on every event. */
const stepCache = new WeakMap<readonly unknown[], string>();

/**
 * What a sub-agent is doing this moment: its tool in flight, named the way its
 * card names it, or `""` while it is thinking between tools.
 */
export function subagentStep(entry: SubagentEntry): string {
  const cached = stepCache.get(entry.events);
  if (cached !== undefined) {
    return cached;
  }
  const { steps } = computeSubagentSteps(entry.events);
  const latest = steps.at(-1);
  const step =
    latest?.kind === "tool" && latest.status === "running"
      ? latest.activity || latest.title
      : "";
  stepCache.set(entry.events, step);
  return step;
}

export function buildCallWork(
  input: CallWorkInput,
  tracker: CallWorkTracker,
): CallWork {
  const { activityLabel, assistantName, conversationId, subagents, now } =
    input;
  const work: VoiceActivityWork[] = [];
  let nextChangeAt: number | null = null;

  if (activityLabel === "") {
    tracker.turnStartedAt = null;
  } else {
    tracker.turnStartedAt ??= now;
    work.push({
      id: "turn",
      kind: "turn",
      title: clampText(assistantName),
      step: clampText(activityLabel),
      state: "running",
      startedAt: tracker.turnStartedAt,
    });
  }

  if (conversationId === null) {
    return { work, nextChangeAt };
  }

  for (const entry of subagents) {
    if (entry.parentConversationId !== conversationId) {
      continue;
    }
    const { subagentId: id } = entry;
    if (isActiveStatus(entry.status)) {
      tracker.seenRunning.add(id);
      tracker.settledAt.delete(id);
      const waiting = entry.status === "awaiting_input";
      work.push({
        id,
        kind: "subagent",
        title: clampText(entry.label),
        step: waiting ? "" : clampText(subagentStep(entry)),
        state: waiting ? "waiting" : "running",
        startedAt: entry.spawnedAt,
      });
      continue;
    }
    if (!tracker.seenRunning.has(id)) {
      continue;
    }
    const settledAt = tracker.settledAt.get(id) ?? now;
    tracker.settledAt.set(id, settledAt);
    const leavesAt = settledAt + CALL_WORK_SETTLED_LINGER_MS;
    if (now >= leavesAt) {
      continue;
    }
    nextChangeAt = Math.min(nextChangeAt ?? leavesAt, leavesAt);
    work.push({
      id,
      kind: "subagent",
      title: clampText(entry.label),
      step: "",
      state: entry.status === "completed" ? "done" : "failed",
      startedAt: entry.spawnedAt,
    });
  }

  // The turn first, then the newest sub-agents, as many as one update carries.
  const capped =
    work.length <= VOICE_ACTIVITY_WORK_MAX
      ? work
      : [
          ...work.filter((item) => item.kind === "turn"),
          ...work
            .filter((item) => item.kind === "subagent")
            .slice(-(VOICE_ACTIVITY_WORK_MAX - (activityLabel === "" ? 0 : 1))),
        ];
  return { work: capped, nextChangeAt };
}

/** Whether two lists would draw the same bar. */
export function sameCallWork(
  a: readonly VoiceActivityWork[],
  b: readonly VoiceActivityWork[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!;
      return (
        item.id === other.id &&
        item.kind === other.kind &&
        item.title === other.title &&
        item.step === other.step &&
        item.state === other.state &&
        item.startedAt === other.startedAt
      );
    })
  );
}
