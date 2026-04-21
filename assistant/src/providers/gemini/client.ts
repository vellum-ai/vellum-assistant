import type * as genai from "@google/genai";
import { ApiError, GoogleGenAI } from "@google/genai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { createStreamTimeout } from "../stream-timeout.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";
import {
  ContextOverflowError,
  extractOverflowTokensFromMessage,
} from "../types.js";

/**
 * Token/context-specific phrases that reliably indicate context-overflow
 * regardless of status code. These never appear in quota/rate-limit error
 * messages, so matching one of these is safe on any accepted status.
 */
const GEMINI_CONTEXT_OVERFLOW_TOKEN_PATTERNS =
  /token.?count.*exceeds|exceeds.*maximum.*tokens|prompt.?is.?too.?long|too.?many.?(?:input.?)?tokens|input.?too.?long|context.?length.?exceeded/i;

/**
 * Detect Gemini's context-overflow signals on an `ApiError`. Gemini surfaces
 * this condition via its "RESOURCE_EXHAUSTED" category. The Gemini SDK's
 * `ApiError` only exposes `status` and `message`, so we match on both.
 *
 * On 400 (INVALID_ARGUMENT, the Generative Language API path), the
 * `resource.?exhausted` phrase alone is sufficient — only context-overflow
 * is surfaced with that status.
 *
 * On 429 (RESOURCE_EXHAUSTED, the Vertex path), the same status is used for
 * BOTH rate-limit quota exhaustion AND context-overflow. To discriminate,
 * we require a token/context-specific phrase; the bare `resource.?exhausted`
 * signal is too broad and would misclassify quota errors as overflow and
 * bypass the retry path in `providers/retry.ts`.
 */
export function detectGeminiContextOverflow(
  error: ApiError,
): { actualTokens?: number; maxTokens?: number } | null {
  const status = error.status;
  // 400 = INVALID_ARGUMENT (prompt too long), 413 occasional,
  // 429 with RESOURCE_EXHAUSTED is the Vertex path.
  if (status !== 400 && status !== 413 && status !== 429) return null;
  const message = error.message ?? "";

  // 429 has two meanings (quota vs context-overflow) — require a
  // token/context-specific phrase to classify as overflow.
  if (status === 429) {
    if (!GEMINI_CONTEXT_OVERFLOW_TOKEN_PATTERNS.test(message)) return null;
    return extractOverflowTokensFromMessage(message);
  }

  // 400/413: either a token/context-specific phrase or the broader
  // `resource.?exhausted` signal is a reliable overflow indicator.
  const matches =
    /resource.?exhausted/i.test(message) ||
    GEMINI_CONTEXT_OVERFLOW_TOKEN_PATTERNS.test(message);
  if (!matches) return null;
  return extractOverflowTokensFromMessage(message);
}

