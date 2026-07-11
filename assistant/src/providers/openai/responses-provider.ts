import OpenAI from "openai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError, type ProviderErrorReason } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { escapeXmlAttr } from "../../util/xml.js";
import { base64Source, resolveMediaReferences } from "../media-resolve.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
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
      input_tokens_details?: {
        cached_tokens?: number;
        /** GPT-5.6+: prompt tokens written to the cache, billed at 1.25x input. */
        cache_write_tokens?: number;
      };
    };
  };
}

const OPENAI_SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Direct-OpenAI models that use explicit prompt-cache breakpoints (GPT-5.6+).
 *  Built once from the catalog, mirroring the Fireworks effort-ceiling map
 *  (fireworks/client.ts). */
const PROMPT_CACHE_BREAKPOINT_MODELS: ReadonlySet<string> = new Set(
  PROVIDER_CATALOG.find((p) => p.id === "openai")?.models.flatMap((m) =>
    m.supportsPromptCacheBreakpoints ? [m.id] : [],
  ) ?? [],
);

/** Content-part types that accept a `prompt_cache_breakpoint` marker. */
const STAMPABLE_PART_TYPES = new Set([
  "input_text",
  "input_image",
  "input_file",
]);

/** OpenAI considers up to the latest 50 breakpoints for cache reads; markers
 *  beyond that budget are dead weight, so the marker ladder stops there. */
const PROMPT_CACHE_MAX_BREAKPOINTS = 50;

