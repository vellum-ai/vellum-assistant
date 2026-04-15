import OpenAI from "openai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { escapeXmlAttr } from "../../util/xml.js";
import { createStreamTimeout } from "../stream-timeout.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";

export interface OpenAIResponsesProviderOptions {
  baseURL?: string;
  providerName?: string;
  providerLabel?: string;
  streamTimeoutMs?: number;
}

/** Map our internal effort values to the Responses API reasoning.effort parameter. */
const EFFORT_TO_REASONING_EFFORT: Record<string, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

/** Loosely-typed Responses stream event to avoid `any` while the SDK types settle. */
interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string };
  response?: {
    model?: string;
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
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

  constructor(
    apiKey: string,
    model: string,
    options: OpenAIResponsesProviderOptions = {},
  ) {
    this.name = options.providerName ?? "openai";
    this.providerLabel = options.providerLabel ?? "OpenAI";
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
    });
    this.model = model;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { config, onEvent, signal } = options ?? {};
    const configObj = config as Record<string, unknown> | undefined;
    const maxTokens = configObj?.max_tokens as number | undefined;
    const modelOverride = configObj?.model as string | undefined;
    const effort = configObj?.effort as string | undefined;

    try {
      const input = this.toResponsesInput(messages);

      const params: Record<string, unknown> = {
        model: modelOverride ?? this.model,
        input,
        store: false,
      };

      if (systemPrompt) {
        params.instructions = systemPrompt.replaceAll(
          SYSTEM_PROMPT_CACHE_BOUNDARY,
          "\n",
        );
      }

      if (maxTokens) {
        params.max_output_tokens = maxTokens;
      }

      const reasoningEffort = effort
        ? EFFORT_TO_REASONING_EFFORT[effort]
        : undefined;
      if (reasoningEffort) {
        params.reasoning = { effort: reasoningEffort };
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
          strict: null,
        }));
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);

      // Accumulate the response from stream events
      let contentText = "";
      const toolCallMap = new Map<
        string,
        { callId: string; name: string; args: string }
      >();
      let currentToolCallId = "";
      let finishReason = "unknown";
      let responseModel = modelOverride ?? this.model;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let rawFinalResponse: unknown = undefined;

      try {
        // The SDK exposes `client.responses.stream()` — cast through
        // `unknown` to avoid `any` while the SDK's exported types stabilise.
        const responsesApi = this.client.responses as unknown as {
          stream(
            p: Record<string, unknown>,
            o: { signal: AbortSignal },
          ): AsyncIterable<ResponsesStreamEvent>;
        };
        const stream = responsesApi.stream(params, {
          signal: timeoutSignal,
        });

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
                currentToolCallId = item.call_id ?? "";
                const name = item.name ?? "";
                toolCallMap.set(currentToolCallId, {
                  callId: currentToolCallId,
                  name,
                  args: "",
                });
              }
              break;
            }

            case "response.function_call_arguments.delta": {
              const delta = event.delta;
              if (delta && currentToolCallId) {
                const entry = toolCallMap.get(currentToolCallId);
                if (entry) {
                  entry.args += delta;
                }
              }
              break;
            }

            case "response.function_call_arguments.done": {
              // Tool call arguments are complete; reset current tracking
              // so the next output_item.added picks up fresh.
              break;
            }

            case "response.completed": {
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
                }
                finishReason = response.status ?? "completed";
              }
              break;
            }
          }
        }
      } finally {
        cleanupTimeout();
      }

      // Build content blocks
      const content: ContentBlock[] = [];
      if (contentText) {
        content.push({ type: "text", text: contentText });
      }
      for (const [, tc] of toolCallMap) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.args);
        } catch {
          input = { _raw: tc.args };
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
        const retryAfterMs = extractRetryAfterMs(error.headers);
        const errorOptions: {
          retryAfterMs?: number;
          abortReason?: unknown;
        } = {};
        if (retryAfterMs !== undefined)
          errorOptions.retryAfterMs = retryAfterMs;
        if (abortReason) errorOptions.abortReason = abortReason;
        throw new ProviderError(
          `${this.providerLabel} API error (${error.status}): ${error.message}`,
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
            parts.push({
              type: "input_image",
              image_url: `data:${block.source.media_type};base64,${block.source.data}`,
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
      block.source.filename,
    )}" type="${escapeXmlAttr(block.source.media_type)}" />`;
    if (block.extracted_text && block.extracted_text.trim().length > 0) {
      return `${header}\n${block.extracted_text}`;
    }
    return `${header}\nNo extracted text available.`;
  }
}