const log = getLogger("gemini-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validate a Gemini API key by making a lightweight models.list() call.
 * Returns `{ valid: true }` on success or `{ valid: false, reason: string }` on failure.
 */
export async function validateGeminiApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new GoogleGenAI({ apiKey });
    await client.models.list({
      config: {
        pageSize: 1,
        httpOptions: { timeout: VALIDATION_TIMEOUT_MS },
      },
    });
    return { valid: true };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `Gemini API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — validation is inconclusive,
      // allow the key to be stored rather than blocking the user.
      log.warn(
        { status: error.status },
        "Gemini API returned a transient error during key validation — allowing key storage",
      );
      return { valid: true };
    }
    // Network errors — validation is inconclusive, allow key storage.
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during Gemini key validation — allowing key storage",
    );
    return { valid: true };
  }
}

export interface GeminiProviderOptions {
  streamTimeoutMs?: number;
  /** When set, routes requests through the managed proxy at this base URL. */
  managedBaseUrl?: string;
}

export class GeminiProvider implements Provider {
  public readonly name = "gemini";
  private client: GoogleGenAI;
  private model: string;
  private streamTimeoutMs: number;

  constructor(
    apiKey: string,
    model: string,
    options: GeminiProviderOptions = {},
  ) {
    this.client = options.managedBaseUrl
      ? new GoogleGenAI({
          apiKey,
          httpOptions: {
            baseUrl: options.managedBaseUrl,
          },
        })
      : new GoogleGenAI({ apiKey });
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

    try {
      const geminiContents = this.toGeminiContents(messages);

      const geminiConfig: genai.GenerateContentConfig = {};

      if (systemPrompt) {
        geminiConfig.systemInstruction = systemPrompt.replaceAll(
          SYSTEM_PROMPT_CACHE_BOUNDARY,
          "\n",
        );
      }
      if (maxTokens) {
        geminiConfig.maxOutputTokens = maxTokens;
      }
      if (tools && tools.length > 0) {
        geminiConfig.tools = [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.input_schema,
            })),
          },
        ];
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);
      geminiConfig.abortSignal = timeoutSignal;

      // Accumulate from streaming chunks
      let fullText = "";
      const functionCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }> = [];
      let finishReason = "unknown";
      let promptTokens = 0;
      let outputTokens = 0;
      let responseModel = modelOverride ?? this.model;

      try {
        const stream = await this.client.models.generateContentStream({
          model: modelOverride ?? this.model,
          contents: geminiContents,
          config: geminiConfig,
        });

        for await (const chunk of stream) {
          // Extract text delta
          const chunkText = chunk.text;
          if (chunkText) {
            fullText += chunkText;
            onEvent?.({ type: "text_delta", text: chunkText });
          }

          // Extract function calls
          const calls = chunk.functionCalls;
          if (calls) {
            for (const fc of calls) {
              functionCalls.push({
                id: fc.id ?? `call_${crypto.randomUUID()}`,
                name: fc.name ?? "",
                args: fc.args ?? {},
              });
            }
          }

          // Extract metadata from chunks
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
          }

          if (chunk.usageMetadata) {
            promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
            outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
          }

          if (chunk.modelVersion) {
            responseModel = chunk.modelVersion;
          }
        }
      } finally {
        cleanupTimeout();
      }

      // Build content blocks
      const content: ContentBlock[] = [];
      if (fullText) {
        content.push({ type: "text", text: fullText });
      }
      for (const fc of functionCalls) {
        content.push({
          type: "tool_use",
          id: fc.id,
          name: fc.name,
          input: fc.args,
        });
      }

      const rawRequest = {
        model: modelOverride ?? this.model,
        contents: geminiContents,
        config: geminiConfig,
      };
      const rawResponse = {
        model: responseModel,
        text: fullText || null,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        finishReason,
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: outputTokens,
        },
      };

      return {
        content,
        model: responseModel,
        usage: { inputTokens: promptTokens, outputTokens },
        stopReason: finishReason,
        rawRequest,
        rawResponse,
      };
    } catch (error) {
      // Propagate a tagged AbortReason (set by the daemon at controller.abort())
      // so wrapped errors can be classified as user cancellation downstream.
      const abortReason =
        signal?.aborted && isAbortReason(signal.reason)
          ? signal.reason
          : undefined;
      if (error instanceof ApiError) {
        const overflow = detectGeminiContextOverflow(error);
        if (overflow) {
          throw new ContextOverflowError(
            `Gemini API error (${error.status}): ${error.message}`,
            "gemini",
            {
              actualTokens: overflow.actualTokens,
              maxTokens: overflow.maxTokens,
              statusCode: error.status,
              cause: error,
            },
          );
        }
        throw new ProviderError(
          `Gemini API error (${error.status}): ${error.message}`,
          "gemini",
          error.status,
          abortReason ? { abortReason } : undefined,
        );
      }
      throw new ProviderError(
        `Gemini request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "gemini",
        undefined,
        abortReason ? { cause: error, abortReason } : { cause: error },
      );
    }
  }

  /** Convert neutral messages to Gemini Content[] format. */
  private toGeminiContents(messages: Message[]): genai.Content[] {
    const result: genai.Content[] = [];

    // Build a map from tool_use id → function name so tool_result blocks
    // can provide the required `name` field on Gemini's FunctionResponse.
    const toolCallNames = new Map<string, string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolCallNames.set(block.id, block.name);
        }
      }
    }

    for (const msg of messages) {
      const role = msg.role === "assistant" ? "model" : "user";
      const { parts, toolResultImageParts } = this.toGeminiParts(
        msg.content,
        toolCallNames,
      );
      if (parts.length > 0) {
        result.push({ role, parts });
      }
      // Gemini requires that a Content with functionResponse parts must not
      // contain non-functionResponse parts. Emit tool-result images in a
      // separate user Content entry.
      if (toolResultImageParts.length > 0) {
        result.push({ role: "user", parts: toolResultImageParts });
      }
    }

    return result;
  }

  /** Convert ContentBlock[] to Gemini Part[] and any tool-result image parts. */
  private toGeminiParts(
    blocks: ContentBlock[],
    toolCallNames: Map<string, string>,
  ): { parts: genai.Part[]; toolResultImageParts: genai.Part[] } {
    const parts: genai.Part[] = [];
    const toolResultImageParts: genai.Part[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          parts.push({ text: block.text });
          break;
        case "image":
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
          break;
        case "file":
          if (this.supportsGeminiInlineFile(block.source.media_type)) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            });
          } else {
            const fallback = block.extracted_text?.trim()
              ? `[Attached file: ${block.source.filename} (${block.source.media_type})]\n${block.extracted_text}`
              : `[Attached file: ${block.source.filename} (${block.source.media_type})]\nNo extracted text available.`;
            parts.push({ text: fallback });
          }
          break;
        case "tool_use":
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
            },
          });
          break;
        case "tool_result": {
          let outputText = block.content;
          if (block.contentBlocks && block.contentBlocks.length > 0) {
            const extraText = block.contentBlocks
              .filter(
                (cb): cb is Extract<ContentBlock, { type: "text" }> =>
                  cb.type === "text",
              )
              .map((cb) => cb.text);
            if (extraText.length > 0) {
              outputText = outputText + "\n" + extraText.join("\n");
            }
            // Collect images separately — Gemini rejects mixing inlineData
            // with functionResponse in the same Content entry.
            for (const cb of block.contentBlocks) {
              if (cb.type === "image") {
                toolResultImageParts.push({
                  inlineData: {
                    mimeType: cb.source.media_type,
                    data: cb.source.data,
                  },
                });
              }
            }
          }
          parts.push({
            functionResponse: {
              name: toolCallNames.get(block.tool_use_id) ?? block.tool_use_id,
              response: { output: outputText },
            },
          });
          break;
        }
        case "server_tool_use":
          parts.push({ text: `[Web search: ${block.name}]` });
          break;
        case "web_search_tool_result":
          parts.push({ text: "[Web search results]" });
          break;
        // thinking, redacted_thinking — not applicable for Gemini
      }
    }

    return { parts, toolResultImageParts };
  }

  private supportsGeminiInlineFile(mimeType: string): boolean {
    return mimeType === "application/pdf";
  }
}