/** Minimal structural view of a Responses `input` message item. */
interface ResponsesMessageItem {
  type?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
}

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
    const mutableLatestUserMessage =
      configObj?.mutableLatestUserMessage === true;
    const disableCache = configObj?.disableCache === true;
    const disableTurnStartCache = configObj?.disableTurnStartCache === true;
    const promptCacheKey =
      typeof configObj?.promptCacheKey === "string" &&
      configObj.promptCacheKey.length > 0
        ? (configObj.promptCacheKey as string)
        : undefined;

    try {
      const effectiveModel = modelOverride ?? this.model;
      const input = this.toResponsesInput(messages);

      const params: Record<string, unknown> = {
        model: effectiveModel,
        input,
        ...(this.codexSubscription ? { store: false } : {}),
      };

      if (systemPrompt) {
        params.instructions = systemPrompt.replaceAll(
          SYSTEM_PROMPT_CACHE_BOUNDARY,
          "\n\n",
        );
      }

      // Explicit prompt-cache mode (GPT-5.6+ semantics, direct API only).
      // Explicit mode disables the implicit latest-message breakpoint — under
      // implicit mode a volatile latest user message (mutableLatestUserMessage)
      // makes every cached entry end at content that never recurs: zero reads
      // plus a full-prompt 1.25x write per turn. With explicit markers we
      // choose the stable boundaries ourselves. Under `disableCache` we still
      // send explicit mode but stamp no markers: a request with no explicit
      // breakpoints neither uses the cache nor incurs cache-write charges,
      // which is exactly the opt-out `disableCache` wants (omitting the param
      // would re-enable implicit mode). The Codex subscription endpoint
      // rejects extra params, so cache params are skipped entirely there.
      if (
        !this.codexSubscription &&
        PROMPT_CACHE_BREAKPOINT_MODELS.has(effectiveModel)
      ) {
        params.prompt_cache_options = { mode: "explicit" };
        if (promptCacheKey) {
          params.prompt_cache_key = promptCacheKey;
        }
        if (!disableCache) {
          this.applyPromptCacheBreakpoints(input, {
            mutableLatestUserMessage,
            disableTurnStartCache,
          });
        }
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
      let cacheWriteInputTokens = 0;
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
                  cacheWriteInputTokens =
                    response.usage.input_tokens_details?.cache_write_tokens ??
                    0;
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
          ...(cacheWriteInputTokens > 0
            ? { cacheCreationInputTokens: cacheWriteInputTokens }
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
          reason?: ProviderErrorReason;
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
        if (normalized.reason) errorOptions.reason = normalized.reason;
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
    // Swap any persisted attachment references back to inline base64 before
    // serializing, so the block transforms below can read `source.data`.
    messages = resolveMediaReferences(messages);
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

  /**
   * Stamp explicit prompt-cache breakpoints onto the built Responses input
   * items: the last stampable part of every user item carrying real text,
   * newest first, up to {@link PROMPT_CACHE_MAX_BREAKPOINTS}.
   *
   * Cache reads only consider markers present in the *current* request —
   * boundaries written by earlier requests match only if re-marked here
   * (verified empirically against gpt-5.6: a previously-written boundary
   * left unmarked produces zero reads). Marking the full ladder of
   * historical user-message boundaries makes the newest still-matching one
   * the read point; in the volatile-latest-message flow that is typically
   * the previous turn's user message once it re-renders without its
   * injected block. Marking the volatile latest item itself prepays its
   * write so in-turn tool-loop iterations read it back. The ladder is
   * cost-safe: OpenAI writes at most the latest four unmatched marked
   * boundaries per request and considers up to the latest 50 markers for
   * reads. All breakpoints share the fixed 30m TTL (no `ttl` field is
   * sent). Operates on the provider-local wire items only; the caller's
   * Message[] objects are never touched.
   *
   * Placement constraints on this API: breakpoints attach only to
   * input_text / input_image / input_file parts of user message items —
   * function_call / function_call_output items cannot carry one, so during
   * a pure tool loop the newest markable boundary stays at the most recent
   * user item with parts (the loop delta is re-billed as plain input until
   * a text-bearing user item appears).
   *
   * The system prompt rides the `instructions` request param and cannot
   * carry a block marker, but it precedes `input` in the cached prefix, so
   * every marked boundary covers instructions and tools implicitly. Any
   * instructions/tools change invalidates all previously written prefixes
   * (exact-prefix matching) — the same blast radius implicit mode has.
   */
  private applyPromptCacheBreakpoints(
    input: unknown[],
    opts: { mutableLatestUserMessage: boolean; disableTurnStartCache: boolean },
  ): void {
    const items = input as ResponsesMessageItem[];
    // Marker candidates need a real text part (mirror of the Anthropic
    // client's findUserTextMsgIdx).
    const isUserTextItem = (it: ResponsesMessageItem | undefined): boolean =>
      it?.type === "message" &&
      it.role === "user" &&
      Array.isArray(it.content) &&
      it.content.some(
        (p) =>
          p.type === "input_text" &&
          typeof p.text === "string" &&
          p.text.length > 0,
      );

    const candidates: number[] = [];
    for (
      let i = items.length - 1;
      i >= 0 && candidates.length < PROMPT_CACHE_MAX_BREAKPOINTS;
      i--
    ) {
      if (isUserTextItem(items[i])) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) {
      return;
    }

    // A volatile latest user message with no prior user message to anchor
    // on: every marker would be a write whose prefix never recurs across
    // turns — skip caching entirely for this request.
    if (
      opts.mutableLatestUserMessage &&
      candidates.length === 1 &&
      candidates[0] === items.length - 1
    ) {
      return;
    }

    for (const idx of candidates) {
      // `disableTurnStartCache` suppresses the marker on the turn-start
      // (newest user-text) item — one-shot call sites whose prompts never
      // recur would otherwise pay a write with no future read. Older
      // boundaries stay marked, matching the Anthropic client's semantics
      // (its previous-turn anchor is not gated by this flag).
      if (opts.disableTurnStartCache && idx === candidates[0]) {
        continue;
      }
      const content = items[idx]?.content;
      if (!Array.isArray(content) || content.length === 0) {
        continue;
      }
      const last = content[content.length - 1];
      if (last && STAMPABLE_PART_TYPES.has(last.type as string)) {
        last.prompt_cache_breakpoint = { mode: "explicit" };
      }
    }
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
        case "image":
          if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(block.source.media_type)) {
            parts.push({
              type: "input_text",
              text: `[Image: ${block.source.media_type} — format not supported by this provider]`,
            });
          } else {
            const imageSrc = base64Source(block.source);
            parts.push({
              type: "input_image",
              image_url: `data:${imageSrc.media_type};base64,${imageSrc.data}`,
            });
          }
          break;
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
      block.source.filename ?? "",
    )}" type="${escapeXmlAttr(block.source.media_type)}" />`;
    if (block.extracted_text && block.extracted_text.trim().length > 0) {
      return `${header}\n${block.extracted_text}`;
    }
    return `${header}\nNo extracted text available.`;
  }
}
