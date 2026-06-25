/**
 * Two-conversation runner: stages files into the agent's workspace,
 * sends an "ingest" message in conversation A, opens a fresh
 * conversation B, sends a follow-up message, and captures the
 * assistant's response as the hypothesis.
 *
 * Designed for LongMemEval-V2's ingest-then-ask contract. The caller
 * shapes `inputs`, `ingestMessage`, and `questionMessage` to the
 * benchmark's specific test item.
 *
 * Why a separate runner instead of extending `runEvalOnce`:
 *
 * - `runEvalOnce` is driven by a simulator (a stand-in user that
 *   decides what to say next). LongMemEval-V2's contract is fixed
 *   ingest-then-ask, with no per-turn decision needed.
 * - The injection contract — "write the haystack to disk, tell the
 *   agent where it is" — depends on workspace-file capabilities that
 *   `runEvalOnce` does not exercise.
 * - Two conversations against the *same* agent (persistent memory
 *   intact, chat history reset) is a separate orchestration shape.
 *
 * Shared infrastructure (artifact directory layout, heartbeat,
 * progress event persistence, transcript serialization) is *not*
 * duplicated here. PR 6 (Phase 1 wire) is the place to unify those
 * helpers across both runners; doing it as part of this PR would
 * balloon the diff well past one concern.
 */
import type {
  AgentEvent,
  AgentHatchInput,
  BaseAgent,
  WorkspaceFileWrite,
} from "../../../src/lib/adapter";
import { confirmationRequestId } from "../../../src/lib/adapter";
import type { Profile } from "../../../src/lib/profile";

import { createAgent } from "../../../src/lib/runner/create-agent";
import { AgentEventCollector } from "../../../src/lib/runner/event-collector";
import { appendTranscriptTurn } from "../../../src/lib/metrics";
import { assistantContent } from "../../../src/lib/runner/run-once";

export interface IngestAskInput {
  /** Profile to hatch. */
  profile: Profile;
  /**
   * Logical run id. Used for the agent hatch input and surfaced on the
   * result. Caller-supplied so it can match the workstream's run
   * accounting (`<benchmark>-<profile>-<unitId>-<timestamp>`).
   */
  runId: string;
  /**
   * Files to stage into the agent's workspace *before* the ingest
   * message is sent. Paths are workspace-relative; the adapter
   * enforces the workspace boundary.
   */
  inputs: WorkspaceFileWrite[];
  /**
   * First conversation's only message. Typically tells the agent
   * where to read the staged files and what to do with them.
   * The memory layer (or lack of one) does its work as the agent
   * processes this turn.
   */
  ingestMessage: string;
  /**
   * Second conversation's only message. Sent against a *fresh*
   * conversation key after the first conversation completes.
   * The captured response is returned as `hypothesis`.
   */
  questionMessage: string;
  /**
   * Quiet timeout in milliseconds for the *question* turn's event drain —
   * how long the stream may go silent (no new events) before the turn is
   * treated as finished. Defaults to 30s. This is *not* the overall time
   * limit: a turn that keeps streaming (e.g. long extended-thinking +
   * on-demand retrieval) runs until the `questionMaxMs` wall-clock cap
   * below, however many events it emits. The ingest turn uses
   * `ingestQuietMs` / `ingestMaxMs` instead, because its silence semantics
   * differ.
   */
  quietMs?: number;
  /**
   * Hard wall-clock cap (ms) for the *question* turn. The turn ends when
   * the stream goes quiet for `quietMs`, the stream closes, or this much
   * time elapses — whichever comes first. The cap is purely time-based; it
   * does not depend on how many events stream. If the agent never composes
   * a final answer within this budget, the run is graded as a completed
   * miss (score 0), not an errored run — "the model took too long to
   * answer" is a real, gradable outcome rather than a harness failure.
   * Defaults to 10 minutes.
   */
  questionMaxMs?: number;
  /**
   * Quiet timeout in milliseconds for the *ingest* turn's event drain.
   * Defaults to 2 minutes — deliberately far more generous than the
   * question turn's window.
   *
   * The ingest turn is a heavy, multi-step agentic turn: the agent reads
   * the staged trajectories, runs tools over large outputs, and commits
   * to memory. Between steps the model can sit silent for tens of seconds
   * (e.g. extended thinking over a large context, or a tool that just
   * started) without the turn being done. Because the sentinel is the
   * authoritative completion signal, this quiet window is only a safety
   * net to avoid waiting the full `ingestMaxMs` when the agent has truly
   * died; a tight window would instead abandon a turn that is still
   * actively working.
   */
  ingestQuietMs?: number;
  /**
   * Literal completion sentinel the ingest prompt instructs the agent to
   * emit once it has finished reading *and* committed what matters to
   * memory. The ingest turn ends only when this line appears in the
   * assistant's output; if it never arrives, the run fails loudly rather
   * than grading a truncated ingest. Defaults to `"Ready."`. Matching is
   * line-oriented and tolerant of surrounding quotes/punctuation and case.
   */
  ingestSentinel?: string;
  /**
   * Hard cap (ms) for the ingest turn's sentinel wait. A genuine
   * 100-trajectory ingest with inline memory commits can run for several
   * minutes, so this is generous; it exists to fail loudly if the turn
   * never completes. Defaults to 10 minutes.
   */
  ingestMaxMs?: number;
}

