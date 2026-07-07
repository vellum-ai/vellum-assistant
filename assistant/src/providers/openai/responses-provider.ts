import OpenAI from "openai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { escapeXmlAttr } from "../../util/xml.js";
import { base64Source, resolveMediaReferences } from "../media-resolve.js";
import { createStreamTimeout } from "../stream-timeout.js";
import { createToolProgressEmitter } from "../tool-progress-events.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";
import { ContextOverflowError } from "../types.js";
import { wrapUnparseableToolArgs } from "../unparseable-tool-args.js";
import {
  captureRawErrorBodyFetch,
  formatNormalizedOpenAIAPIError,
  normalizeOpenAIAPIError,
} from "./api-error-normalization.js";
import { detectOpenAICompatibleContextOverflow } from "./chat-completions-provider.js";

const log = getLogger("openai-responses");

export interface OpenAIResponsesProviderOptions {
  baseURL?: string;
  providerName?: string;
  providerLabel?: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
  /** When true, target the Codex subscription endpoint and strip fields it
   *  rejects (`max_output_tokens`). */
  codexSubscription?: boolean;
}

/** Map our internal effort values to the Responses API reasoning.effort parameter.
 *  OpenAI caps at "xhigh", so our "max" tier collapses to "xhigh". `"none"` is
 *  passed through explicitly because OpenAI defaults `reasoning.effort` to
 *  "medium" when the field is omitted — the user's opt-out is only honored
 *  when we send it on the wire. */
const EFFORT_TO_REASONING_EFFORT: Record<
  string,
  "none" | "low" | "medium" | "high" | "xhigh"
> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/** Values accepted by the Responses API `text.verbosity` parameter. */
const VALID_VERBOSITIES = new Set<string>(["low", "medium", "high"]);

/**
 * Translate the neutral (Anthropic-shaped) `tool_choice` carried on the call
 * config into the OpenAI Responses API wire format. Callers express
 * `tool_choice` once in the Anthropic union — `{ type: "auto" | "any" | "none"
 * | "tool", name? }`. For the Responses API:
 *   - `{ type: "auto" }`        -> `"auto"`
 *   - `{ type: "any" }`         -> `"required"`
 *   - `{ type: "none" }`        -> `"none"`
 *   - `{ type: "tool", name }`  -> `{ type: "function", name }`
 * Note the named shape differs from chat-completions (no nested `function`
 * wrapper). Returns `undefined` for an absent or unrecognized value.
 *
 * https://platform.openai.com/docs/api-reference/responses/create#responses-create-tool_choice
 */
export function mapNeutralToolChoiceForResponses(
  toolChoice: unknown,
): string | { type: "function"; name: string } | undefined {
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
        ? { type: "function", name: tc.name }
        : undefined;
    default:
      return undefined;
  }
}

/** `text.verbosity` is a GPT-5-series-only parameter. Older models on the
 *  Responses API (o-series, etc.) reject unknown wire fields with HTTP 400, so
 *  gate forwarding by model name here. The retry layer can't make this call
 *  because verbosity defaults to "medium" in the LLM schema, so every
 *  callSite-resolved request would otherwise carry it regardless of model.
 *  Also matches OpenAI fine-tune IDs of the form `ft:gpt-5.x:org::id` so users
 *  on GPT-5 fine-tunes keep explicit verbosity control. */
function modelSupportsVerbosity(model: string): boolean {
  return /^(ft:)?gpt-5(\b|[-.])/i.test(model);
}

