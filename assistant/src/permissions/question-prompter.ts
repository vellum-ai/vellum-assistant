import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import type {
  QuestionOption,
  QuestionRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("question-prompter");

export interface QuestionPromptResult {
  decision: "option" | "free_text" | "timed_out" | "aborted";
  optionId?: string;
  text?: string;
}

export interface QuestionPromptParams {
  conversationId: string;
  question: string;
  description?: string;
  options: QuestionOption[];
  allowFreeText?: boolean;
  freeTextPlaceholder?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}

export type QuestionResponse =
  | { kind: "option"; optionId: string }
  | { kind: "free_text"; text: string };

/**
 * Broadcast an ask-question request to all connected clients and wait for the
 * user's reply. Mirrors the {@link SecretPrompter} and {@link PermissionPrompter}
 * patterns: lifecycle state (rpcResolve, rpcReject, timer) lives in
 * pendingInteractions; this class only tracks ownership so dispose can scope
 * cleanup to a single conversation.
 *
 * Timeout reuses `getConfig().timeouts.permissionTimeoutSec` (default 5 min) —
 * questions are user-prompts in the same UX family as permission prompts and
 * secret prompts, so they share the same idle-timeout knob.
 */
export class QuestionPrompter {
  private ownedIds = new Set<string>();

  constructor(
    private deps: { broadcastMessage(msg: ServerMessage): void },
  ) {}

  async prompt(params: QuestionPromptParams): Promise<QuestionPromptResult> {
    const {
      conversationId,
      question,
      description,
      options,
      freeTextPlaceholder,
      toolUseId,
      signal,
    } = params;

    if (signal?.aborted) return { decision: "aborted" };

    const requestId = uuid();

    return new Promise((resolve, reject) => {
      const timeoutMs = getConfig().timeouts.permissionTimeoutSec * 1000;

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId);
        this.ownedIds.delete(requestId);
        log.warn({ requestId, conversationId }, "Question prompt timed out");
        resolve({ decision: "timed_out" });
      }, timeoutMs);

      pendingInteractions.register(requestId, {
        conversationId,
        kind: "question",
        rpcResolve: resolve as (value: unknown) => void,
        rpcReject: reject,
        timer,
        toolUseId,
      });
      this.ownedIds.add(requestId);

      if (signal) {
        const onAbort = () => {
          if (this.ownedIds.has(requestId)) {
            pendingInteractions.resolve(requestId);
            this.ownedIds.delete(requestId);
            resolve({ decision: "aborted" });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Populate both shapes on the wire: `questions[]` is the canonical
      // batched payload, and the flat fields mirror `questions[0]` for
      // backwards compat with clients that haven't adopted `questions[]`.
      const msg: QuestionRequest = {
        type: "question_request",
        requestId,
        questions: [
          {
            id: "q1",
            question,
            description,
            options,
            freeTextPlaceholder,
          },
        ],
        question,
        description,
        options,
        freeTextPlaceholder,
        conversationId,
        toolUseId,
      };

      this.deps.broadcastMessage(msg);
    });
  }

  hasPendingRequest(requestId: string): boolean {
    return this.ownedIds.has(requestId);
  }

  resolveQuestion(requestId: string, response: QuestionResponse): void {
    if (!this.ownedIds.has(requestId)) {
      log.warn({ requestId }, "No pending prompt for question response");
      return;
    }
    const interaction = pendingInteractions.resolve(requestId);
    this.ownedIds.delete(requestId);
    const result: QuestionPromptResult =
      response.kind === "option"
        ? { decision: "option", optionId: response.optionId }
        : { decision: "free_text", text: response.text };
    (interaction?.rpcResolve as
      | ((v: QuestionPromptResult) => void)
      | undefined)?.(result);
  }

  dispose(): void {
    for (const requestId of [...this.ownedIds]) {
      const interaction = pendingInteractions.resolve(requestId);
      this.ownedIds.delete(requestId);
      interaction?.rpcReject?.(
        new AssistantError("Prompter disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
  }
}
