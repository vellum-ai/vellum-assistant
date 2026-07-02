import OpenAI from "openai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { escapeXmlAttr } from "../../util/xml.js";
import { PLACEHOLDER_EMPTY_TURN } from "../placeholder-sentinels.js";
import { createStreamTimeout } from "../stream-timeout.js";
import { createToolProgressEmitter } from "../tool-progress-events.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";
import {
  ContextOverflowError,
  extractOverflowTokensFromMessage,
} from "../types.js";
import {
  isUnparseableToolArgs,
  wrapUnparseableToolArgs,
} from "../unparseable-tool-args.js";
import {
  captureRawErrorBodyFetch,
  formatNormalizedOpenAIAPIError,
  normalizeOpenAIAPIError,
} from "./api-error-normalization.js";
import {
  coerceObjectParamsToJsonString,
  decodeCoercedObjectArgs,
} from "./coerce-object-args.js";

/**
 * Detect OpenAI-compatible context-overflow signals on an `OpenAI.APIError`.
 *
 * OpenAI proper returns HTTP 400 with body
 *   `{ error: { code: "context_length_exceeded", message, ... } }`
 * Other OpenAI-compatible providers (OpenRouter, Fireworks, Ollama, etc.)
 * forward similar shapes; not all populate `code` so we also probe the
 * message/param fields. Returns an object with any extractable token counts
 * when the error matches, or `null` when it does not.
 *
 * Most OpenAI-compatible providers do not report `actualTokens`/`maxTokens`
 * in the error body, but the typed wrapper is still valuable as a stable
 * signal for the agent loop.
 */
export function detectOpenAICompatibleContextOverflow(
  error: InstanceType<typeof OpenAI.APIError>,
  extraMessage?: string,
): { actualTokens?: number; maxTokens?: number } | null {
  // OpenAI-compatible providers use 400 (most) or 413 (rarer payload-too-large).
  const status = error.status;
  if (status !== 400 && status !== 413) return null;
  const code = error.code;
  const codeMatches =
    typeof code === "string" &&
    /context_length_exceeded|context_window_exceeded|input_too_long|prompt_too_long/i.test(
      code,
    );
  // Include the normalized upstream message: the SDK's `error.message` is often
  // generic ("400 Provider returned error") while the real signal is in the body.
  const message = `${error.message ?? ""} ${extraMessage ?? ""}`;
  const messageMatches =
    /context.?length.?exceeded|context.?window.?exceeded|prompt.?is.?too.?long|prompt_too_long|input.?too.?long|too.?many.?(?:input.?)?tokens|maximum.?context/i.test(
      message,
    );
  if (!codeMatches && !messageMatches) return null;
  // OpenAI-compatible providers rarely report usable token counts; best-effort extract.
  return extractOverflowTokensFromMessage(message);
}

const VISION_NOT_SUPPORTED_PATTERNS = [
  /no endpoints found that support image input/i,
  /does not support image/i,
  /image input is not supported/i,
  /this model does not support vision/i,
  /vision is not supported/i,
  /multi-?modal.*not.*support/i,
];