/** Loosely-typed Responses stream event to avoid `any` while the SDK types settle. */
interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  /** Present on function_call_arguments.done — the complete final arguments. */
  arguments?: string;
  /** Present on function_call_arguments.done — the function name. */
  name?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  item_id?: string;
  response?: {
    model?: string;
    status?: string;
    incomplete_details?: {
      reason?: "max_output_tokens" | "content_filter";
    } | null;
    /** Full output items array — preserved as part of rawResponse for the
     *  LLM context normalizer, which uses its presence to detect Responses
     *  API payloads in stored diagnostics. */
    output?: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

const OPENAI_SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * OpenAI Responses API transport.
 *
 * Encapsulates the request/stream-parsing logic for `client.responses.stream()`,
 * function-call accumulation, usage mapping, and error wrapping. Produces the
 * same `ProviderResponse` contract as the chat-completions transport.
 */
export class OpenAIResponsesProvider implements Provider {
  public readonly name: string;
  private readonly providerLabel: string;
  private client: OpenAI;
  private model: string;
  private streamTimeoutMs: number;
  private useNativeWebSearch: boolean;
  private codexSubscription: boolean;

  constructor(
    apiKey: string,
    model: string,
    options: OpenAIResponsesProviderOptions = {},
  ) {
    this.name = options.providerName ?? "openai";
    this.providerLabel = options.providerLabel ?? "OpenAI";
    this.codexSubscription = options.codexSubscription ?? false;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
    // Keep the SDK deadline behind our provider stream timeout so
    // createStreamTimeout owns the user-facing timeout error.
    const sdkTimeoutMs = this.streamTimeoutMs + 60_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: this.codexSubscription
        ? "https://chatgpt.com/backend-api/codex"
        : options.baseURL,
      timeout: sdkTimeoutMs,
      // Capture the raw non-2xx body before the SDK parses (and drops) it.
      fetch: captureRawErrorBodyFetch,
    });
    this.model = model;
    this.useNativeWebSearch = options.useNativeWebSearch ?? false;
  }

  /** See {@link Provider.supportsNativeWebSearch}. */
  get supportsNativeWebSearch(): boolean {
    return this.useNativeWebSearch;
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
    const verbosity = configObj?.verbosity as string | undefined;
    const usageAttributionHeaders = configObj?.usageAttributionHeaders as
      | Record<string, string>
      | undefined;

    try {
      const input = this.toResponsesInput(messages);

      const params: Record<string, unknown> = {
        model: modelOverride ?? this.model,
        input,
        ...(this.codexSubscription ? { store: false } : {}),
      };

      if (systemPrompt) {
        params.instructions = systemPrompt.replaceAll(
          SYSTEM_PROMPT_CACHE_BOUNDARY,
          "\n\n",
        );
      }

      if (maxTokens && !this.codexSubscription) {
        params.max_output_tokens = maxTokens;
      }

      const reasoningEffort = effort
        ? EFFORT_TO_REASONING_EFFORT[effort]
        : undefined;
      if (reasoningEffort) {
        params.reasoning = { effort: reasoningEffort };
      }

      if (
        verbosity &&
        VALID_VERBOSITIES.has(verbosity) &&
        modelSupportsVerbosity(modelOverride ?? this.model)
      ) {
        params.text = { verbosity };
      }

      // Sampling params (`top_p`/`temperature`) are intentionally NOT forwarded
      // on the Responses path. OpenAI reasoning models (o-series, GPT-5
      // reasoning) reject them with HTTP 400 when reasoning is active, and the
      // resolved `effort` defaults to a reasoning effort, so `reasoning` is set
      // on essentially every Responses request. The profile editor therefore
      // doesn't surface `topP` for the native `openai` provider (mirroring
      // `temperature`, which is also never offered/forwarded here); OpenAI-
      // compatible connections, which use the chat-completions client, honor
      // `top_p` normally.

      if (tools && tools.length > 0) {
        if (
          this.useNativeWebSearch &&
          tools.some((t) => t.name === "web_search")
        ) {
          const otherTools = tools.filter((t) => t.name !== "web_search");
          const mappedOther = otherTools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            strict: null,
          }));
          const webSearchTool = this.codexSubscription
            ? { type: "web_search" as const, external_web_access: false }
            : { type: "web_search_preview" as const };
          params.tools = [...mappedOther, webSearchTool];
        } else {
          params.tools = tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            strict: null,
          }));
        }

        // Honor a caller-supplied tool_choice (e.g. `{ type: "none" }` to force
        // a text-only answer, or `{ type: "tool", name }` for a forced call).
        // Only meaningful when tools are present.
        const toolChoice = mapNeutralToolChoiceForResponses(
          configObj?.tool_choice,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);

      // Accumulate the response from stream events
      let contentText = "";
      // Keyed by item_id (from the stream event) to support parallel tool calls.
      const toolCallMap = new Map<
        string,
        { callId: string; name: string; args: string }
      >();
      // Maps item_id → callId so we can look up tool calls from delta events.
      const itemIdToCallId = new Map<string, string>();
      const toolProgress = createToolProgressEmitter(onEvent);
      // Track web search call item IDs so we can emit server_tool_complete.
      const webSearchCallIds: string[] = [];
      let finishReason = "unknown";
      let responseModel = modelOverride ?? this.model;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let cachedInputTokens = 0;
      let rawFinalResponse: unknown = undefined;

      try {
        // Use `create()` with `stream: true` instead of the higher-level
        // `stream()` helper. The `stream()` helper wraps the response in a
        // `ResponseStream` that runs `maybeParseResponse()` after iteration,
        // which crashes when the Codex subscription endpoint omits `output`
        // from the `response.completed` event payload.
        const responsesApi = this.client.responses as unknown as {
          create(
            p: Record<string, unknown>,
            o?: { signal?: AbortSignal; headers?: Record<string, string> },
          ): Promise<AsyncIterable<ResponsesStreamEvent>>;
        };
        const stream = await responsesApi.create(
          { ...params, stream: true },
          {
            signal: timeoutSignal,
            ...(usageAttributionHeaders
              ? { headers: usageAttributionHeaders }
              : {}),
          },
        );

        for await (const event of stream) {
          switch (event.type) {
            case "response.output_text.delta": {
              const delta = event.delta;
              if (delta) {
                contentText += delta;
                onEvent?.({ type: "text_delta", text: delta });
              }
              break;
            }

            case "response.output_item.added": {
              const item = event.item;
              if (item?.type === "function_call") {
                const callId = item.call_id ?? "";
                const itemId = item.id ?? callId;
                const name = item.name ?? "";
                toolCallMap.set(callId, {
                  callId,
                  name,
                  args: "",
                });
                itemIdToCallId.set(itemId, callId);
                toolProgress.emitPreviewStart(callId, name);
              } else if (item?.type === "web_search_call") {
                const toolUseId = item.id ?? "";
                webSearchCallIds.push(toolUseId);
                onEvent?.({
                  type: "server_tool_start",
                  name: "web_search",
                  toolUseId,
                  input: {},
                });
              }
              break;
            }

            case "response.function_call_arguments.delta": {
              // Use item_id to route deltas to the correct tool call,
              // supporting parallel function calls in the stream.
              const delta = event.delta;
              const itemId = event.item_id;
              if (delta && itemId) {
                const callId = itemIdToCallId.get(itemId);
                if (callId) {
                  const entry = toolCallMap.get(callId);
                  if (entry) {
                    entry.args += delta;
                    toolProgress.emitInputJsonDelta(
                      entry.callId,
                      entry.name,
                      entry.args,
                    );
                  }
                }
              }
              break;
            }

            case "response.function_call_arguments.done": {
              // The done event carries the authoritative final arguments.
              // Overwrite whatever was accumulated from deltas to guard
              // against partial or missing delta delivery.
              const itemId = event.item_id;
              if (itemId && event.arguments !== undefined) {
                const callId = itemIdToCallId.get(itemId);
                if (callId) {
                  const entry = toolCallMap.get(callId);
                  if (entry) {
                    if (event.name) entry.name = event.name;
                    entry.args = event.arguments;
                    toolProgress.emitInputJsonDelta(
                      entry.callId,
                      entry.name,
                      entry.args,
                      { force: true },
                    );
                  }
                }
              }
              break;
            }

            case "response.completed":
            case "response.incomplete": {
              const response = event.response;
              if (response) {
                rawFinalResponse = response;
                if (response.model) {
                  responseModel = response.model;
                }
                if (response.usage) {
                  inputTokens = response.usage.input_tokens ?? 0;
                  outputTokens = response.usage.output_tokens ?? 0;
                  reasoningTokens =
                    response.usage.output_tokens_details?.reasoning_tokens ?? 0;
                  cachedInputTokens =
                    response.usage.input_tokens_details?.cached_tokens ?? 0;
                }
                finishReason =
                  response.incomplete_details?.reason ??
                  response.status ??
                  (event.type === "response.incomplete"
                    ? "incomplete"
                    : "completed");
              }
              // Emit server_tool_complete for any web search calls that were started.
              if (event.type === "response.completed") {
                for (const toolUseId of webSearchCallIds) {
                  onEvent?.({
                    type: "server_tool_complete",
                    toolUseId,
                    isError: false,
                  });
                }
              }
              break;
            }
          }
        }
      } finally {
        cleanupTimeout();
      }

      // Build content blocks.
      // Inject server_tool_use + web_search_tool_result pairs before text so
      // conversation history matches the shape Anthropic produces for native
      // web search. The paired result block prevents repairHistory() from
      // treating completed searches as interrupted (which would inject a
      // synthetic web_search_tool_result_error and corrupt history). OpenAI
      // weaves search results into the text output, so the result content is
      // an empty array — the actual results are in the text block that follows.
      const content: ContentBlock[] = [];
      for (const toolUseId of webSearchCallIds) {
        content.push({
          type: "server_tool_use",
          id: toolUseId,
          name: "web_search",
          input: {},
        });
        content.push({
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: [],
        });
      }
      if (contentText) {
        content.push({ type: "text", text: contentText });
      }
      for (const [, tc] of toolCallMap) {
        toolProgress.emitInputJsonDelta(tc.callId, tc.name, tc.args, {
          force: true,
        });
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.args);
        } catch {
          input = wrapUnparseableToolArgs(tc.args);
        }
        content.push({
          type: "tool_use",
          id: tc.callId,
          name: tc.name,
          input,
        });
      }

      // Map Responses API status to a stop reason
      const stopReason = finishReason === "completed" ? "stop" : finishReason;

      return {
        content,
        model: responseModel,
        usage: {
          inputTokens,
          outputTokens,
          ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
          ...(cachedInputTokens > 0
            ? { cacheReadInputTokens: cachedInputTokens }
            : {}),
        },
        stopReason,
        rawRequest: params,
        rawResponse: rawFinalResponse,
      };
    } catch (error) {
      const abortReason =
        signal?.aborted && isAbortReason(signal.reason)
          ? signal.reason
          : undefined;
      if (error instanceof OpenAI.APIError) {
        const normalized = normalizeOpenAIAPIError(error);
        if (this.codexSubscription) {
          log.warn(
            {
              status: error.status,
              message: normalized.message,
              requestId: normalized.requestId,
            },
            "Codex endpoint raw error response",
          );
        }
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
   * Convert neutral messages to Responses API input items.
   *
   * System prompt is NOT included here — it goes into the `instructions` param.
   */
  private toResponsesInput(messages: Message[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "assistant") {
        this.appendAssistantItems(result, msg);
      } else {
        this.appendUserItems(result, msg);
      }
    }

    return result;
  }

  /** Convert an assistant message's content blocks to Responses input items. */
  private appendAssistantItems(result: unknown[], msg: Message): void {
    const textParts: string[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          break;
        case "tool_use":
          // Flush any accumulated text as an assistant message first
          if (textParts.length > 0) {
            result.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: textParts.join("") }],
            });
            textParts.length = 0;
          }
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "server_tool_use":
          textParts.push(`[Web search: ${block.name}]`);
          break;
        case "web_search_tool_result":
          textParts.push("[Web search results]");
          break;
        // thinking, redacted_thinking, image — not applicable
      }
    }

    if (textParts.length > 0) {
      result.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: textParts.join("") }],
      });
    }
  }

  /** Convert a user message's content blocks to Responses input items. */
  private appendUserItems(result: unknown[], msg: Message): void {
    // Resolve persisted attachment references to inline base64 before walking
    // the content blocks; live turns already carry base64 and pass through.
    msg = resolveMediaReferences([msg])[0] ?? msg;
    // Separate tool results from other blocks
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

    // Emit tool results as function_call_output items
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
        type: "function_call_output",
        call_id: tr.tool_use_id,
        output: tr.is_error ? `[ERROR] ${textContent}` : textContent,
      });
    }

    // Emit remaining content + any tool result images as a user message
    const userContent = [...otherBlocks, ...toolResultImages];
    if (userContent.length > 0) {
      result.push(this.toResponsesUserMessage(userContent));
    }
  }

  /** Convert user content blocks to a Responses API user message. */
  private toResponsesUserMessage(blocks: ContentBlock[]): unknown {
    // Single text block — simple message
    if (blocks.length === 1 && blocks[0].type === "text") {
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: blocks[0].text }],
      };
    }

    const parts: unknown[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          parts.push({ type: "input_text", text: block.text });
          break;
        case "image": {
          const imageSource = base64Source(block.source);
          if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(imageSource.media_type)) {
            parts.push({
              type: "input_text",
              text: `[Image: ${imageSource.media_type} — format not supported by this provider]`,
            });
          } else {
            parts.push({
              type: "input_image",
              image_url: `data:${imageSource.media_type};base64,${imageSource.data}`,
            });
          }
          break;
        }
        case "file":
          parts.push({
            type: "input_text",
            text: this.fileBlockToText(block),
          });
          break;
        case "server_tool_use":
          parts.push({
            type: "input_text",
            text: `[Web search: ${block.name}]`,
          });
          break;
        case "web_search_tool_result":
          parts.push({ type: "input_text", text: "[Web search results]" });
          break;
      }
    }

    return {
      type: "message",
      role: "user",
      content: parts,
    };
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
