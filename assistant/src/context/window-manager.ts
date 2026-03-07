import { createUserMessage } from "../agent/message-types.js";
import type { ContextWindowConfig } from "../config/types.js";
import type { ContentBlock, Message, Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { estimatePromptTokens, estimateTextTokens } from "./token-estimator.js";

const log = getLogger("context-window");

export const CONTEXT_SUMMARY_MARKER = "<context_summary>";
const CHUNK_MIN_TOKENS = 1000;
const MAX_BLOCK_PREVIEW_CHARS = 3000;
const MAX_FALLBACK_SUMMARY_CHARS = 12000;
const MAX_CONTEXT_SUMMARY_CHARS = 16000;
const COMPACTION_COOLDOWN_MS = 2 * 60 * 1000;
const MIN_GAIN_TOKENS_DURING_COOLDOWN = 1200;
const SEVERE_PRESSURE_RATIO = 0.95;
const MIN_COMPACTABLE_PERSISTED_MESSAGES = 2;
const MAX_PRESERVED_IMAGE_BLOCKS = 5;
const INTERNAL_CONTEXT_SUMMARY_MESSAGES = new WeakSet<Message>();

const SUMMARY_SYSTEM_PROMPT = [
  "You compress long assistant conversations into durable working memory.",
  "Focus on actionable state, not prose.",
  "Preserve concrete facts: goals, constraints, decisions, pending questions, file paths, commands, errors, and TODOs.",
  "Remove repetition and stale details that were superseded.",
  "Return concise markdown using these section headers exactly:",
  "## Goals",
  "## Constraints",
  "## Decisions",
  "## Open Threads",
  "## Key Artifacts",
  "## Recent Progress",
].join("\n");

export interface ContextWindowResult {
  messages: Message[];
  compacted: boolean;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  summaryCacheCreationInputTokens?: number;
  summaryCacheReadInputTokens?: number;
  summaryRawResponses?: unknown[];
  summaryText: string;
  reason?: string;
}

export interface ContextWindowCompactOptions {
  lastCompactedAt?: number;
  /** Bypass the threshold check and force compaction. Used for context-too-large error recovery. */
  force?: boolean;
  /**
   * Override the minimum number of recent user turns to preserve.
   * Set to `0` for emergency recovery that can compact the entire history
   * (except the summary message itself). When omitted, the default floor
   * of 1 recent user turn is enforced.
   */
  minKeepRecentUserTurns?: number;
  /**
   * Override the target input token budget used for keep-boundary
   * projected-fit checks. Allows the caller to demand a stricter fit
   * than the normal `config.targetInputTokens` during forced recovery.
   */
  targetInputTokensOverride?: number;
}

export class ContextWindowManager {
  constructor(
    private readonly provider: Provider,
    private readonly systemPrompt: string,
    private readonly config: ContextWindowConfig,
  ) {}

  async maybeCompact(
    messages: Message[],
    signal?: AbortSignal,
    options?: ContextWindowCompactOptions,
  ): Promise<ContextWindowResult> {
    const previousEstimatedInputTokens = estimatePromptTokens(
      messages,
      this.systemPrompt,
      { providerName: this.provider.name },
    );
    const thresholdTokens = Math.floor(
      this.config.maxInputTokens * this.config.compactThreshold,
    );
    const existingSummary = getSummaryFromContextMessage(messages[0]);

    if (!this.config.enabled) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "context window compaction disabled",
      };
    }

    if (!options?.force && previousEstimatedInputTokens < thresholdTokens) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "below compaction threshold",
      };
    }

    const summaryOffset = existingSummary != null ? 1 : 0;
    const userTurnStarts = collectUserTurnStartIndexes(messages);
    if (userTurnStarts.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "no user turns available for compaction",
      };
    }

    const keepPlan = this.pickKeepBoundary(messages, userTurnStarts, {
      minKeepRecentUserTurns: options?.minKeepRecentUserTurns,
      targetInputTokensOverride: options?.targetInputTokensOverride,
    });
    if (keepPlan.keepFromIndex <= summaryOffset) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "unable to compact while keeping recent turns",
      };
    }

    const compactableMessages = messages.slice(
      summaryOffset,
      keepPlan.keepFromIndex,
    );
    if (compactableMessages.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "no eligible messages to compact",
      };
    }

    const compactedPersistedMessages =
      countPersistedMessages(compactableMessages);
    const projectedMessages = [
      createContextSummaryMessage(existingSummary ?? "Projected summary"),
      ...messages.slice(keepPlan.keepFromIndex),
    ];
    const projectedInputTokens = estimatePromptTokens(
      projectedMessages,
      this.systemPrompt,
      { providerName: this.provider.name },
    );
    const projectedGainTokens = Math.max(
      0,
      previousEstimatedInputTokens - projectedInputTokens,
    );
    const severePressure =
      previousEstimatedInputTokens >=
      Math.floor(this.config.maxInputTokens * SEVERE_PRESSURE_RATIO);
    const lastCompactedAt = options?.lastCompactedAt;

    // Adaptive cooldown: conversations growing quickly (high projected gain) compact
    // sooner. Scale the cooldown inversely with the growth-rate multiplier, capped at
    // 1/4 of the base cooldown so we never check more than 4× as frequently.
    const growthRateMultiplier = Math.max(
      1,
      projectedGainTokens / MIN_GAIN_TOKENS_DURING_COOLDOWN,
    );
    const adaptiveCooldownMs = Math.max(
      COMPACTION_COOLDOWN_MS / 4,
      COMPACTION_COOLDOWN_MS / growthRateMultiplier,
    );
    const withinCooldown =
      typeof lastCompactedAt === "number" &&
      Date.now() - lastCompactedAt < adaptiveCooldownMs;

    // The adaptive cooldown is already tuned to be shorter for fast-growing
    // conversations (high projectedGainTokens → smaller adaptiveCooldownMs).
    // Removing the redundant MIN_GAIN_TOKENS_DURING_COOLDOWN guard here lets
    // that shorter cooldown actually gate compaction: high-growth conversations
    // break out of the cooldown sooner and compact more frequently.
    // force=true bypasses the cooldown so context-too-large recovery can always
    // attempt a compaction even within the cooldown window.
    if (withinCooldown && !severePressure && !options?.force) {
      log.debug(
        {
          projectedGainTokens,
          adaptiveCooldownMs,
          growthRateMultiplier,
          msSinceCompaction:
            typeof lastCompactedAt === "number"
              ? Date.now() - lastCompactedAt
              : null,
        },
        "Compaction cooldown active",
      );
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "compaction cooldown active",
      };
    }

    if (
      compactedPersistedMessages < MIN_COMPACTABLE_PERSISTED_MESSAGES &&
      !severePressure
    ) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "insufficient compactable persisted messages",
      };
    }

    const chunks = chunkMessages(
      compactableMessages,
      Math.max(this.config.chunkTokens, CHUNK_MIN_TOKENS),
    );
    let summary = existingSummary ?? "No previous summary.";
    let summaryInputTokens = 0;
    let summaryOutputTokens = 0;
    let summaryModel = "";
    let summaryCacheCreationInputTokens = 0;
    let summaryCacheReadInputTokens = 0;
    const summaryRawResponses: unknown[] = [];
    let summaryCalls = 0;

    for (const chunk of chunks) {
      const summaryUpdate = await this.updateSummary(summary, chunk, signal);
      summary = summaryUpdate.summary;
      summaryInputTokens += summaryUpdate.inputTokens;
      summaryOutputTokens += summaryUpdate.outputTokens;
      summaryModel = summaryUpdate.model || summaryModel;
      summaryCacheCreationInputTokens += summaryUpdate.cacheCreationInputTokens;
      summaryCacheReadInputTokens += summaryUpdate.cacheReadInputTokens;
      if (Array.isArray(summaryUpdate.rawResponse)) {
        summaryRawResponses.push(...summaryUpdate.rawResponse);
      } else if (summaryUpdate.rawResponse !== undefined) {
        summaryRawResponses.push(summaryUpdate.rawResponse);
      }
      summaryCalls += 1;
    }

    // Extract user-uploaded image blocks from compacted messages so they
    // remain accessible to the assistant in subsequent turns. Tool-result
    // screenshots are NOT preserved — only top-level image blocks in user
    // messages, which represent intentional user uploads.
    // Also carry forward any images already preserved in the existing summary
    // message so they survive multiple compaction cycles.
    const preservedImageBlocks: ContentBlock[] = [];
    if (existingSummary != null) {
      const summaryMsg = messages[0];
      for (const block of summaryMsg.content) {
        if (block.type === "image") {
          preservedImageBlocks.push(block);
        }
      }
    }
    for (const msg of compactableMessages) {
      if (msg.role !== "user") continue;
      for (const block of msg.content) {
        if (block.type === "image") {
          preservedImageBlocks.push(block);
        }
      }
    }

    // Cap preserved images to avoid unbounded accumulation across cycles.
    // Older images (carried forward) are at the front; keep the most recent.
    if (preservedImageBlocks.length > MAX_PRESERVED_IMAGE_BLOCKS) {
      preservedImageBlocks.splice(
        0,
        preservedImageBlocks.length - MAX_PRESERVED_IMAGE_BLOCKS,
      );
    }

    const summaryMessage = createContextSummaryMessage(summary);
    if (preservedImageBlocks.length > 0) {
      summaryMessage.content.push(
        {
          type: "text",
          text: "[The following images were uploaded by the user in earlier messages and are preserved for reference.]",
        },
        ...preservedImageBlocks,
      );
    }

    const compactedMessages = [
      summaryMessage,
      ...messages.slice(keepPlan.keepFromIndex),
    ];
    const estimatedInputTokens = estimatePromptTokens(
      compactedMessages,
      this.systemPrompt,
      { providerName: this.provider.name },
    );
    log.info(
      {
        previousEstimatedInputTokens,
        estimatedInputTokens,
        compactedMessages: compactableMessages.length,
        compactedPersistedMessages,
        keepTurns: keepPlan.keepTurns,
        summaryCalls,
      },
      "Compacted conversation context window",
    );

    return {
      messages: compactedMessages,
      compacted: true,
      previousEstimatedInputTokens,
      estimatedInputTokens,
      maxInputTokens: this.config.maxInputTokens,
      thresholdTokens,
      compactedMessages: compactableMessages.length,
      compactedPersistedMessages,
      summaryCalls,
      summaryInputTokens,
      summaryOutputTokens,
      summaryModel,
      summaryCacheCreationInputTokens,
      summaryCacheReadInputTokens,
      summaryRawResponses,
      summaryText: summary,
    };
  }

  private pickKeepBoundary(
    messages: Message[],
    userTurnStarts: number[],
    opts?: {
      minKeepRecentUserTurns?: number;
      targetInputTokensOverride?: number;
    },
  ): { keepFromIndex: number; keepTurns: number } {
    const minFloor = Math.min(
      Math.max(0, Math.floor(opts?.minKeepRecentUserTurns ?? 1)),
      userTurnStarts.length,
    );
    const targetTokens =
      opts?.targetInputTokensOverride ?? this.config.targetInputTokens;

    let keepTurns = Math.min(
      this.config.preserveRecentUserTurns,
      userTurnStarts.length,
    );
    keepTurns = Math.max(minFloor, keepTurns);

    // When minFloor is 0 and there are no user turns to keep, keepFromIndex
    // points past the end of the array so all messages become compactable.
    let keepFromIndex =
      keepTurns === 0
        ? messages.length
        : (userTurnStarts[userTurnStarts.length - keepTurns] ??
          messages.length);

    while (keepTurns > minFloor) {
      const projectedMessages = [
        createContextSummaryMessage("Projected summary"),
        ...messages.slice(keepFromIndex),
      ];
      const projectedTokens = estimatePromptTokens(
        projectedMessages,
        this.systemPrompt,
        { providerName: this.provider.name },
      );
      if (projectedTokens <= targetTokens) break;
      keepTurns -= 1;
      keepFromIndex =
        keepTurns === 0
          ? messages.length
          : (userTurnStarts[userTurnStarts.length - keepTurns] ??
            keepFromIndex);
    }

    return { keepFromIndex, keepTurns };
  }

  private async updateSummary(
    currentSummary: string,
    chunk: string,
    signal?: AbortSignal,
  ): Promise<{
    summary: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    rawResponse?: unknown;
  }> {
    const prompt = buildSummaryPrompt(currentSummary, chunk);
    try {
      const response = await this.provider.sendMessage(
        [createUserMessage(prompt)],
        undefined,
        SUMMARY_SYSTEM_PROMPT,
        {
          config: { max_tokens: this.config.summaryMaxTokens },
          signal,
        },
      );

      const nextSummary = extractText(response.content).trim();
      if (nextSummary.length > 0) {
        return {
          summary: clampSummary(nextSummary),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model: response.model,
          cacheCreationInputTokens:
            response.usage.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
          rawResponse: response.rawResponse,
        };
      }
    } catch (err) {
      log.warn({ err }, "Summary generation failed, using local fallback");
    }

    return {
      summary: fallbackSummary(currentSummary, chunk),
      inputTokens: 0,
      outputTokens: 0,
      model: "",
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }
}