export function detectVisionNotSupported(
  error: InstanceType<typeof OpenAI.APIError>,
  extraMessage?: string,
): boolean {
  const haystack = `${error.message} ${extraMessage ?? ""} ${JSON.stringify((error as { error?: unknown }).error ?? "")}`;
  return VISION_NOT_SUPPORTED_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Fallback `content` for an assistant turn that has neither visible text nor
 * tool calls (e.g. a reasoning-only turn truncated at the output-token limit).
 *
 * The OpenAI chat-completions schema requires an assistant message to carry
 * `content` or `tool_calls`. OpenAI itself tolerates `content: null`/`""` here,
 * but strict OpenAI-compatible backends do not: DeepSeek via OpenRouter rejects
 * the request with `Invalid assistant message: content or tool_calls must be
 * set`, and vLLM-style validators coerce empty-string content back to null and
 * reject it the same way. The placeholder must therefore be a non-empty string.
 *
 * We reuse the shared empty-turn sentinel so that
 * `isPlaceholderSentinelText`/`cleanAssistantContent` strip it from persisted
 * and rendered history if a model ever echoes it back. The null-byte prefix is
 * dropped because some OpenAI-compatible backends reject control characters in
 * message content; the bare form is still recognized by
 * `isPlaceholderSentinelText`.
 */
export const EMPTY_ASSISTANT_TURN_PLACEHOLDER = PLACEHOLDER_EMPTY_TURN.slice(1);

export interface OpenAIChatCompletionsProviderOptions {
  baseURL?: string;
  providerName?: string;
  providerLabel?: string;
  streamTimeoutMs?: number;
  /** Provider-level request headers merged into every API request. */
  requestHeaders?: Record<string, string>;
  /** Extra params spread into every chat.completions.create call (e.g. reasoning). */
  extraCreateParams?: Record<string, unknown>;
  /** Upper bound for `reasoning_effort` sent on the wire. Defaults to "xhigh"
   *  (OpenAI's current ceiling). Compatibility providers whose APIs only
   *  document `low|medium|high` should set this to "high" so Vellum's
   *  `xhigh`/`max` tiers don't 4xx upstream. Set to "max" for providers like
   *  Fireworks DeepSeek V4 that accept the full effort range. Subclasses can
   *  override {@link OpenAIChatCompletionsProvider.resolveMaxReasoningEffort}
   *  for per-model ceilings. */
  maxReasoningEffort?: "high" | "xhigh" | "max";
  /** Parse `<think>...</think>` tags from the content stream into thinking
   *  blocks. MiniMax and similar providers embed reasoning inside XML-style
   *  tags in the regular content field rather than using `reasoning_content`. */
  parseThinkTags?: boolean;
  /** Wire field used to replay prior assistant thinking on multi-turn requests.
   *  DeepSeek/Fireworks use `"reasoning_content"`; OpenRouter uses `"reasoning"`.
   *  When unset, thinking blocks are dropped from outbound assistant messages. */
  assistantReasoningField?: "reasoning" | "reasoning_content";
  /** Backfill a non-empty placeholder for assistant turns that would otherwise
   *  serialize with neither `content` nor `tool_calls` (e.g. reasoning-only
   *  turns). Off by default; enabled for OpenRouter, whose downstream providers
   *  (e.g. DeepSeek) reject such messages with `Invalid assistant message:
   *  content or tool_calls must be set`. See {@link
   *  EMPTY_ASSISTANT_TURN_PLACEHOLDER}. */
  backfillEmptyAssistantContent?: boolean;
  /** Present object-typed tool params to the model as JSON-string params and
   *  decode them back to objects on the response. Works around models whose
   *  function-call serialization collapses nested objects to `{}` (observed
   *  with minimax-m3 on Fireworks). Off by default; scalars/arrays unaffected.
   *  See {@link coerceObjectParamsToJsonString}. */
  coerceObjectArgsToJsonString?: boolean;
}

/** Wire-level reasoning_effort values. The OpenAI SDK type doesn't include
 *  `"max"`, but Fireworks accepts it for DeepSeek V4; the assignment to
 *  `params.reasoning_effort` casts through this union. */
type ReasoningEffortWire = "none" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_RANK: Record<ReasoningEffortWire, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** Map our internal effort values to a reasoning_effort wire value. `"max"`
 *  is emitted raw — providers cap it down to their own ceiling
 *  ({@link OpenAIChatCompletionsProviderOptions.maxReasoningEffort}) at send
 *  time. `"none"` is passed through explicitly because OpenAI-compatible APIs
 *  default `reasoning_effort` to `"medium"` when the field is omitted, so the
 *  user's opt-out is only honored when we send it on the wire. */
export const EFFORT_TO_REASONING_EFFORT: Record<string, ReasoningEffortWire> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function clampReasoningEffort(
  value: ReasoningEffortWire,
  ceiling: "high" | "xhigh" | "max",
): ReasoningEffortWire {
  return REASONING_EFFORT_RANK[value] > REASONING_EFFORT_RANK[ceiling]
    ? ceiling
    : value;
}

/**
 * Translate the neutral (Anthropic-shaped) `tool_choice` carried on the call
 * config into the OpenAI chat-completions wire format. Callers express
 * `tool_choice` once in the Anthropic union — `{ type: "auto" | "any" | "none"
 * | "tool", name? }` — and each provider maps it to its own dialect (the
 * Anthropic client forwards the union verbatim). For OpenAI-compatible APIs:
 *   - `{ type: "auto" }`        -> `"auto"`
 *   - `{ type: "any" }`         -> `"required"`
 *   - `{ type: "none" }`        -> `"none"`
 *   - `{ type: "tool", name }`  -> `{ type: "function", function: { name } }`
 * Returns `undefined` for an absent or unrecognized value so the request omits
 * `tool_choice` and falls back to the API default.
 *
 * See OpenAI's tool_choice spec:
 * https://platform.openai.com/docs/api-reference/chat/create#chat-create-tool_choice
 */
export function mapNeutralToolChoice(
  toolChoice: unknown,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined {
  if (toolChoice == null || typeof toolChoice !== "object") return undefined;
  const tc = toolChoice as { type?: unknown; name?: unknown };
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof tc.name === "string"
        ? { type: "function", function: { name: tc.name } }
        : undefined;
    default:
      return undefined;
  }
}

const OPENAI_SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function partialTagSuffix(text: string, tag: string): number {
  for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
    if (text.endsWith(tag.substring(0, len))) return len;
  }
  return 0;
}

