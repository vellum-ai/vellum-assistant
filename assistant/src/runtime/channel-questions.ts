/**
 * Channel-native `ask_question` wizard orchestration.
 *
 * The channel analog of {@link file://./channel-approvals.ts}. When
 * `ask_question` parks on a wizard-capable channel (Telegram today), the
 * pending `question` interaction is rendered as an inline-keyboard "wizard":
 * one question at a time, each advanced by editing the same message in place.
 *
 * Responsibility split (mirrors the approval seam):
 *  - This module owns the in-memory wizard state (accumulated answers + the
 *    delivered Telegram message id) and the record → submit transitions.
 *  - Outbound rendering is driven by the watcher in `background-dispatch.ts`
 *    (`startPendingQuestionPromptWatcher`) — the single outbound owner. It
 *    reads {@link buildQuestionWizardStep} to send/advance the card and
 *    {@link buildQuestionWizardSummary} to finalize it.
 *  - Inbound taps (`qst:` callbacks) and free-text replies only mutate state,
 *    via {@link recordQuestionTap} / {@link recordQuestionFreeTextForConversation}.
 *
 * Progress is tracked implicitly by `answers.size`: answers accumulate strictly
 * in question order (each step answers the current question), so the current
 * step is `entries[answers.size]` and the batch is complete when
 * `answers.size === entries.length`. Submission funnels through the shared
 * {@link resolvePendingQuestion} so the channel path and `/v1/question-response`
 * validate and resolve identically.
 *
 * State is in-memory and keyed by requestId: lost on daemon restart mid-wizard,
 * after which the parked turn's idle timeout cleans up. Durable wizard state is
 * out of scope.
 */

import type { QuestionUIMetadata } from "@vellumai/gateway-client";

import type {
  QuestionEntry,
  QuestionOption,
} from "../api/events/question-request.js";
import type { QuestionBatchSubmission } from "../permissions/question-prompter.js";
import { getLogger } from "../util/logger.js";
import * as pendingInteractions from "./pending-interactions.js";
import {
  type QuestionResolutionOutcome,
  resolvePendingQuestion,
} from "./question-resolution.js";

const log = getLogger("channel-questions");

interface QuestionWizardState {
  requestId: string;
  conversationId: string;
  /** The daemon-assigned entries (q1, q2, …) with their options. */
  entries: QuestionEntry[];
  /** Recorded answers keyed by questionId; size doubles as the progress cursor. */
  answers: Map<string, QuestionBatchSubmission>;
  /** Telegram message id of the wizard card, set once the watcher delivers it. */
  messageTs?: string;
}

/** Wizard states keyed by requestId. */
const wizards = new Map<string, QuestionWizardState>();

// ---------------------------------------------------------------------------
// Pending question discovery
// ---------------------------------------------------------------------------

/** Minimal projection of a pending `question` interaction for channel flows. */
export interface PendingQuestionInfo {
  requestId: string;
  entries: QuestionEntry[];
}

/**
 * Pending `question` interactions for a conversation, mapped to the channel
 * projection. Mirrors `getApprovalInfoByConversation`.
 */
export function getPendingQuestionInfoByConversation(
  conversationId: string,
): PendingQuestionInfo[] {
  return pendingInteractions
    .getByConversation(conversationId)
    .filter((i) => i.kind === "question" && i.questionDetails)
    .map((i) => ({
      requestId: i.requestId,
      entries: i.questionDetails!.entries,
    }));
}

// ---------------------------------------------------------------------------
// Wizard state lifecycle
// ---------------------------------------------------------------------------

/**
 * Get the wizard state for a requestId, initializing it from the pending
 * `question` interaction on first access. Returns `null` when no
 * conversation-scoped `question` interaction is registered for the requestId
 * (already resolved, wrong kind, or conversation-less).
 */
export function ensureQuestionWizardState(
  requestId: string,
): QuestionWizardState | null {
  const existing = wizards.get(requestId);
  if (existing) {
    return existing;
  }

  const interaction = pendingInteractions.get(requestId);
  if (
    !interaction ||
    interaction.kind !== "question" ||
    !interaction.questionDetails ||
    !interaction.conversationId
  ) {
    return null;
  }

  const state: QuestionWizardState = {
    requestId,
    conversationId: interaction.conversationId,
    entries: interaction.questionDetails.entries,
    answers: new Map(),
  };
  wizards.set(requestId, state);
  return state;
}

/** The lingering wizard state for a conversation, if any (for finalize). */
export function getQuestionWizardStateByConversation(
  conversationId: string,
): QuestionWizardState | undefined {
  for (const state of wizards.values()) {
    if (state.conversationId === conversationId) {
      return state;
    }
  }
  return undefined;
}

/** Record the delivered card's message id so later steps edit it in place. */
export function setQuestionWizardMessageTs(
  requestId: string,
  messageTs: string,
): void {
  const state = wizards.get(requestId);
  if (state) {
    state.messageTs = messageTs;
  }
}

/** Remove a wizard's state (after finalize, or when it can't be rendered). */
export function clearQuestionWizardState(requestId: string): void {
  wizards.delete(requestId);
}

/** The current (first unanswered) entry, or `undefined` when complete. */
function currentEntry(state: QuestionWizardState): QuestionEntry | undefined {
  return state.entries[state.answers.size];
}

// ---------------------------------------------------------------------------
// Outbound rendering (consumed by the watcher)
// ---------------------------------------------------------------------------

/** One wizard step's display text + the single-entry metadata to render it. */
export interface QuestionWizardStep {
  /** 0-based index of the question this step shows. */
  stepIndex: number;
  /** Message body text (question + optional description + progress). */
  text: string;
  /** Single-entry metadata the Telegram adapter turns into an option keyboard. */
  question: QuestionUIMetadata;
}

