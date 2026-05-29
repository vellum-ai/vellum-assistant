/**
 * Public entry point for the LongMemEval-V2 evaluator. Dispatches per
 * question's `eval_function` spec string to one of:
 *
 *  Deterministic (no LLM):
 *    - norm_phrase_set_match
 *    - norm_phrase_set_match_ordered
 *    - mc_choice_match
 *    - mc_choice_set_match
 *
 *  LLM judges (default model `gpt-5.2`, reasoning_effort=medium):
 *    - llm_abstention_checker — flawed-premise questions
 *    - llm_gotchas_checker    — insight-style gotchas
 *
 * Mirrors `eval_from_spec` in V2's `evaluation/qa_eval_metrics.py`:
 * caller-supplied overrides win over per-question spec kwargs.
 */

import {
  mcChoiceMatch,
  mcChoiceSetMatch,
  normPhraseSetMatch,
  normPhraseSetMatchOrdered,
  type McChoiceMatchOptions,
  type McChoiceSetMatchOptions,
  type PhraseSetMatchOptions,
} from "./deterministic";
import {
  llmAbstentionChecker,
  llmGotchasChecker,
  type LlmJudgeOptions,
} from "./llm";
import { parseEvalFunctionSpec } from "./spec";

export interface EvalInputs {
  prediction: unknown;
  answer: unknown;
  /** Question record (used by LLM judges to pull `question.text`). */
  questionItem?: Record<string, unknown> | null;
  /** Extracted "final answer" from the model, when distinct from prediction. */
  parsedPrediction?: string | null;
  /** Raw full model response, when distinct from prediction. */
  modelResponse?: string | null;
}

/** Caller-side overrides applied after the per-question spec kwargs. */
export type EvalOverrides = LlmJudgeOptions &
  PhraseSetMatchOptions &
  McChoiceMatchOptions &
  McChoiceSetMatchOptions;

export interface EvalResult {
  label: boolean;
  /** Populated by LLM judges; empty string for deterministic functions. */
  reason: string;
  /** The dispatched function name in V2 snake_case, for logging/audit. */
  function: string;
  /**
   * Normalized usage record from the LLM judge's chat-completion call,
   * shaped to drop straight onto an `AgentEvent.message.usage` slot
   * that `summarizeAssistantUsage` will price. See `LlmJudgeResult.usage`
   * docstring for the field layout.
   *
   * Always omitted for deterministic functions (`norm_phrase_set_match`,
   * `mc_choice_match`, …) because no network call is made. Even on the
   * LLM judge path, it stays omitted if the upstream response carried
   * no `usage` block (local non-OpenAI endpoints sometimes skip it) —
   * the report's "missing" code path is the honest answer there.
   */
  usage?: Record<string, unknown>;
}

export async function evalFromSpec(
  spec: string,
  inputs: EvalInputs,
  overrides: EvalOverrides = {},
): Promise<EvalResult> {
  const { name, kwargs } = parseEvalFunctionSpec(spec);
  const merged = { ...kwargs, ...overrides };

  switch (name) {
    case "norm_phrase_set_match":
      return {
        label: normPhraseSetMatch(
          inputs.prediction,
          inputs.answer,
          merged as PhraseSetMatchOptions,
        ),
        reason: "",
        function: name,
      };
    case "norm_phrase_set_match_ordered":
      return {
        label: normPhraseSetMatchOrdered(
          inputs.prediction,
          inputs.answer,
          merged as PhraseSetMatchOptions,
        ),
        reason: "",
        function: name,
      };
    case "mc_choice_match":
      return {
        label: mcChoiceMatch(
          inputs.prediction,
          inputs.answer,
          merged as McChoiceMatchOptions,
        ),
        reason: "",
        function: name,
      };
    case "mc_choice_set_match":
      return {
        label: mcChoiceSetMatch(
          inputs.prediction,
          inputs.answer,
          merged as McChoiceSetMatchOptions,
        ),
        reason: "",
        function: name,
      };
    case "llm_abstention_checker": {
      const result = await llmAbstentionChecker(
        inputs.prediction,
        inputs.answer,
        {
          ...(merged as LlmJudgeOptions),
          questionItem: inputs.questionItem ?? null,
          parsedPrediction: inputs.parsedPrediction ?? null,
          modelResponse: inputs.modelResponse ?? null,
        },
      );
      return { ...result, function: name };
    }
    case "llm_gotchas_checker": {
      const result = await llmGotchasChecker(inputs.prediction, inputs.answer, {
        ...(merged as LlmJudgeOptions),
        questionItem: inputs.questionItem ?? null,
        parsedPrediction: inputs.parsedPrediction ?? null,
        modelResponse: inputs.modelResponse ?? null,
      });
      return { ...result, function: name };
    }
    default:
      throw new Error(`Unknown eval function: ${name}`);
  }
}

export { parseEvalFunctionSpec, parseEvalValue } from "./spec";
export { normalizePhrase, splitPhrases, DEFAULT_SEPARATORS } from "./normalize";
export {
  mcChoiceMatch,
  mcChoiceSetMatch,
  normPhraseSetMatch,
  normPhraseSetMatchOrdered,
  extractMultiSelectLetters,
} from "./deterministic";
export {
  llmAbstentionChecker,
  llmGotchasChecker,
  DEFAULT_EVALUATOR_MODEL,
  DEFAULT_EVALUATOR_REASONING_EFFORT,
  DEFAULT_EVALUATOR_MAX_COMPLETION_TOKENS,
  DEFAULT_EVALUATOR_TIMEOUT_SECONDS,
  DEFAULT_EVALUATOR_API_KEY_ENV,
  DEFAULT_OPENAI_BASE_URL,
  type LlmJudgeOptions,
  type LlmJudgeResult,
  type ReasoningEffort,
} from "./llm";
export {
  parseLlmBinaryJudgement,
  stripMarkdownCodeFence,
  type ParsedJudgement,
} from "./judgement";