/**
 * OpenAI-compatible chat-completions transport.
 *
 * Encapsulates the request/stream-parsing logic for `chat.completions.create`,
 * tool-call chunk assembly, usage mapping, and error wrapping. Used directly by
 * OpenRouter, Fireworks, Ollama, and other OpenAI-compatible providers.
 */
export class OpenAIChatCompletionsProvider implements Provider {
  public readonly name: string;
  private readonly providerLabel: string;
  private client: OpenAI;
  private model: string;
  private streamTimeoutMs: number;
  private extraCreateParams: Record<string, unknown>;
  private maxReasoningEffort: "high" | "xhigh" | "max";
  private requestHeaders: Record<string, string>;
  private parseThinkTags: boolean;
  private assistantReasoningField:
    | "reasoning"
    | "reasoning_content"
    | undefined;
  private backfillEmptyAssistantContent: boolean;
  private coerceObjectArgsToJsonString: boolean;

  constructor(
    apiKey: string,
    model: string,
    options: OpenAIChatCompletionsProviderOptions = {},
  ) {
    this.name = options.providerName ?? "openai";
    this.providerLabel = options.providerLabel ?? "OpenAI";
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
    // Keep the SDK deadline behind our provider stream timeout so
    // createStreamTimeout owns the user-facing timeout error.
    const sdkTimeoutMs = this.streamTimeoutMs + 60_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
      timeout: sdkTimeoutMs,
      // Capture the raw non-2xx body before the SDK parses (and drops) it.
      fetch: captureRawErrorBodyFetch,
    });
    this.model = model;
    this.extraCreateParams = options.extraCreateParams ?? {};
    this.maxReasoningEffort = options.maxReasoningEffort ?? "xhigh";
    this.requestHeaders = options.requestHeaders ?? {};
    this.parseThinkTags = options.parseThinkTags ?? false;
    this.assistantReasoningField = options.assistantReasoningField;
    this.backfillEmptyAssistantContent =
      options.backfillEmptyAssistantContent ?? false;
    this.coerceObjectArgsToJsonString =
      options.coerceObjectArgsToJsonString ?? false;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { tools, systemPrompt, config, onEvent, signal } = options ?? {};
    const configObj = config as Record<string, unknown> | undefined;
    const maxTokens = configObj?.max_tokens as number | undefined;
    const modelOverride = configObj?.model as string | undefined;
    const effort = configObj?.effort as string | undefined;
    const logitBias = configObj?.logit_bias as
      | Record<string, number>
      | undefined;
    const topP = configObj?.top_p as number | undefined;
    const usageAttributionHeaders = configObj?.usageAttributionHeaders as
      | Record<string, string>
      | undefined;

    // Per-tool keys whose object schemas were rewritten to JSON strings for the
    // wire, to be decoded back on the response. Empty unless
    // `coerceObjectArgsToJsonString` is enabled.
    const coercedObjectKeys = new Map<string, string[]>();

    try {
      const openaiMessages = this.toOpenAIMessages(messages, systemPrompt);

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
        {
          model: modelOverride ?? this.model,
          messages: openaiMessages,
          stream: true as const,
          stream_options: { include_usage: true },
          ...this.buildExtraCreateParams(options),
        };

      if (maxTokens) {
        params.max_completion_tokens = maxTokens;
      }

      // Profile-scoped token biasing (e.g. the `suppress-cjk` preset). Resolved
      // and gated to this provider family upstream in `RetryProvider`.
      if (logitBias) {
        params.logit_bias = logitBias;
      }

      // `top_p` (nucleus sampling). Forwarded explicitly because this client
      // builds `params` field-by-field rather than spreading the config object.
      if (typeof topP === "number") {
        params.top_p = topP;
      }

      // Subclasses (OpenRouter) may already have nested effort under
      // `reasoning.effort` via `buildExtraCreateParams`. Skip the flat
      // `reasoning_effort` assignment in that case to avoid sending both forms,
      // which OpenRouter rejects on reasoning models.
      const nestedReasoningEffort = (
        params as { reasoning?: { effort?: unknown } }
      ).reasoning?.effort;
      const reasoningEffort = effort
        ? EFFORT_TO_REASONING_EFFORT[effort]
        : undefined;
      if (reasoningEffort && typeof nestedReasoningEffort !== "string") {
        const ceiling = this.resolveMaxReasoningEffort(
          modelOverride ?? this.model,
        );
        params.reasoning_effort = clampReasoningEffort(
          reasoningEffort,
          ceiling,
        ) as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"];
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => {
          let parameters = t.input_schema as OpenAI.FunctionParameters;
          if (this.coerceObjectArgsToJsonString) {
            const coerced = coerceObjectParamsToJsonString(t.input_schema);
            parameters = coerced.parameters as OpenAI.FunctionParameters;
            if (coerced.objectKeys.length > 0) {
              coercedObjectKeys.set(t.name, coerced.objectKeys);
            }
          }
          return {
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters,
            },
          };
        });

        // Honor a caller-supplied tool_choice (e.g. `{ type: "none" }` to force
        // a text-only answer, or `{ type: "tool", name }` for a forced call).
        // Only meaningful when tools are present — OpenAI rejects a named or
        // "required" choice with no tools.
        const toolChoice = mapNeutralToolChoice(configObj?.tool_choice);
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);

      // Accumulate the response from chunks
      let contentText = "";
      let reasoningText = "";
      let insideThinkBlock = false;
      let pendingContent = "";

      const flushPendingContent = (final: boolean): void => {
        while (pendingContent.length > 0) {
          if (insideThinkBlock) {
            const closeIdx = pendingContent.indexOf("</think>");
            if (closeIdx >= 0) {
              const thinking = pendingContent.substring(0, closeIdx);
              if (thinking) {
                reasoningText += thinking;
                onEvent?.({ type: "thinking_delta", thinking });
              }
              insideThinkBlock = false;
              pendingContent = pendingContent.substring(
                closeIdx + "</think>".length,
              );
            } else {
              const partial = final
                ? 0
                : partialTagSuffix(pendingContent, "</think>");
              const safeLen = pendingContent.length - partial;
              if (safeLen > 0) {
                const thinking = pendingContent.substring(0, safeLen);
                reasoningText += thinking;
                onEvent?.({ type: "thinking_delta", thinking });
              }
              pendingContent =
                partial > 0 ? pendingContent.substring(safeLen) : "";
              break;
            }
          } else {
            const openIdx = pendingContent.indexOf("<think>");
            if (openIdx >= 0) {
              const text = pendingContent.substring(0, openIdx);
              if (text) {
                contentText += text;
                onEvent?.({ type: "text_delta", text });
              }
              insideThinkBlock = true;
              pendingContent = pendingContent.substring(
                openIdx + "<think>".length,
              );
            } else {
              const partial = final
                ? 0
                : partialTagSuffix(pendingContent, "<think>");
              const safeLen = pendingContent.length - partial;
              if (safeLen > 0) {
                const t = pendingContent.substring(0, safeLen);
                contentText += t;
                onEvent?.({ type: "text_delta", text: t });
              }
              pendingContent =
                partial > 0 ? pendingContent.substring(safeLen) : "";
              break;
            }
          }
        }
      };

      const toolCallMap = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      const toolProgress = createToolProgressEmitter(onEvent);
      let finishReason = "unknown";
      let responseModel = modelOverride ?? this.model;
      let promptTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;
      let cachedPromptTokens = 0;

      try {
        const requestHeaders = {
          ...this.requestHeaders,
          ...(usageAttributionHeaders ?? {}),
        };
        const stream = await this.client.chat.completions.create(params, {
          signal: timeoutSignal,
          ...(Object.keys(requestHeaders).length > 0
            ? { headers: requestHeaders }
            : {}),
        });

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice) {
            if (choice.delta.content) {
              if (this.parseThinkTags) {
                pendingContent += choice.delta.content;
                flushPendingContent(false);
              } else {
                contentText += choice.delta.content;
                onEvent?.({ type: "text_delta", text: choice.delta.content });
              }
            }

            // Compatibility providers disagree on the field name: Fireworks /
            // DeepSeek / Together / Groq stream `reasoning_content`; OpenRouter
            // (per its ChatAssistantMessage spec) streams `reasoning`, and for
            // reasoning summaries (e.g. Kimi K2.6) also populates
            // `delta.reasoning_details[]` (entries are `reasoning.summary`,
            // `reasoning.text`, or opaque `reasoning.encrypted`).
            //
            // Kimi K2.6 mirrors the same token into BOTH `delta.reasoning` and
            // `delta.reasoning_details[].text` per chunk — prefer details when
            // they carry visible text, otherwise fall through to the flat
            // field. The encrypted-only case must fall through too, so the
            // flat `reasoning` field isn't silently dropped.
            const deltaWithReasoning = choice.delta as {
              reasoning?: string | null;
              reasoning_content?: string | null;
              reasoning_details?: Array<{
                type?: string;
                summary?: string | null;
                text?: string | null;
              }> | null;
            };

            let sawVisibleDetail = false;
            const reasoningDetails = deltaWithReasoning.reasoning_details;
            if (Array.isArray(reasoningDetails)) {
              for (const entry of reasoningDetails) {
                if (entry.type === "reasoning.encrypted") continue;
                const piece = entry.summary ?? entry.text;
                if (piece) {
                  sawVisibleDetail = true;
                  reasoningText += piece;
                  onEvent?.({ type: "thinking_delta", thinking: piece });
                }
              }
            }

            if (!sawVisibleDetail) {
              const reasoningContent =
                deltaWithReasoning.reasoning_content ??
                deltaWithReasoning.reasoning;
              if (reasoningContent) {
                reasoningText += reasoningContent;
                onEvent?.({
                  type: "thinking_delta",
                  thinking: reasoningContent,
                });
              }
            }

            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                if (!toolCallMap.has(tc.index)) {
                  toolCallMap.set(tc.index, { id: "", name: "", args: "" });
                }
                const entry = toolCallMap.get(tc.index)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                toolProgress.emitPreviewStart(entry.id, entry.name);
                if (tc.function?.arguments) {
                  entry.args += tc.function.arguments;
                  toolProgress.emitInputJsonDelta(
                    entry.id,
                    entry.name,
                    entry.args,
                  );
                }
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
            const completionDetails = (
              chunk.usage as {
                completion_tokens_details?: { reasoning_tokens?: number };
              }
            ).completion_tokens_details;
            reasoningTokens = completionDetails?.reasoning_tokens ?? 0;
            const promptDetails = (
              chunk.usage as {
                prompt_tokens_details?: { cached_tokens?: number };
              }
            ).prompt_tokens_details;
            cachedPromptTokens = promptDetails?.cached_tokens ?? 0;
          }

          responseModel = chunk.model;
        }
      } finally {
        cleanupTimeout();
      }

      if (this.parseThinkTags && pendingContent) {
        flushPendingContent(true);
      }

      // Build content blocks
      const finalReasoning = this.parseThinkTags
        ? reasoningText.trim()
        : reasoningText;
      const finalContent = this.parseThinkTags
        ? contentText.trim()
        : contentText;
      const content: ContentBlock[] = [];
      if (finalReasoning) {
        content.push({
          type: "thinking",
          thinking: finalReasoning,
          signature: "",
        });
      }
      if (finalContent) {
        content.push({ type: "text", text: finalContent });
      }
      for (const [, tc] of toolCallMap) {
        toolProgress.emitInputJsonDelta(tc.id, tc.name, tc.args, {
          force: true,
        });
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.args);
        } catch {
          input = wrapUnparseableToolArgs(tc.args);
        }
        const objectKeys = coercedObjectKeys.get(tc.name);
        if (objectKeys && !isUnparseableToolArgs(input)) {
          const decoded = decodeCoercedObjectArgs(input, objectKeys);
          input = decoded.failedKey
            ? wrapUnparseableToolArgs(tc.args)
            : decoded.input;
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input,
        });
      }

      // Build a synthetic response object from accumulated streaming data
      const rawResponse = {
        model: responseModel,
        choices: [
          {
            message: {
              role: "assistant",
              content: contentText || null,
              tool_calls:
                toolCallMap.size > 0
                  ? Array.from(toolCallMap.values()).map((tc) => ({
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.args },
                    }))
                  : undefined,
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          ...(reasoningTokens > 0
            ? {
                completion_tokens_details: {
                  reasoning_tokens: reasoningTokens,
                },
              }
            : {}),
          ...(cachedPromptTokens > 0
            ? {
                prompt_tokens_details: {
                  cached_tokens: cachedPromptTokens,
                },
              }
            : {}),
        },
      };

      return {
        content,
        model: responseModel,
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
          ...(cachedPromptTokens > 0
            ? { cacheReadInputTokens: cachedPromptTokens }
            : {}),
        },
        stopReason: finishReason,
        // `rawRequest` is persisted to the request-log DB and inspector on every
        // call. A `logit_bias` preset (e.g. `suppress-cjk`) is ~5.3k deterministic
        // entries (~68KB); summarize it here so logs don't balloon. The full map
        // still went out on the wire above.
        rawRequest: params.logit_bias
          ? {
              ...params,
              logit_bias: `<${Object.keys(params.logit_bias).length} token biases omitted>`,
            }
          : params,
        rawResponse,
      };
    } catch (error) {
      // Propagate a tagged AbortReason (set by the daemon at controller.abort())
      // so wrapped errors can be classified as user cancellation downstream.
      const abortReason =
        signal?.aborted && isAbortReason(signal.reason)
          ? signal.reason
          : undefined;
      if (error instanceof OpenAI.APIError) {
        const normalized = normalizeOpenAIAPIError(error);
        const formattedMessage = formatNormalizedOpenAIAPIError(
          this.providerLabel,
          error.status,
          normalized,
        );
        const overflow = detectOpenAICompatibleContextOverflow(
          error,
          normalized.message,
        );
        if (overflow) {
          throw new ContextOverflowError(formattedMessage, this.name, {
            actualTokens: overflow.actualTokens,
            maxTokens: overflow.maxTokens,
            statusCode: error.status,
            cause: error,
          });
        }
        if (detectVisionNotSupported(error, normalized.message)) {
          const model = modelOverride ?? this.model;
          throw new ProviderError(
            `This model (${model}) doesn't support image input. Remove the image or switch to a vision-capable model.`,
            this.name,
            error.status,
            abortReason ? { abortReason } : undefined,
          );
        }
        const retryAfterMs = extractRetryAfterMs(error.headers);
        const errorOptions: {
          retryAfterMs?: number;
          abortReason?: unknown;
          apiErrorCode?: string;
          apiErrorType?: string;
          apiErrorParam?: string;
          requestId?: string;
          rawBody?: string;
        } = {};
        if (retryAfterMs !== undefined)
          errorOptions.retryAfterMs = retryAfterMs;
        if (abortReason) errorOptions.abortReason = abortReason;
        if (normalized.apiErrorCode)
          errorOptions.apiErrorCode = normalized.apiErrorCode;
        if (normalized.apiErrorType)
          errorOptions.apiErrorType = normalized.apiErrorType;
        if (normalized.apiErrorParam)
          errorOptions.apiErrorParam = normalized.apiErrorParam;
        if (normalized.requestId) errorOptions.requestId = normalized.requestId;
        if (normalized.rawBody) errorOptions.rawBody = normalized.rawBody;
        throw new ProviderError(
          formattedMessage,
          this.name,
          error.status,
          Object.keys(errorOptions).length > 0 ? errorOptions : undefined,
        );
      }
      throw new ProviderError(
        `${this.providerLabel} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
        undefined,
        abortReason ? { cause: error, abortReason } : { cause: error },
      );
    }
  }

  /**
   * Hook for subclasses to inject request-specific extra params. Defaults to
   * the static `extraCreateParams` set on the constructor; subclasses (e.g.
   * OpenRouter) can override to build params dynamically from `options`.
   */
  protected buildExtraCreateParams(
    _options?: SendMessageOptions,
  ): Record<string, unknown> {
    return this.extraCreateParams;
  }

  /**
   * Per-request reasoning_effort ceiling. Defaults to the provider-wide
   * `maxReasoningEffort` from constructor options. Subclasses (e.g. Fireworks)
   * override to consult the model catalog so per-model accepted ranges are
   * respected.
   */
  protected resolveMaxReasoningEffort(
    _model: string,
  ): "high" | "xhigh" | "max" {
    return this.maxReasoningEffort;
  }

  /** Convert neutral messages + system prompt to OpenAI message format. */
  private toOpenAIMessages(
    messages: Message[],
    systemPrompt?: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({
        role: "system",
        content: systemPrompt.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n\n"),
      });
    }

    for (const msg of messages) {
      if (msg.role === "assistant") {
        result.push(this.toOpenAIAssistantMessage(msg));
      } else {
        // User messages may contain tool_result blocks mixed with text/image
        const toolResults = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
            b.type === "tool_result",
        );
        const otherBlocks = msg.content.filter(
          (b) =>
            b.type !== "tool_result" &&
            b.type !== "thinking" &&
            b.type !== "redacted_thinking",
        );

        // Emit tool results as separate tool-role messages
        // OpenAI's API only supports string content in tool messages, so images
        // from contentBlocks are collected and injected as a user message below.
        const toolResultImages: ContentBlock[] = [];
        for (const tr of toolResults) {
          let textContent = tr.content;
          if (tr.contentBlocks && tr.contentBlocks.length > 0) {
            const extraText = tr.contentBlocks
              .filter(
                (cb): cb is Extract<ContentBlock, { type: "text" }> =>
                  cb.type === "text",
              )
              .map((cb) => cb.text);
            if (extraText.length > 0) {
              textContent = textContent + "\n" + extraText.join("\n");
            }
            for (const cb of tr.contentBlocks) {
              if (cb.type === "image") toolResultImages.push(cb);
            }
          }
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `[ERROR] ${textContent}` : textContent,
          });
        }

        // Emit remaining content + any tool result images as a user message.
        // Images from tool results (e.g. browser_screenshot) must go in a user
        // message because OpenAI-compatible APIs don't support images in tool messages.
        const userContent = [...otherBlocks, ...toolResultImages];
        if (userContent.length > 0) {
          result.push(this.toOpenAIUserMessage(userContent));
        }
      }
    }

    return result;
  }

  /** Convert an assistant message with text + tool_use blocks to OpenAI format. */
  private toOpenAIAssistantMessage(
    msg: Message,
  ): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] =
      [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          break;
        case "thinking":
          // Anthropic thinking blocks carry signatures — skip those.
          if (!block.signature) reasoningParts.push(block.thinking);
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case "server_tool_use":
          textParts.push(`[Web search: ${block.name}]`);
          break;
        case "web_search_tool_result":
          textParts.push("[Web search results]");
          break;
        // redacted_thinking, image — not applicable for OpenAI assistant messages
      }
    }

    const result: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =
      {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
      };

    if (reasoningParts.length > 0 && this.assistantReasoningField) {
      (
        result as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & {
          reasoning?: string;
          reasoning_content?: string;
        }
      )[this.assistantReasoningField] = reasoningParts.join("");
    }

    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls;
    }

    // An assistant message must carry `content` or `tool_calls`. A turn with
    // neither (e.g. reasoning-only) would serialize to null/empty content with
    // no tool calls, which strict OpenAI-compatible backends reject. Reasoning
    // lives in a separate field and does not satisfy this constraint. Scoped to
    // providers that need it (OpenRouter) via `backfillEmptyAssistantContent`.
    if (
      this.backfillEmptyAssistantContent &&
      !result.tool_calls &&
      (result.content === null || result.content === "")
    ) {
      result.content = EMPTY_ASSISTANT_TURN_PLACEHOLDER;
    }

    return result;
  }

  /** Convert user content blocks (text, image) to an OpenAI user message. */
  private toOpenAIUserMessage(
    blocks: ContentBlock[],
  ): OpenAI.Chat.Completions.ChatCompletionUserMessageParam {
    // If only a single text block, use plain string (simpler, fewer tokens)
    if (blocks.length === 1 && blocks[0].type === "text") {
      return { role: "user", content: blocks[0].text };
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(block.source.media_type)) {
            parts.push({
              type: "text",
              text: `[Image: ${block.source.media_type} — format not supported by this provider]`,
            });
          } else {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          }
          break;
        case "file":
          parts.push({
            type: "text",
            text: this.fileBlockToText(block),
          });
          break;
        case "server_tool_use":
          parts.push({
            type: "text",
            text: `[Web search: ${block.name}]`,
          });
          break;
        case "web_search_tool_result":
          parts.push({ type: "text", text: "[Web search results]" });
          break;
      }
    }

    return { role: "user", content: parts };
  }

  private fileBlockToText(
    block: Extract<ContentBlock, { type: "file" }>,
  ): string {
    const header = `<attached_file name="${escapeXmlAttr(
      block.source.filename,
    )}" type="${escapeXmlAttr(block.source.media_type)}" />`;
    if (block.extracted_text && block.extracted_text.trim().length > 0) {
      return `${header}\n${block.extracted_text}`;
    }
    return `${header}\nNo extracted text available.`;
  }
}
