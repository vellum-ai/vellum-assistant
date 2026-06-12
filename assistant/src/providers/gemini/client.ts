import type * as genai from "@google/genai";
import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";

import {
  THINKING_LEVELS,
  type ThinkingLevel as ThinkingLevelName,
} from "../../config/schemas/llm.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { createStreamTimeout } from "../stream-timeout.js";
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
  base64ByteLength,
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  normalizeGeminiAudioMime,
} from "./inline-media.js";

/**
 * Token/context-specific phrases that reliably indicate context-overflow
 * regardless of status code. These never appear in quota/rate-limit error
 * messages, so matching one of these is safe on any accepted status.
 */
const GEMINI_CONTEXT_OVERFLOW_TOKEN_PATTERNS =
  /token.?count.*exceeds|exceeds.*maximum.*tokens|prompt.?is.?too.?long|too.?many.?(?:input.?)?tokens|input.?too.?long|context.?length.?exceeded/i;

const GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE =
  "context_engineering_is_the_way_to_go";

function isGemini3Model(model: string): boolean {
  return model.startsWith("gemini-3") || model.startsWith("models/gemini-3");
}

const THINKING_LEVEL_BY_NAME: Record<ThinkingLevelName, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Default thinking level for Gemini Pro models when the profile doesn't pin
 * one. Pro rejects `"minimal"` and an absent level resolves to `"minimal"`
 * upstream, so we pin Google's documented Pro default (`"high"`) — always a
 * supported value.
 */
const GEMINI_PRO_DEFAULT_THINKING_LEVEL: ThinkingLevelName = "high";

/**
 * Gemini 3.x Pro family accepts only `low`/`medium`/`high` (no `"minimal"`) and
 * cannot fully disable thinking. Matches `gemini-3.1-pro-preview`,
 * `gemini-3.1-pro-preview-customtools`, and future `gemini-3*pro*`.
 */
function isGeminiProModel(model: string): boolean {
  const normalized = model.startsWith("models/")
    ? model.slice("models/".length)
    : model;
  return /^gemini-3.*pro/.test(normalized);
}

/**
 * Lowest thinking level the model accepts. Pro's floor is `"low"`; every other
 * thinking-capable Gemini model accepts `"minimal"`.
 */
function geminiThinkingFloor(model: string): ThinkingLevelName {
  return isGeminiProModel(model) ? "low" : "minimal";
}

/**
 * Raise `level` to `floor` when it sits below it, so we never send a level the
 * model rejects (e.g. `"minimal"` to a Pro model).
 */
function clampThinkingLevelToFloor(
  level: ThinkingLevelName,
  floor: ThinkingLevelName,
): ThinkingLevelName {
  return THINKING_LEVELS.indexOf(level) < THINKING_LEVELS.indexOf(floor)
    ? floor
    : level;
}

/**
 * Translate the resolved wire-shape `thinking` config into Gemini's
 * `thinkingConfig`, guaranteeing the emitted `thinkingLevel` is one the model
 * accepts. Returns `undefined` when nothing needs to be set, which lets
 * Google's per-model default apply (e.g. `gemini-3.5-flash` defaults to
 * dynamic medium-level thinking).
 *
 * - `enabled: false` maps to the model's floor — the most "off" state it
 *   allows (`"minimal"` for most models, `"low"` for Pro, which can't disable
 *   thinking).
 * - An explicit `level` below the floor is raised to the floor.
 * - When no `level` is pinned, Pro models get the documented default (`"high"`)
 *   because an absent level resolves to the unsupported `"minimal"` upstream;
 *   other models keep Google's per-model default by leaving the level unset.
 *
 * `includeThoughts` is gated on `streamThinking` so callers that opted out of
 * streaming thoughts don't pay for thought tokens in the response.
 */
