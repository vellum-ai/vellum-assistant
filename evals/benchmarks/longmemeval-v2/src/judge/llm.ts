/**
 * LLM judges. TypeScript ports of `llm_abstention_checker` and
 * `llm_gotchas_checker` from V2's `evaluation/qa_eval_metrics.py`.
 *
 * Both judges:
 *  - issue an OpenAI-shape chat completion against `evaluatorModel`
 *    (V2 default = `gpt-5.2` with `reasoning_effort=medium`)
 *  - use a strict system prompt + a rubric-laden user prompt
 *  - require a JSON binary judgement `{"label": 0|1, "reason": "..."}`
 *
 * Transport is a direct `fetch` to the chat completions endpoint, matching
 * `simulator/user-simulator.ts`. Tests swap `globalThis.fetch`; no
 * production wrapper.
 */

import { parseLlmBinaryJudgement } from "./judgement";

const ABSTENTION_JUDGE_SYSTEM_PROMPT =
  "You are a strict grader for flawed-premise (abstention) questions. " +
  "Judge whether a model answer correctly identifies that the question premise is wrong, " +
  "consistent with the reference answer. " +
  "If the model follows the flawed premise and gives a concrete answer under that premise, " +
  "it must be graded 0. " +
  "If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. " +
  "If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. " +
  "Paraphrases are allowed when they preserve the same core flaw described by the reference answer.";

const GOTCHAS_JUDGE_SYSTEM_PROMPT =
  "You are a strict grader for gotchas-style insight questions. " +
  "The reference answer describes the key insight(s). " +
  "Grade 1 if the model response includes at least one correct insight point from the reference answer " +
  "(paraphrase allowed), and does not contradict any reference point. " +
  "If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. " +
  "If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.";

/** V2 `run_eval.py` defaults. */
export const DEFAULT_EVALUATOR_MODEL = "gpt-5.2";
export const DEFAULT_EVALUATOR_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_EVALUATOR_MAX_COMPLETION_TOKENS = 2048;
export const DEFAULT_EVALUATOR_TIMEOUT_SECONDS = 43200;
export const DEFAULT_EVALUATOR_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export type ReasoningEffort = "low" | "medium" | "high";

export interface LlmJudgeOptions {
  evaluatorModel?: string;
  evaluatorBaseUrl?: string;
  evaluatorApiKey?: string;
  /** Env var to read the API key from when `evaluatorApiKey` is omitted. */
  evaluatorApiKeyEnv?: string;
  evaluatorReasoningEffort?: ReasoningEffort;
  evaluatorMaxCompletionTokens?: number;
  evaluatorTemperature?: number;
  evaluatorTopP?: number;
  evaluatorTimeoutSeconds?: number;
  requireNonEmpty?: boolean;

  /** Question record, used to pull `question.text` into the prompt. */
  questionItem?: Record<string, unknown> | null;
  /** Extracted "final answer" from the model response, if available. */
  parsedPrediction?: string | null;
  /** Raw full model response, if it differs from `prediction`. */
  modelResponse?: string | null;
}

export interface LlmJudgeResult {
  label: boolean;
  reason: string;
}

export async function llmAbstentionChecker(
  prediction: unknown,
  answer: unknown,
  opts: LlmJudgeOptions = {},
): Promise<LlmJudgeResult> {
  return runLlmJudge({
    systemPrompt: ABSTENTION_JUDGE_SYSTEM_PROMPT,
    buildUserPrompt: buildAbstentionUserPrompt,
    prediction,
    answer,
    opts,
  });
}

export async function llmGotchasChecker(
  prediction: unknown,
  answer: unknown,
  opts: LlmJudgeOptions = {},
): Promise<LlmJudgeResult> {
  return runLlmJudge({
    systemPrompt: GOTCHAS_JUDGE_SYSTEM_PROMPT,
    buildUserPrompt: buildGotchasUserPrompt,
    prediction,
    answer,
    opts,
  });
}

interface JudgeRun {
  systemPrompt: string;
  buildUserPrompt: (args: UserPromptInputs) => string;
  prediction: unknown;
  answer: unknown;
  opts: LlmJudgeOptions;
}

async function runLlmJudge(run: JudgeRun): Promise<LlmJudgeResult> {
  const predictionText = stringify(run.prediction);
  const answerText = stringify(run.answer);
  const requireNonEmpty = run.opts.requireNonEmpty ?? true;
  if (requireNonEmpty && (!predictionText || !answerText)) {
    return { label: false, reason: "empty prediction or answer" };
  }

  const evaluatorModel = run.opts.evaluatorModel ?? DEFAULT_EVALUATOR_MODEL;
  const apiKey = resolveApiKey(run.opts);
  if (!apiKey) {
    throw new Error(
      "LLM judge requires an API key. Set evaluatorApiKey, set the env var named " +
        "by evaluatorApiKeyEnv (default OPENAI_API_KEY), or supply evaluatorBaseUrl " +
        "for a key-less local endpoint.",
    );
  }

  const questionText = extractQuestionText(run.opts.questionItem);
  const finalAnswerText =
    stringify(run.opts.parsedPrediction) || predictionText;
  const fullResponseText = stringify(run.opts.modelResponse) || predictionText;
  if (requireNonEmpty && !finalAnswerText) {
    return { label: false, reason: "empty final answer" };
  }

  const userPrompt = run.buildUserPrompt({
    questionText,
    referenceAnswer: answerText,
    modelFullResponse: fullResponseText,
    modelFinalAnswer: finalAnswerText,
  });

  const judgeText = await callChatCompletion({
    apiKey,
    baseUrl: run.opts.evaluatorBaseUrl ?? DEFAULT_OPENAI_BASE_URL,
    model: evaluatorModel,
    messages: [
      { role: "system", content: run.systemPrompt },
      { role: "user", content: userPrompt },
    ],
    maxCompletionTokens:
      run.opts.evaluatorMaxCompletionTokens ??
      DEFAULT_EVALUATOR_MAX_COMPLETION_TOKENS,
    reasoningEffort:
      run.opts.evaluatorReasoningEffort ?? DEFAULT_EVALUATOR_REASONING_EFFORT,
    temperature: run.opts.evaluatorTemperature,
    topP: run.opts.evaluatorTopP,
    timeoutSeconds:
      run.opts.evaluatorTimeoutSeconds ?? DEFAULT_EVALUATOR_TIMEOUT_SECONDS,
  });

  const parsed = parseLlmBinaryJudgement(judgeText);
  return { label: parsed.label === 1, reason: parsed.reason };
}