export interface IngestAskResult {
  runId: string;
  profileId: string;
  /** Conversation key used during the ingest turn. */
  ingestConversationKey: string;
  /** Conversation key used during the question turn. Must differ from `ingestConversationKey`. */
  questionConversationKey: string;
  /** Assistant response text from conversation B. Empty when the question turn produced no answer within its time budget. */
  hypothesis: string;
  /**
   * Whether the question turn produced any assistant answer text before its
   * time budget elapsed. `false` means the turn ran to `questionMaxMs` (or
   * went quiet) without emitting an answer — `hypothesis` is then `""`, and
   * the caller should grade it as a completed miss (score 0) rather than an
   * error.
   */
  questionAnswered: boolean;
  /**
   * Whether the daemon's turn-completion signal (`message_complete`) arrived
   * before the `questionMaxMs` wall-clock cap. `true` means the agent
   * finished its turn (even if it produced no text); `false` means the cap
   * elapsed or the stream ended mid-turn. Callers can use this to
   * distinguish "agent finished but said nothing" from "agent timed out"
   * in the metric reason.
   */
  questionCompleted: boolean;
  /** Raw events captured during conversation A's drain. */
  ingestEvents: AgentEvent[];
  /** Raw events captured during conversation B's drain. */
  questionEvents: AgentEvent[];
  /**
   * Token-usage records observed by the egress jail's recording sidecar
   * across *both* conversations — the assistant's real model traffic, parsed
   * from provider responses rather than from anything the assistant chose to
   * emit. This is the un-spoofable basis for the run's assistant-side cost;
   * callers should price these (plus their own judge usage) rather than
   * trusting `ingestEvents`/`questionEvents`. Empty when the adapter exposes
   * no `readUsageRecords()` capability or the sidecar wrote nothing.
   *
   * Captured *before* the agent is retired in the `finally` below — the
   * sidecar is torn down with the agent, so a post-return read would race
   * the cleanup.
   */
  recordedUsage: Array<Record<string, unknown>>;
  /**
   * Whether the ingest turn ended on the completion sentinel (vs. being
   * cut short). Always `true` on a successful return — a missing sentinel
   * throws before this result is produced — but surfaced for callers that
   * want to record it on the run.
   */
  ingestSentinelSeen: boolean;
}

const DEFAULT_QUIET_MS = 30_000;
/**
 * Default hard wall-clock cap for the question turn: 10 minutes. Generous
 * enough for a retrieval-heavy turn (on-demand `file_read`/`grep` over the
 * staged trajectories plus extended thinking) to reach an answer; a turn
 * that blows past it is graded as a completed miss, not an error.
 */
export const DEFAULT_QUESTION_MAX_MS = 600_000;
const DEFAULT_INGEST_QUIET_MS = 120_000;
const DEFAULT_INGEST_SENTINEL = "Ready.";
const DEFAULT_INGEST_MAX_MS = 600_000;