function buildThinkingConfig(
  thinking: Record<string, unknown> | undefined,
  model: string,
): genai.ThinkingConfig | undefined {
  if (!thinking) return undefined;
  const floor = geminiThinkingFloor(model);

  if (thinking.type === "disabled") {
    return {
      thinkingLevel: THINKING_LEVEL_BY_NAME[floor],
      includeThoughts: false,
    };
  }
  if (thinking.type !== "adaptive") return undefined;

  const result: genai.ThinkingConfig = {};
  if (
    typeof thinking.level === "string" &&
    thinking.level in THINKING_LEVEL_BY_NAME
  ) {
    const clamped = clampThinkingLevelToFloor(
      thinking.level as ThinkingLevelName,
      floor,
    );
    result.thinkingLevel = THINKING_LEVEL_BY_NAME[clamped];
  } else if (isGeminiProModel(model)) {
    result.thinkingLevel =
      THINKING_LEVEL_BY_NAME[GEMINI_PRO_DEFAULT_THINKING_LEVEL];
  }
  if (typeof thinking.streamThinking === "boolean") {
    result.includeThoughts = thinking.streamThinking;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Whether the active Gemini model accepts a `thinkingConfig`. Non-thinking
 * models (e.g. `gemini-2.5-flash-lite`) reject thinking params, and gemini is
 * in `THINKING_AWARE_PROVIDERS` so `providers/retry.ts` no longer strips them —
 * so we gate on the catalog's `supportsThinking` capability here. Unknown or
 * uncatalogued models default to allowing thinking config (preserving prior
 * behavior); only an explicit `supportsThinking: false` suppresses it.
 */
function geminiModelSupportsThinking(model: string): boolean {
  const normalized = model.startsWith("models/")
    ? model.slice("models/".length)
    : model;
  const catalogModel = PROVIDER_CATALOG.find(
    (provider) => provider.id === "gemini",
  )?.models.find((m) => m.id === normalized);
  return catalogModel?.supportsThinking !== false;
}

function stripGeminiHttpOptions(
  config: genai.GenerateContentConfig,
): genai.GenerateContentConfig {
  const { httpOptions: _httpOptions, ...rest } =
    config as genai.GenerateContentConfig & {
      httpOptions?: unknown;
    };
  return rest;
}

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
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { tools, systemPrompt, config, onEvent, signal } = options ?? {};
    const configObj = config as Record<string, unknown> | undefined;
    const maxTokens = configObj?.max_tokens as number | undefined;
    const modelOverride = configObj?.model as string | undefined;
    const usageAttributionHeaders = configObj?.usageAttributionHeaders as
      | Record<string, string>
      | undefined;
    const activeModel = modelOverride ?? this.model;
    const thinkingConfig = geminiModelSupportsThinking(activeModel)
      ? buildThinkingConfig(
          configObj?.thinking as Record<string, unknown> | undefined,
          activeModel,
        )
      : undefined;

    try {
      const geminiContents = this.toGeminiContents(messages, activeModel);

      const geminiConfig: genai.GenerateContentConfig = {};

      if (systemPrompt) {
        geminiConfig.systemInstruction = systemPrompt.replaceAll(
          SYSTEM_PROMPT_CACHE_BOUNDARY,
          "\n\n",
        );
      }
      if (maxTokens) {
        geminiConfig.maxOutputTokens = maxTokens;
      }
      if (thinkingConfig) {
        geminiConfig.thinkingConfig = thinkingConfig;
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
      if (usageAttributionHeaders) {
        geminiConfig.httpOptions = { headers: usageAttributionHeaders };
      }

      // Accumulate from streaming chunks
      let fullText = "";
      const functionCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        thoughtSignature?: string;
      }> = [];
      const appendFunctionCall = (
        fc: genai.FunctionCall,
        thoughtSignature?: string,
      ) => {
        functionCalls.push({
          id: fc.id ?? `call_${crypto.randomUUID()}`,
          name: fc.name ?? "",
          args: fc.args ?? {},
          thoughtSignature,
        });
      };
      let finishReason = "unknown";
      let promptTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let responseModel = activeModel;

      try {
        const stream = await this.client.models.generateContentStream({
          model: activeModel,
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

          // Extract function calls. Candidate parts carry provider metadata
          // that the SDK's convenience getter omits, so prefer them when present.
          const functionCallParts =
            chunk.candidates?.[0]?.content?.parts?.filter(
              (part) => part.functionCall,
            ) ?? [];
          if (functionCallParts.length > 0) {
            for (const part of functionCallParts) {
              const fc = part.functionCall;
              if (!fc) continue;
              appendFunctionCall(fc, part.thoughtSignature);
            }
          } else {
            const calls = chunk.functionCalls;
            if (calls) {
              for (const fc of calls) {
                appendFunctionCall(fc);
              }
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
            // Gemini 2.5+/3.x cache a stable request prefix implicitly (on by
            // default). promptTokenCount already includes these cached tokens,
            // so cachedContentTokenCount is the read subset — surface it so the
            // pricing layer applies the discounted cache-read rate.
            cachedTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0;
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
        const block: ContentBlock = {
          type: "tool_use",
          id: fc.id,
          name: fc.name,
          input: fc.args,
        };
        if (fc.thoughtSignature) {
          block.providerMetadata = {
            gemini: { thoughtSignature: fc.thoughtSignature },
          };
        }
        content.push(block);
      }

      const rawRequest = {
        model: activeModel,
        contents: geminiContents,
        config: stripGeminiHttpOptions(geminiConfig),
      };
      const rawResponse = {
        model: responseModel,
        text: fullText || null,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        finishReason,
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: outputTokens,
          cachedContentTokenCount: cachedTokens,
        },
      };

      return {
        content,
        model: responseModel,
        usage: {
          inputTokens: promptTokens,
          outputTokens,
          ...(cachedTokens > 0 ? { cacheReadInputTokens: cachedTokens } : {}),
        },
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
  private toGeminiContents(
    messages: Message[],
    model: string,
  ): genai.Content[] {
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
      const { parts, toolResultMediaParts } = this.toGeminiParts(
        msg.content,
        toolCallNames,
        model,
        role,
      );
      if (parts.length > 0) {
        result.push({ role, parts });
      }
      // Gemini requires that a Content with functionResponse parts must not
      // contain non-functionResponse parts. Emit tool-result images in a
      // separate user Content entry.
      if (toolResultMediaParts.length > 0) {
        result.push({ role: "user", parts: toolResultMediaParts });
      }
    }

    return result;
  }

  /** Convert ContentBlock[] to Gemini Part[] and any tool-result image parts. */
  private toGeminiParts(
    blocks: ContentBlock[],
    toolCallNames: Map<string, string>,
    model: string,
    role: "model" | "user",
  ): { parts: genai.Part[]; toolResultMediaParts: genai.Part[] } {
    const parts: genai.Part[] = [];
    const toolResultMediaParts: genai.Part[] = [];

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
        case "file": {
          if (this.supportsGeminiInlineFile(block.source.media_type)) {
            // Normalize audio MIME onto Gemini's spelling (e.g. audio/mpeg →
            // audio/mp3); PDFs pass through unchanged. Guard the 20 MB inline
            // request limit for audio so an oversize clip degrades to a text
            // note rather than 400ing the whole request.
            const audioMime = normalizeGeminiAudioMime(block.source.media_type);
            const rawBytes = base64ByteLength(block.source.data);
            if (audioMime && rawBytes > GEMINI_MAX_INLINE_AUDIO_BYTES) {
              const approxMb = Math.round(rawBytes / (1024 * 1024));
              parts.push({
                text: `[Audio file too large to send inline: ${block.source.filename} (${block.source.media_type}, ~${approxMb}MB). Gemini's inline request limit is 20MB; this file was omitted. Ask the user for a shorter clip.]`,
              });
            } else {
              parts.push({
                inlineData: {
                  mimeType: audioMime ?? block.source.media_type,
                  data: block.source.data,
                },
              });
            }
          } else {
            const fallback = block.extracted_text?.trim()
              ? `[Attached file: ${block.source.filename} (${block.source.media_type})]\n${block.extracted_text}`
              : `[Attached file: ${block.source.filename} (${block.source.media_type})]\nNo extracted text available.`;
            parts.push({ text: fallback });
          }
          break;
        }
        case "tool_use":
          {
            const functionCallPart: genai.Part = {
              functionCall: {
                name: block.name,
                args: block.input,
              },
            };
            const thoughtSignature =
              block.providerMetadata?.gemini?.thoughtSignature;
            if (thoughtSignature) {
              functionCallPart.thoughtSignature = thoughtSignature;
            }
            parts.push(functionCallPart);
          }
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
            // Collect images and inline-able audio separately — Gemini rejects
            // mixing inlineData with functionResponse in the same Content entry.
            for (const cb of block.contentBlocks) {
              if (cb.type === "image") {
                toolResultMediaParts.push({
                  inlineData: {
                    mimeType: cb.source.media_type,
                    data: cb.source.data,
                  },
                });
              } else if (cb.type === "file") {
                const audioMime = normalizeGeminiAudioMime(
                  cb.source.media_type,
                );
                if (
                  audioMime &&
                  base64ByteLength(cb.source.data) <=
                    GEMINI_MAX_INLINE_AUDIO_BYTES
                ) {
                  toolResultMediaParts.push({
                    inlineData: { mimeType: audioMime, data: cb.source.data },
                  });
                } else if (audioMime) {
                  // Oversize audio: note it in the functionResponse output
                  // rather than a media part (a text part can't ride the
                  // separate media Content, and inline audio would blow
                  // Gemini's request-size limit).
                  outputText =
                    outputText +
                    `\n[Audio too large to send inline: ${cb.source.filename}. Ask for a shorter clip.]`;
                }
                // Non-inline-able file sub-blocks (m4a/opus/pdf) are skipped
                // here; the tool's text output already conveys the file.
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

    if (role === "model") {
      this.addGemini3UnsignedToolCallFallback(parts, model);
    }

    return { parts, toolResultMediaParts };
  }

  private addGemini3UnsignedToolCallFallback(
    parts: genai.Part[],
    model: string,
  ): void {
    if (!isGemini3Model(model)) return;

    const functionCallParts = parts.filter((part) => part.functionCall);
    if (functionCallParts.length === 0) return;

    const hasRealThoughtSignature = functionCallParts.some((part) =>
      Boolean(part.thoughtSignature),
    );
    if (hasRealThoughtSignature) return;

    const firstFunctionCallPart = functionCallParts[0];
    if (!firstFunctionCallPart) return;
    firstFunctionCallPart.thoughtSignature =
      GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE;
  }

  private supportsGeminiInlineFile(mimeType: string): boolean {
    return (
      mimeType === "application/pdf" ||
      normalizeGeminiAudioMime(mimeType) !== null
    );
  }
}
