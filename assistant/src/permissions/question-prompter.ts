import { v4 as uuid } from "uuid";

import type {
  QuestionOption,
  QuestionRequestEvent,
} from "../api/events/question-request.js";
import { getConfig } from "../config/loader.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("question-prompter");

/**
 * Thrown when a batched submission fails validation (unknown questionId,
 * missing entries, unknown optionId, duplicate questionId). The route layer
 * maps this to a 400.
 */
export class QuestionBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionBatchValidationError";
  }
}

/**
 * One per-question entry in a batched question result.
 *
 * `decision` records how the user responded to that specific question:
 *  - `"option"` / `"free_text"` — direct answer.
 *  - `"skipped"` — the user explicitly skipped this question, or the card
 *    was closed before any answer was submitted.
 *  - `"timed_out"` — the prompt timer fired before the client submitted.
 *  - `"aborted"` — the prompter's abort signal fired before any answer
 *    was submitted.
 *
 * `questionId` matches the daemon-assigned id (`q1`, `q2`...) that the
 * prompter attached to the broadcast.
 */
export interface QuestionPromptEntryResult {
  questionId: string;
  decision: "option" | "free_text" | "skipped" | "timed_out" | "aborted";
  optionId?: string;
  text?: string;
}

/**
 * Aggregate result for a single `prompt()` call. `entries` is ordered to
 * match the original `questions` array; `overall` summarizes how the
 * card lifecycle ended.
 */
export interface QuestionPromptResult {
  entries: QuestionPromptEntryResult[];
  overall: "completed" | "closed" | "timed_out" | "aborted";
}

export interface QuestionPromptParamsEntry {
  question: string;
  description?: string;
  options: QuestionOption[];
  freeTextPlaceholder?: string;
}

export interface QuestionPromptParams {
  conversationId: string;
  /** One or more clarifying questions to broadcast as a single card. */
  questions: QuestionPromptParamsEntry[];
  toolUseId?: string;
  signal?: AbortSignal;
}

/** One per-question submission inside a batch from the client. */
export type QuestionBatchSubmission =
  | { questionId: string; kind: "option"; optionId: string }
  | { questionId: string; kind: "free_text"; text: string }
  | { questionId: string; kind: "skip" };

/**
 * Validate a batched submission against the original ordered ids and per-id
 * option-id sets, and return the ordered per-entry result. The lookup helpers
 * are passed in so callers can back the metadata with whatever container
 * they prefer (Set/Map, plain Record, etc.).
 *
 * Throws {@link QuestionBatchValidationError} if validation fails.
 */
export function buildBatchEntries(
  orderedIds: readonly string[],
  isKnownOption: (questionId: string, optionId: string) => boolean,
  knownQuestionIds: ReadonlySet<string>,
  submissions: readonly QuestionBatchSubmission[],
): QuestionPromptEntryResult[] {
  const submittedIds = new Set<string>();
  for (const s of submissions) {
    if (!knownQuestionIds.has(s.questionId)) {
      throw new QuestionBatchValidationError(
        `Unknown questionId in batch: ${s.questionId}`,
      );
    }
    if (submittedIds.has(s.questionId)) {
      throw new QuestionBatchValidationError(
        `Duplicate questionId in batch: ${s.questionId}`,
      );
    }
    submittedIds.add(s.questionId);
    if (s.kind === "option" && !isKnownOption(s.questionId, s.optionId)) {
      throw new QuestionBatchValidationError(
        `Unknown optionId "${s.optionId}" for question ${s.questionId}`,
      );
    }
  }
  for (const id of orderedIds) {
    if (!submittedIds.has(id)) {
      throw new QuestionBatchValidationError(
        `Missing response for questionId ${id}`,
      );
    }
  }

  const byId = new Map<string, QuestionBatchSubmission>();
  for (const s of submissions) byId.set(s.questionId, s);

  return orderedIds.map((id) => {
    const s = byId.get(id)!;
    if (s.kind === "option") {
      return { questionId: id, decision: "option", optionId: s.optionId };
    }
    if (s.kind === "free_text") {
      return { questionId: id, decision: "free_text", text: s.text };
    }
    return { questionId: id, decision: "skipped" };
  });
}

/**
 * Shape of the per-batch bookkeeping stashed on `PendingInteraction.metadata`.
 * The route reads this to validate batched submissions without needing a
 * reference to the prompter that registered them.
 */
export interface QuestionBatchMetadata {
  orderedIds: string[];
  optionsById: Record<string, string[]>;
}