interface UserPromptInputs {
  questionText: string;
  referenceAnswer: string;
  modelFullResponse: string;
  modelFinalAnswer: string;
}

function buildAbstentionUserPrompt(args: UserPromptInputs): string {
  return (
    "Evaluate whether the model correctly handled a flawed-premise question.\n\n" +
    "Question:\n" +
    `${args.questionText}\n\n` +
    "Reference answer (the expected flaw-aware conclusion):\n" +
    `${args.referenceAnswer}\n\n` +
    "Model full response:\n" +
    `${args.modelFullResponse}\n\n` +
    "Model extracted final answer:\n" +
    `${args.modelFinalAnswer}\n\n` +
    "Scoring rubric:\n" +
    "- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion " +
    "equivalent to the reference answer.\n" +
    "- Label 1 also if the model explicitly says it lacks access to the user's specific " +
    "live environment/instance/configuration and therefore cannot verify, provided it does not " +
    "give a concrete premise-following answer.\n" +
    "- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n" +
    "- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not " +
    "make the explicit environment-access limitation clear.\n" +
    "- Label 0 if contradictory.\n\n" +
    "Output JSON only:\n" +
    '{"label": 0 or 1, "reason": "short rationale"}'
  );
}

function buildGotchasUserPrompt(args: UserPromptInputs): string {
  return (
    "Evaluate whether the model answer captures the gotcha insight.\n\n" +
    "Question:\n" +
    `${args.questionText}\n\n` +
    "Reference answer (insight points):\n" +
    `${args.referenceAnswer}\n\n` +
    "Model full response:\n" +
    `${args.modelFullResponse}\n\n` +
    "Model extracted final answer:\n" +
    `${args.modelFinalAnswer}\n\n` +
    "Scoring rubric:\n" +
    "- Label 1 if the model includes at least one correct insight point from the reference answer " +
    "(paraphrase acceptable), and does not contradict any reference point.\n" +
    "- Label 1 even if only part of a multi-point reference answer is covered, as long as there is " +
    "no contradiction.\n" +
    "- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n" +
    "- Label 0 if any point in the model response contradicts any reference point.\n" +
    "- Label 0 if the response is irrelevant or generic without insight.\n\n" +
    "Output JSON only:\n" +
    '{"label": 0 or 1, "reason": "short rationale"}'
  );
}

interface ChatCompletionRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ReadonlyArray<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxCompletionTokens: number;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  topP?: number;
  timeoutSeconds: number;
}

async function callChatCompletion(
  request: ChatCompletionRequest,
): Promise<string> {
  const url = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    max_completion_tokens: request.maxCompletionTokens,
  };
  if (request.reasoningEffort !== undefined) {
    body.reasoning_effort = request.reasoningEffort;
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    Math.max(1, request.timeoutSeconds) * 1000,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Evaluator chat completion failed: HTTP ${response.status} ${response.statusText}` +
        (errorBody ? ` — ${errorBody.slice(0, 400)}` : ""),
    );
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const messageContent = data.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    const trimmed = messageContent.trim();
    if (trimmed) return trimmed;
  }
  if (Array.isArray(messageContent)) {
    const textParts: string[] = [];
    for (const item of messageContent) {
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text: unknown }).text === "string"
      ) {
        textParts.push((item as { text: string }).text);
      }
    }
    const joined = textParts.join("\n").trim();
    if (joined) return joined;
  }
  throw new Error("Evaluator model returned empty response content.");
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
}

function resolveApiKey(opts: LlmJudgeOptions): string | undefined {
  if (opts.evaluatorApiKey !== undefined) return opts.evaluatorApiKey;
  const envKey = opts.evaluatorApiKeyEnv ?? DEFAULT_EVALUATOR_API_KEY_ENV;
  const envValue = process.env[envKey];
  if (envValue) return envValue;
  // Mirror Python: a base URL implies a local server that may accept "EMPTY".
  if (opts.evaluatorBaseUrl) return "EMPTY";
  return undefined;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function extractQuestionText(
  item: Record<string, unknown> | null | undefined,
): string {
  if (!item || typeof item !== "object") return "";
  const q = (item as Record<string, unknown>).question;
  if (typeof q === "string") return q.trim();
  if (
    q &&
    typeof q === "object" &&
    "text" in q &&
    typeof (q as { text: unknown }).text === "string"
  ) {
    return (q as { text: string }).text.trim();
  }
  return "";
}