function collectUserTurnStartIndexes(messages: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (getSummaryFromContextMessage(message) != null) continue;
    if (isToolResultOnly(message)) continue;
    starts.push(i);
  }
  return starts;
}

/**
 * Count messages that have DB counterparts.  Context-summary messages are
 * in-memory-only and excluded; ALL other messages (including tool-result-only
 * user messages) have a corresponding row in the DB and must be counted so
 * that `contextCompactedMessageCount` indexes the DB array correctly.
 */
function countPersistedMessages(messages: Message[]): number {
  return messages.filter((message) => {
    return getSummaryFromContextMessage(message) == null;
  }).length;
}

/** A user message that contains ONLY tool_result blocks (no text or other content). */
function isToolResultOnly(message: Message): boolean {
  return (
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

export function getSummaryFromContextMessage(
  message: Message | undefined,
): string | null {
  if (!message) return null;
  const text = extractText(message.content).trim();
  if (!text.startsWith(CONTEXT_SUMMARY_MARKER)) return null;
  if (INTERNAL_CONTEXT_SUMMARY_MESSAGES.has(message)) {
    return stripContextSummaryTags(text);
  }
  // Backward compatibility for older in-memory sessions that used assistant-role summaries.
  if (message.role === "assistant") {
    return stripContextSummaryTags(text);
  }
  return null;
}

function stripContextSummaryTags(text: string): string {
  let inner = text.slice(CONTEXT_SUMMARY_MARKER.length);
  const closeIdx = inner.lastIndexOf("</context_summary>");
  if (closeIdx !== -1) {
    inner = inner.slice(0, closeIdx);
  }
  return inner.trim();
}

export function createContextSummaryMessage(summary: string): Message {
  const message: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${CONTEXT_SUMMARY_MARKER}\n${clampSummary(
          summary,
        )}\n</context_summary>`,
      },
    ],
  };
  INTERNAL_CONTEXT_SUMMARY_MESSAGES.add(message);
  return message;
}

function buildSummaryPrompt(currentSummary: string, chunk: string): string {
  return [
    "Update the summary with new transcript data.",
    "If new information conflicts with older notes, keep the most recent and explicit detail.",
    "Keep all unresolved asks and next steps.",
    "",
    "### Existing Summary",
    currentSummary.trim().length > 0 ? currentSummary.trim() : "None.",
    "",
    "### New Transcript Chunk",
    chunk,
  ].join("\n");
}

function chunkMessages(
  messages: Message[],
  maxTokensPerChunk: number,
): string[] {
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const line = serializeForSummary(messages[i], i);
    const lineTokens = estimateTextTokens(line) + 1;
    if (
      currentChunk.length > 0 &&
      currentTokens + lineTokens > maxTokensPerChunk
    ) {
      chunks.push(currentChunk.join("\n\n"));
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(line);
    currentTokens += lineTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n\n"));
  }

  return chunks;
}

function serializeForSummary(message: Message, index: number): string {
  const lines = [`Message #${index + 1} (${message.role})`];

  for (const block of message.content) {
    lines.push(serializeBlock(block));
  }

  return lines.join("\n");
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text: ${clampText(block.text)}`;
    case "tool_use":
      return `tool_use ${block.name}: ${clampText(stableJson(block.input))}`;
    case "tool_result":
      return `tool_result ${block.tool_use_id}${
        block.is_error ? " (error)" : ""
      }: ${clampText(block.content)}`;
    case "image":
      return `image: ${block.source.media_type}, ${
        Math.ceil(block.source.data.length / 4) * 3
      } bytes(base64)`;
    case "file": {
      const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
      const parts = [
        `file: ${block.source.filename}`,
        block.source.media_type,
        `${sizeBytes} bytes(base64)`,
      ];
      if (block.extracted_text) {
        parts.push(`text=${clampText(block.extracted_text)}`);
      }
      return parts.join(", ");
    }
    case "thinking":
      return `thinking: ${clampText(block.thinking)}`;
    case "redacted_thinking":
      return "redacted_thinking";
    default:
      return "unknown_block";
  }
}

function clampText(text: string): string {
  if (text.length <= MAX_BLOCK_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_BLOCK_PREVIEW_CHARS)}... [truncated ${
    text.length - MAX_BLOCK_PREVIEW_CHARS
  } chars]`;
}

function fallbackSummary(currentSummary: string, chunk: string): string {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-120).join("\n");
  const merged = [
    currentSummary.trim(),
    "## Recent Progress",
    recentLines.length > 0 ? recentLines : "No new details.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (merged.length <= MAX_FALLBACK_SUMMARY_CHARS) return merged;
  return merged.slice(merged.length - MAX_FALLBACK_SUMMARY_CHARS);
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function clampSummary(summary: string): string {
  if (summary.length <= MAX_CONTEXT_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_CONTEXT_SUMMARY_CHARS)}...`;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