/**
 * Error raised when a two-conversation run cannot proceed. Carries the
 * ingest-turn and question-turn events captured so far (when any) so the
 * caller can still persist them as a debugging artifact even though the
 * run failed before producing a result — e.g. to inspect *why* an ingest
 * never reached its completion sentinel, or what conversation B did when
 * it returned no gradable answer.
 */
export class IngestAskError extends Error {
  constructor(
    message: string,
    readonly ingestEvents: readonly AgentEvent[] = [],
    readonly questionEvents: readonly AgentEvent[] = [],
  ) {
    super(message);
    this.name = "IngestAskError";
  }
}

/**
 * Normalize a single line for sentinel comparison: trim, strip wrapping
 * quotes and trailing sentence punctuation, lowercase. So `"Ready."`,
 * `Ready`, and `ready!` all reduce to `ready`.
 */
function normalizeSentinelLine(line: string): string {
  return line
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Build a predicate that reports whether the assistant has emitted the
 * completion sentinel as a standalone line. Line-oriented (not a loose
 * substring) so an in-passing mention like "I'm getting ready" does not
 * trip it, while tolerating the quotes/punctuation models tend to add.
 */
function makeSentinelPredicate(sentinel: string): (text: string) => boolean {
  const target = normalizeSentinelLine(sentinel);
  return (text) =>
    text.split(/\r?\n/).some((line) => normalizeSentinelLine(line) === target);
}

function assertCapability(
  agent: BaseAgent,
  method: "writeWorkspaceFile" | "newConversation",
  profileId: string,
): void {
  if (typeof agent[method] !== "function") {
    throw new IngestAskError(
      `Profile '${profileId}' adapter does not implement ${method}(). ` +
        `Two-conversation runs require both writeWorkspaceFile() and newConversation(); ` +
        `extend the adapter or pick a profile whose species supports them.`,
    );
  }
}

function joinAssistantText(events: readonly AgentEvent[]): string {
  let out = "";
  for (const event of events) {
    const text = assistantContent(event);
    if (text !== undefined) out += text;
  }
  return out;
}

export async function runIngestAsk(
  input: IngestAskInput,
): Promise<IngestAskResult> {
  const quietMs = input.quietMs ?? DEFAULT_QUIET_MS;
  const questionMaxMs = input.questionMaxMs ?? DEFAULT_QUESTION_MAX_MS;
  const ingestQuietMs = input.ingestQuietMs ?? DEFAULT_INGEST_QUIET_MS;
  const ingestSentinel = input.ingestSentinel ?? DEFAULT_INGEST_SENTINEL;
  const ingestMaxMs = input.ingestMaxMs ?? DEFAULT_INGEST_MAX_MS;
  const isIngestDone = makeSentinelPredicate(ingestSentinel);

  const hatchInput: AgentHatchInput = {
    profile: input.profile,
    // The two-conversation runner is currently only used by the
    // LongMemEval-V2 benchmark; the agent adapter uses `testId` purely
    // as a label inside the conversation key, so we pass the runId
    // through. PR 6 may refine this once the unit-id concept is wired
    // through the benchmark runner.
    testId: input.runId,
    runId: input.runId,
  };
  const agent = createAgent(hatchInput);

  try {
    await agent.hatch();

    // Capability check happens *after* hatch so adapters that throw on
    // missing prerequisites (Docker daemon, env vars) surface those
    // first. Otherwise we'd convert a real infrastructure failure into
    // a misleading "doesn't support newConversation" error.
    assertCapability(agent, "writeWorkspaceFile", input.profile.id);
    assertCapability(agent, "newConversation", input.profile.id);

    for (const file of input.inputs) {
      await agent.writeWorkspaceFile!(file);
    }

    // Conversation A — "ingest".
    const ingestConversationKey = agent.conversationKey;
    const ingestCollector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );
    const ingestSendTime = new Date().toISOString();
    await appendTranscriptTurn(input.runId, {
      role: "simulator",
      content: input.ingestMessage,
      emittedAt: ingestSendTime,
      conversationKey: ingestConversationKey,
    }).catch(() => undefined);
    await agent.send({ content: input.ingestMessage });

    // Auto-approve tool confirmations in both turns. The agent legitimately
    // reaches for tools above the auto-approve risk threshold — to process
    // the staged trajectories during ingest, and to read/extract from them
    // on demand while answering. In a headless hatch nothing answers the
    // resulting `confirmation_request`, so the turn would hang until its cap
    // (the ingest sentinel never arrives; the question turn goes quiet with
    // no answer). Approving on receipt unblocks the turn. A failed approval
    // is logged but not fatal — the run still fails loudly if the turn never
    // completes, and the captured events are persisted for inspection.
    //
    // Also abort early on `conversation_error` — e.g. a provider connection
    // failure. Without this the collector waits the full timeout (600s for
    // ingest, 360s for question) before failing, wasting 10 minutes on a
    // turn that died in the first few seconds. Throwing from onEvent
    // propagates through the collector's drain loop, so the error surfaces
    // in seconds rather than after the full wall-clock cap.
    const autoConfirm = async (event: AgentEvent): Promise<void> => {
      if (event.message?.type === "conversation_error") {
        const errMsg =
          (event.message as { userMessage?: string })?.userMessage ??
          (event.message as { debugDetails?: string })?.debugDetails ??
          "unknown conversation error";
        throw new IngestAskError(
          `Ingest turn failed with conversation error: ${errMsg}`,
        );
      }
      const requestId = confirmationRequestId(event);
      if (requestId === undefined || typeof agent.confirm !== "function") {
        return;
      }
      try {
        await agent.confirm({ requestId, decision: "allow" });
      } catch (err) {
        console.warn(
          `[run-ingest-ask] failed to auto-confirm ${requestId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };

    // Wait for the agent to declare completion via the sentinel rather
    // than treating an event-quiet gap as "done". A truncated or stalled
    // ingest would otherwise be graded as a real run; recall in conversation
    // B depends on the agent having actually finished reading *and*
    // committing to memory here.
    const { events: ingestEvents, sentinelSeen: ingestSentinelSeen } =
      await ingestCollector.collectUntilSentinel({
        isDone: (events) => isIngestDone(joinAssistantText(events)),
        maxMs: ingestMaxMs,
        quietMs: ingestQuietMs,
        onEvent: autoConfirm,
      });
    if (ingestEvents.length === 0) {
      throw new IngestAskError(
        `Ingest turn produced no events for conversation ${ingestConversationKey}.`,
      );
    }
    if (!ingestSentinelSeen) {
      throw new IngestAskError(
        `Ingest turn for conversation ${ingestConversationKey} never emitted the ` +
          `completion sentinel ("${ingestSentinel}") within ${ingestMaxMs}ms ` +
          `(captured ${ingestEvents.length} event(s)). The ingest likely stalled or was ` +
          `truncated — e.g. an unresolved tool confirmation, or the agent did not finish ` +
          `committing to memory. Refusing to grade a truncated ingest; conversation B would ` +
          `have nothing reliable to recall.`,
        ingestEvents,
      );
    }

    // Persist the ingest assistant's response (typically "Ready.") as a
    // transcript turn tagged with the ingest conversation key, so the
    // report UI can group it under the Ingest conversation pane.
    const ingestResponseText = joinAssistantText(ingestEvents).trim();
    if (ingestResponseText) {
      // Use the message_complete event timestamp (or the last text
      // delta) as the turn end, NOT the last event in the array.
      // collectUntilSentinel drains with a 120s quiet window, so
      // unrelated trailing events (disk_pressure, sync_changed) can
      // arrive long after the turn finished and inflate the timestamp.
      const ingestEndStamp = (() => {
        for (let i = ingestEvents.length - 1; i >= 0; i--) {
          const msg = ingestEvents[i].message;
          if (msg.type === "message_complete" && ingestEvents[i].emittedAt) {
            return ingestEvents[i].emittedAt!;
          }
        }
        // Fallback: last event with text content (the actual response).
        for (let i = ingestEvents.length - 1; i >= 0; i--) {
          const text =
            ingestEvents[i].message.text ?? ingestEvents[i].message.chunk;
          if (text && text.trim() && ingestEvents[i].emittedAt) {
            return ingestEvents[i].emittedAt!;
          }
        }
        return ingestSendTime;
      })();
      await appendTranscriptTurn(input.runId, {
        role: "assistant",
        content: ingestResponseText,
        emittedAt: ingestEndStamp,
        conversationKey: ingestConversationKey,
      }).catch(() => undefined);
    }

    // Close A → open B. The agent process and any persistent state
    // (memory layer, staged workspace files) survive; only the chat
    // history resets so the question turn cannot just look at the
    // ingest transcript.
    await agent.newConversation!();
    const questionConversationKey = agent.conversationKey;
    if (questionConversationKey === ingestConversationKey) {
      throw new IngestAskError(
        `newConversation() did not rotate the conversation key (still ${ingestConversationKey}). ` +
          `Adapter bug: the question turn would otherwise reuse the ingest history.`,
      );
    }

    // Conversation B — "ask". Fresh event subscription against the new
    // conversation; mixing it with the ingest collector would risk
    // capturing tail events from the closed conversation.
    const questionCollector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );
    const questionSendTime = new Date().toISOString();
    await appendTranscriptTurn(input.runId, {
      role: "simulator",
      content: input.questionMessage,
      emittedAt: questionSendTime,
      conversationKey: questionConversationKey,
    }).catch(() => undefined);
    await agent.send({ content: input.questionMessage });
    // Use `collectUntilTurnComplete` instead of `collectUntilQuiet` so the
    // collector waits for the daemon's `message_complete` signal rather
    // than cutting the turn short after `quietMs` of event silence. A long
    // LLM call (extended thinking + generation) can stream zero events for
    // 30+ seconds while the model is actively producing a response; a
    // quiet-window collector would abandon the turn mid-call and capture
    // an empty hypothesis even though the agent answered. The turn-
    // completion signal is the authoritative "done" marker.
    const { events: questionEvents, completed: questionCompleted } =
      await questionCollector.collectUntilTurnComplete({
        isComplete: (event) => agent.isTurnComplete(event),
        maxMs: questionMaxMs,
        graceQuietMs: quietMs,
        onEvent: autoConfirm,
      });
    if (questionEvents.length === 0) {
      throw new IngestAskError(
        `Question turn produced no events for conversation ${questionConversationKey}.`,
        ingestEvents,
      );
    }

    // An empty answer is NOT a harness failure. The question turn ran its
    // full course — it went quiet or hit the `questionMaxMs` wall-clock cap
    // — without the agent composing a final answer (e.g. it spent the whole
    // budget on extended thinking and on-demand retrieval). That's a real,
    // gradable outcome ("too slow to answer"), so we return normally with an
    // empty hypothesis and let the caller score it as a completed miss
    // rather than throwing and excluding the run.
    const hypothesis = joinAssistantText(questionEvents);

    // Persist the question-turn assistant response as a transcript turn
    // tagged with the question conversation key.
    if (hypothesis.trim()) {
      const questionEndStamp = (() => {
        for (let i = questionEvents.length - 1; i >= 0; i--) {
          if (questionEvents[i].emittedAt) return questionEvents[i].emittedAt!;
        }
        return questionSendTime;
      })();
      await appendTranscriptTurn(input.runId, {
        role: "assistant",
        content: hypothesis.trim(),
        emittedAt: questionEndStamp,
        conversationKey: questionConversationKey,
      }).catch(() => undefined);
    }

    // Read the egress jail's observed usage while the agent (and its
    // recording sidecar) is still alive — the `finally` retires both.
    const recordedUsage = (await agent.readUsageRecords?.()) ?? [];

    return {
      runId: input.runId,
      profileId: input.profile.id,
      ingestConversationKey,
      questionConversationKey,
      hypothesis,
      questionAnswered: hypothesis.trim() !== "",
      questionCompleted,
      ingestEvents,
      questionEvents,
      recordedUsage,
      ingestSentinelSeen,
    };
  } finally {
    // Best-effort shutdown — never swallow the original throw.
    await agent.shutdown().catch(() => undefined);
  }
}