/**
 * The step the wizard should currently render, or `null` when every question is
 * answered (the watcher finalizes instead). The metadata carries exactly the
 * current entry — the adapter renders `questions[0]`.
 */
export function buildQuestionWizardStep(
  state: QuestionWizardState,
): QuestionWizardStep | null {
  const stepIndex = state.answers.size;
  const entry = state.entries[stepIndex];
  if (!entry) {
    return null;
  }

  const total = state.entries.length;
  const text = formatStepText(entry, stepIndex, total);
  const question: QuestionUIMetadata = {
    requestId: state.requestId,
    questions: [
      {
        id: entry.id,
        question: entry.question,
        ...(entry.description ? { description: entry.description } : {}),
        options: entry.options.map(toUiOption),
        ...(entry.freeTextPlaceholder
          ? { freeTextPlaceholder: entry.freeTextPlaceholder }
          : {}),
      },
    ],
    plainTextFallback: text,
  };
  return { stepIndex, text, question };
}

function toUiOption(option: QuestionOption): {
  id: string;
  label: string;
  description?: string;
} {
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  };
}

function formatStepText(
  entry: QuestionEntry,
  stepIndex: number,
  total: number,
): string {
  const parts = [entry.question];
  if (entry.description) {
    parts.push(entry.description);
  }
  if (total > 1) {
    parts.push(`\n(${stepIndex + 1}/${total})`);
  }
  return parts.join("\n");
}

/**
 * Final-card text once the wizard is done: a recap of each question and the
 * recorded answer when the batch completed, or a neutral notice when the
 * interaction was resolved externally (timeout / supersede) before completion.
 * The watcher delivers this with the keyboard removed.
 */
export function buildQuestionWizardSummary(state: QuestionWizardState): string {
  if (state.answers.size < state.entries.length) {
    return "This question is no longer active.";
  }
  return state.entries
    .map((entry) => {
      const answer = state.answers.get(entry.id);
      return `${entry.question}\n→ ${describeAnswer(entry, answer)}`;
    })
    .join("\n\n");
}

function describeAnswer(
  entry: QuestionEntry,
  answer: QuestionBatchSubmission | undefined,
): string {
  if (!answer || answer.kind === "skip") {
    return "Skipped";
  }
  if (answer.kind === "free_text") {
    return answer.text;
  }
  const option = entry.options.find((o) => o.id === answer.optionId);
  return option?.label ?? answer.optionId;
}

// ---------------------------------------------------------------------------
// Inbound recording (consumed by the intercepts)
// ---------------------------------------------------------------------------

/** Outcome of recording an inbound answer against the wizard. */
export type QuestionRecordResult =
  /** No conversation-scoped pending question for this id — nothing to record. */
  | { status: "no_pending" }
  /** Tap for a non-current question or an out-of-range option — ignore. */
  | { status: "stale" }
  /** Answer recorded. `completed` → the batch was submitted; see `outcome`. */
  | {
      status: "recorded";
      requestId: string;
      completed: boolean;
      outcome?: QuestionResolutionOutcome;
    };

/**
 * Record a tap (`qst:<requestId>:<questionId>:<optionIndex|skip>`) against the
 * wizard. Index-guarded: only a tap for the current question advances; taps for
 * an already-answered or not-yet-current question are `stale`.
 */
export function recordQuestionTap(
  requestId: string,
  questionId: string,
  selection: number | "skip",
): QuestionRecordResult {
  const state = ensureQuestionWizardState(requestId);
  if (!state) {
    return { status: "no_pending" };
  }

  const entry = currentEntry(state);
  if (!entry || entry.id !== questionId) {
    return { status: "stale" };
  }

  let submission: QuestionBatchSubmission;
  if (selection === "skip") {
    submission = { questionId, kind: "skip" };
  } else {
    const option = entry.options[selection];
    if (!option) {
      return { status: "stale" };
    }
    submission = { questionId, kind: "option", optionId: option.id };
  }
  state.answers.set(questionId, submission);
  return submitIfComplete(state);
}

/**
 * Record a free-text reply as the answer to the wizard's current question.
 * Looks the wizard up by conversation (a free-text reply carries no requestId).
 */
export function recordQuestionFreeTextForConversation(
  conversationId: string,
  text: string,
): QuestionRecordResult {
  const info = getPendingQuestionInfoByConversation(conversationId)[0];
  if (!info) {
    return { status: "no_pending" };
  }

  const state = ensureQuestionWizardState(info.requestId);
  if (!state) {
    return { status: "no_pending" };
  }

  const entry = currentEntry(state);
  if (!entry) {
    return { status: "stale" };
  }

  state.answers.set(entry.id, {
    questionId: entry.id,
    kind: "free_text",
    text,
  });
  return submitIfComplete(state);
}

/**
 * Submit the accumulated batch once every question is answered, via the shared
 * resolver. Leaves the wizard state in place so the watcher can finalize the
 * card from it; the watcher clears it afterward.
 */
function submitIfComplete(state: QuestionWizardState): QuestionRecordResult {
  if (state.answers.size < state.entries.length) {
    return { status: "recorded", requestId: state.requestId, completed: false };
  }

  const submissions = state.entries.map((e) => state.answers.get(e.id)!);
  const outcome = resolvePendingQuestion(state.requestId, {
    kind: "submit",
    submissions,
  });
  if (outcome.status !== "resolved") {
    log.warn(
      { requestId: state.requestId, outcome: outcome.status },
      "Question wizard completed but resolution did not settle",
    );
  }
  return {
    status: "recorded",
    requestId: state.requestId,
    completed: true,
    outcome,
  };
}

/** Test-only: drop all wizard state. */
export function _clearAllQuestionWizardState(): void {
  wizards.clear();
}