/**
 * Broadcast an ask-question request to all connected clients and wait for the
 * user's reply. All lifecycle state (rpcResolve, rpcReject, timer, batch
 * metadata) lives on the `pendingInteractions` entry — `/v1/question-response`
 * resolves the entry directly without holding a reference back to the prompter
 * that registered it.
 *
 * Batching: a single `prompt()` call broadcasts one or more questions, and
 * the prompter waits for exactly one resolution call carrying the full
 * ordered response array. The web UI collects per-question answers
 * locally, lets the user revise freely while the card is open, and POSTs
 * the whole batch to `/v1/question-response` when the user is done — no
 * per-question accumulator, no partial state machine.
 *
 * The idle timeout is a backstop (`getConfig().timeouts.questionResponseTimeoutSec`,
 * default 30 min), not the primary way a prompt is dismissed. An interactive
 * user who moves on instead of answering enqueues another message, which
 * supersedes the open prompt at the enqueue handler (see conversation-routes.ts);
 * a non-interactive turn resolves immediately at the tool. The backstop only
 * fires when a prompt is left open with no response and no follow-up message.
 */
export class QuestionPrompter {
  async prompt(params: QuestionPromptParams): Promise<QuestionPromptResult> {
    const { conversationId, questions, toolUseId, signal } = params;

    if (questions.length === 0) {
      throw new AssistantError(
        "QuestionPrompter.prompt requires at least one question",
        ErrorCode.INTERNAL_ERROR,
      );
    }

    // Assign per-question ids (`q1`, `q2`, ...) — daemon-side only; the LLM
    // never sees these. Build the on-wire entries in the same pass.
    const entries = questions.map((q, i) => ({
      id: `q${i + 1}`,
      question: q.question,
      description: q.description,
      options: q.options,
      freeTextPlaceholder: q.freeTextPlaceholder,
    }));
    const orderedIds = entries.map((e) => e.id);
    const optionsById: Record<string, string[]> = {};
    for (const e of entries) {
      optionsById[e.id] = e.options.map((o) => o.id);
    }

    if (signal?.aborted) {
      return {
        entries: orderedIds.map((id) => ({
          questionId: id,
          decision: "aborted",
        })),
        overall: "aborted",
      };
    }

    const requestId = uuid();

    return new Promise<QuestionPromptResult>((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.questionResponseTimeoutSec * 1000;

      // Closure-scoped idempotency guard. Every resolution path (timeout,
      // abort, route resolution via `rpcResolve`/`rpcReject`) routes through
      // `finish()`, which tears down the timer + abort listener exactly
      // once. We cannot use `pendingInteractions.resolve(requestId) ===
      // undefined` as the guard because `removeByConversation()` (called
      // during auto-deny on enqueue) can deregister the entry before any of
      // our local handlers fire — using the registry as the guard in that
      // case would leave the Promise unresolved and the tool hung.
      let settled = false;
      let onAbort: (() => void) | undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        // Idempotent: a no-op if the entry was already removed (e.g. by
        // `removeByConversation`) or by an earlier path. The route's
        // success path resolves with "answered" before invoking rpcResolve,
        // so this fallback only fires for timeout / abort / removeByConversation —
        // all cancellation-shaped outcomes.
        pendingInteractions.resolve(requestId, "cancelled");
        fn();
      };

      const timer = setTimeout(() => {
        log.warn({ requestId, conversationId }, "Question prompt timed out");
        finish(() =>
          resolve({
            entries: orderedIds.map((id) => ({
              questionId: id,
              decision: "timed_out",
            })),
            overall: "timed_out",
          }),
        );
      }, timeoutMs);

      if (signal) {
        onAbort = () => {
          finish(() =>
            resolve({
              entries: orderedIds.map((id) => ({
                questionId: id,
                decision: "aborted",
              })),
              overall: "aborted",
            }),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Stash the per-question metadata on the interaction so the route can
      // validate batched submissions without holding a prompter reference.
      // Route resolution funnels through `finish()` so the same teardown +
      // idempotency guard applies whether the response comes from the route,
      // a timeout, or an abort.
      pendingInteractions.register(requestId, {
        conversationId,
        kind: "question",
        rpcResolve: (value: unknown) =>
          finish(() => resolve(value as QuestionPromptResult)),
        rpcReject: (err: unknown) => finish(() => reject(err)),
        timer,
        toolUseId,
        metadata: { orderedIds, optionsById } satisfies QuestionBatchMetadata,
        // Persist the full entries (not just the id maps in `metadata`) so a
        // history-load render can stamp this outstanding prompt back onto its
        // tool call and rehydrate the question card after a reconnect.
        questionDetails: { entries },
      });

      // Populate both shapes on the wire: `questions[]` is the canonical
      // batched payload, and the flat fields mirror `questions[0]` for
      // backwards compat with clients that haven't adopted `questions[]`.
      const head = entries[0]!;
      const msg: QuestionRequestEvent = {
        type: "question_request",
        requestId,
        questions: entries,
        question: head.question,
        description: head.description,
        options: head.options,
        freeTextPlaceholder: head.freeTextPlaceholder,
        conversationId,
        toolUseId,
      };

      broadcastMessage(msg);
    });
  }
}
