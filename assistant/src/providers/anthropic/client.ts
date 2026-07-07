import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { stripOrphanedSurrogatesDeep } from "../../util/unicode.js";
import { base64Source, resolveMediaReferences } from "../media-resolve.js";
import {
  couldBePlaceholderSentinelPrefix,
  isPlaceholderSentinelText,
  PLACEHOLDER_BLOCKS_OMITTED,
  PLACEHOLDER_EMPTY_TURN,
} from "../placeholder-sentinels.js";
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

const log = getLogger("anthropic-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Detect Anthropic's `prompt_too_long` context-overflow signal.
 *
 * Anthropic returns HTTP 400 with a body shaped as
 *   `{ type: "error", error: { type: "invalid_request_error", message: "..." } }`
 * where the inner `message` carries the "prompt is too long: N tokens > M
 * maximum" text. The SDK stores the body at `APIError.error` and formats a
 * top-level `message` by JSON-stringifying the body when no top-level
 * `.message` key exists — so we probe both the nested body and the
 * formatted string.
 */
export function detectAnthropicContextOverflow(
  error: InstanceType<typeof Anthropic.APIError>,
): { actualTokens?: number; maxTokens?: number } | null {
  // 413 is theoretically adjacent but Anthropic does not emit it today.
  if (error.status !== 400) return null;
  const body = error.error as
    | {
        type?: string;
        message?: string;
        error?: { type?: string; message?: string };
      }
    | undefined;
  const innerMessage =
    (typeof body === "object" && body != null
      ? (body.error?.message ?? body.message)
      : undefined) ?? "";
  const topLevelMessage = error.message ?? "";
  const combined = `${innerMessage} ${topLevelMessage}`;
  if (!/prompt.?is.?too.?long|prompt_too_long/i.test(combined)) return null;
  // Prefer the clean inner message over the JSON-stringified top-level string.
  return extractOverflowTokensFromMessage(innerMessage || topLevelMessage);
}

/** Rate-limit the orphaned-surrogate warning so a single bad stream can't flood logs. */
const ORPHAN_WARNING_THROTTLE_MS = 60_000;
let lastOrphanWarningMs = 0;

function logOrphanedSurrogateWarning(
  fixedStringCount: number,
  messages: Anthropic.MessageParam[],
): void {
  const now = Date.now();
  if (now - lastOrphanWarningMs < ORPHAN_WARNING_THROTTLE_MS) return;
  lastOrphanWarningMs = now;
  const blockTypes = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block !== "object" || block == null) continue;
      const type = (block as { type?: string }).type;
      if (type) blockTypes.add(type);
    }
  }
  log.warn(
    {
      fixedStringCount,
      blockTypes: Array.from(blockTypes),
    },
    "stripped orphaned UTF-16 surrogates from outbound Anthropic request — upstream truncation is not surrogate-aware",
  );
}

/**
 * Validate an Anthropic API key by making a lightweight GET /v1/models call.
 * Returns `{ valid: true }` on success or `{ valid: false, reason: string }` on failure.
 */
export async function validateAnthropicApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new Anthropic({
      apiKey,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list({ limit: 1 });
    return { valid: true };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `Anthropic API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — validation is inconclusive,
      // allow the key to be stored rather than blocking the user.
      log.warn(
        { status: error.status },
        "Anthropic API returned a transient error during key validation — allowing key storage",
      );
      return { valid: true };
    }
    // Network errors — validation is inconclusive, allow key storage.
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during Anthropic key validation — allowing key storage",
    );
    return { valid: true };
  }
}

const TOOL_ID_RE = /[^a-wyzA-Z0-9_-]/g;

const ANTHROPIC_SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isTextBasedMimeType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/javascript"
  );
}

/** Anthropic requires tool_use IDs to match ^[a-zA-Z0-9_-]+$ */
function sanitizeToolId(id: string): string {
  if (!id) return "empty";
  // Escape `x` itself (to `x78`) so it can safely serve as the hex-escape
  // prefix without collisions.  E.g. "a:" → "ax3a", "ax3a" → "ax783a".
  return id.replace(TOOL_ID_RE, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(4, "0");
    return `x${hex}`;
  });
}

const SYNTHETIC_RESULT =
  "<synthesized_result>tool result missing from history</synthesized_result>";

/**
 * Synthetic placeholder injected as user-message content when Anthropic API
 * alternation requires a user turn but no real user content exists. Uses the
 * `__injected` XML tag convention so the LLM treats it as system metadata
 * rather than user speech.
 */
const SYNTHETIC_CONTINUATION_TEXT = "<synthetic_continuation __injected />";

/** Type-guard for tool_use blocks in Anthropic-formatted content. */
function isToolUseBlock(block: unknown): block is Anthropic.ToolUseBlockParam {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "tool_use"
  );
}

/** Type-guard for tool_result blocks in Anthropic-formatted content. */
function isToolResultBlock(
  block: unknown,
): block is Anthropic.ToolResultBlockParam {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "tool_result"
  );
}

/**
 * Build a short diagnostic summary of a message array for error logging.
 * Shows role + block types (with tool_use/tool_result IDs) for each message.
 */
function summarizeMessages(messages: Anthropic.MessageParam[]): string[] {
  return messages.map((m, idx) => {
    const content = Array.isArray(m.content) ? m.content : [{ type: "text" }];
    const blockDescs = content.map((b) => {
      const bt = (b as { type: string }).type;
      if (bt === "tool_use") return `tool_use(${(b as { id: string }).id})`;
      if (bt === "server_tool_use")
        return `server_tool_use(${(b as { id: string }).id})`;
      if (bt === "tool_result")
        return `tool_result(${(b as { tool_use_id: string }).tool_use_id})`;
      if (bt === "web_search_tool_result")
        return `web_search_tool_result(${(b as { tool_use_id: string }).tool_use_id})`;
      return bt;
    });
    return `[${idx}] ${m.role}: ${blockDescs.join(", ") || "(empty)"}`;
  });
}

function buildSyntheticToolResult(
  toolUseId: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: SYNTHETIC_RESULT,
    is_error: true,
  };
}

/**
 * Collect ordered IDs of client-side tool_use blocks only.
 * Server-side tools (server_tool_use / web_search_tool_result) are self-paired
 * within the assistant message and do not need cross-message pairing.
 */
function getOrderedToolUseIds(
  content: Anthropic.ContentBlockParam[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (isToolUseBlock(block)) {
      if (!seen.has(block.id)) {
        seen.add(block.id);
        ids.push(block.id);
      }
    }
  }
  return ids;
}

function hasOrderedToolResultPrefix(
  content: Anthropic.ContentBlockParam[],
  orderedToolUseIds: string[],
): boolean {
  if (content.length < orderedToolUseIds.length) return false;
  for (let idx = 0; idx < orderedToolUseIds.length; idx++) {
    const block = content[idx];
    const expectedId = orderedToolUseIds[idx];
    if (!isToolResultBlock(block)) return false;
    if (block.tool_use_id !== expectedId) return false;
  }
  return true;
}

/**
 * Split an assistant message into:
 * - pairedContent: everything up to and including client-side tool_use blocks
 * - carryoverContent: trailing non-tool blocks after the last tool_use
 *
 * Server-side tools (server_tool_use / web_search_tool_result) are treated as
 * regular content — they are self-paired within the assistant message and must
 * not be separated by the cross-message pairing logic.
 */
function splitAssistantForToolPairing(content: Anthropic.ContentBlockParam[]): {
  pairedContent: Anthropic.ContentBlockParam[];
  carryoverContent: Anthropic.ContentBlockParam[];
  toolUseIds: string[];
} {
  const leading: Anthropic.ContentBlockParam[] = [];
  const toolUseBlocks: Anthropic.ContentBlockParam[] = [];
  const carryover: Anthropic.ContentBlockParam[] = [];
  let seenToolUse = false;

  for (const block of content) {
    if (isToolUseBlock(block)) {
      seenToolUse = true;
      toolUseBlocks.push(block);
      continue;
    }
    if (!seenToolUse) {
      leading.push(block);
    } else {
      carryover.push(block);
    }
  }

  if (toolUseBlocks.length === 0) {
    return {
      pairedContent: content,
      carryoverContent: [],
      toolUseIds: [],
    };
  }

  const pairedContent: Anthropic.ContentBlockParam[] = [
    ...leading,
    ...toolUseBlocks,
  ];
  return {
    pairedContent,
    carryoverContent: carryover,
    toolUseIds: getOrderedToolUseIds(pairedContent),
  };
}

function normalizeFollowingUserContent(
  nextContent: Anthropic.ContentBlockParam[],
  orderedToolUseIds: string[],
): {
  toolResultPrefix: Anthropic.ContentBlockParam[];
  remainingContent: Anthropic.ContentBlockParam[];
  missingIds: string[];
  hadOrderedPrefix: boolean;
} {
  const pendingIds = new Set(orderedToolUseIds);
  const matchedById = new Map<string, Anthropic.ContentBlockParam>();
  const remaining: Anthropic.ContentBlockParam[] = [];

  for (const block of nextContent) {
    if (
      isToolResultBlock(block) &&
      pendingIds.has(block.tool_use_id) &&
      !matchedById.has(block.tool_use_id)
    ) {
      matchedById.set(block.tool_use_id, block);
      continue;
    }
    remaining.push(block);
  }

  const missingIds = orderedToolUseIds.filter((id) => !matchedById.has(id));
  const orderedResults = orderedToolUseIds.map(
    (id) => matchedById.get(id) ?? buildSyntheticToolResult(id),
  );

  return {
    toolResultPrefix: orderedResults,
    remainingContent: remaining,
    missingIds,
    hadOrderedPrefix: hasOrderedToolResultPrefix(
      nextContent,
      orderedToolUseIds,
    ),
  };
}

/** Type-guard for server_tool_use blocks. */
function isServerToolUseBlock(
  block: unknown,
): block is { type: "server_tool_use"; id: string; name: string } {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "server_tool_use"
  );
}

/** Type-guard for web_search_tool_result blocks. */
function isWebSearchToolResultBlock(block: unknown): block is {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown;
} {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "web_search_tool_result"
  );
}

/**
 * Repair orphaned server-side tool blocks within assistant messages. Server-
 * side tools (e.g. web_search) are self-paired: the assistant message should
 * contain both server_tool_use and its matching web_search_tool_result. Either
 * side can go missing — a partial stream may drop the result, or a downstream
 * step (history reload, message split, compaction) may drop the use block.
 * Both cases trigger an Anthropic 400 on the next request, so this function
 * handles both directions:
 *
 *   - server_tool_use without paired result: inject a synthetic error result.
 *   - web_search_tool_result without paired server_tool_use: downgrade to a
 *     text block describing what was found so the model retains context.
 */
function repairOrphanedServerToolBlocks(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const content = Array.isArray(msg.content) ? msg.content : [];

    const serverToolUseIds = new Set<string>();
    const webSearchResultIds = new Set<string>();
    for (const block of content) {
      if (isServerToolUseBlock(block)) {
        serverToolUseIds.add(block.id);
      }
      if (isWebSearchToolResultBlock(block)) {
        webSearchResultIds.add(block.tool_use_id);
      }
    }

    const orphanServerToolUseIds = new Set<string>();
    for (const id of serverToolUseIds) {
      if (!webSearchResultIds.has(id)) orphanServerToolUseIds.add(id);
    }
    const orphanWebSearchResultIds = new Set<string>();
    for (const id of webSearchResultIds) {
      if (!serverToolUseIds.has(id)) orphanWebSearchResultIds.add(id);
    }

    if (
      orphanServerToolUseIds.size === 0 &&
      orphanWebSearchResultIds.size === 0
    ) {
      return msg;
    }

    if (orphanServerToolUseIds.size > 0) {
      log.warn(
        {
          orphanedIds: Array.from(orphanServerToolUseIds),
          blockCount: content.length,
        },
        "Injecting synthetic web_search_tool_result for orphaned server_tool_use blocks",
      );
    }
    if (orphanWebSearchResultIds.size > 0) {
      log.warn(
        {
          orphanedIds: Array.from(orphanWebSearchResultIds),
          blockCount: content.length,
        },
        "Downgrading orphaned web_search_tool_result blocks to text",
      );
    }

    const repairedContent: Anthropic.ContentBlockParam[] = [];
    for (const block of content) {
      if (
        isWebSearchToolResultBlock(block) &&
        orphanWebSearchResultIds.has(block.tool_use_id)
      ) {
        repairedContent.push({
          type: "text",
          text: formatOrphanedWebSearchResultAsText(block),
        });
        continue;
      }
      repairedContent.push(block);
      if (isServerToolUseBlock(block) && orphanServerToolUseIds.has(block.id)) {
        repairedContent.push({
          type: "web_search_tool_result",
          tool_use_id: block.id,
          content: {
            type: "web_search_tool_result_error",
            error_code: "unavailable",
          },
        } as unknown as Anthropic.ContentBlockParam);
      }
    }

    return { role: msg.role, content: repairedContent };
  });
}

function formatOrphanedWebSearchResultAsText(block: {
  tool_use_id: string;
  content: unknown;
}): string {
  const header = `[Orphaned web_search results (tool_use_id=${block.tool_use_id}):`;
  if (!Array.isArray(block.content)) {
    return `${header} (results unavailable)]`;
  }
  const entries: string[] = [];
  for (const r of block.content) {
    if (
      typeof r !== "object" ||
      r == null ||
      (r as { type?: string }).type !== "web_search_result"
    ) {
      continue;
    }
    const title =
      typeof (r as { title?: unknown }).title === "string"
        ? (r as { title: string }).title
        : "(untitled)";
    const url =
      typeof (r as { url?: unknown }).url === "string"
        ? (r as { url: string }).url
        : "";
    const idx = entries.length + 1;
    entries.push(url ? `${idx}. ${title}\n   ${url}` : `${idx}. ${title}`);
  }
  const body = entries.length > 0 ? entries.join("\n") : "(no results)";
  return `${header}\n${body}]`;
}

/**
 * Last-line-of-defense fix that ensures every assistant message with tool_use
 * blocks has matching tool_result blocks in the immediately following user
 * message.  Runs on the FINAL Anthropic-formatted messages after block
 * conversion, filtering, and empty-message filtering.
 *
 * Builds a fresh result array without mutating the input.
 */
/**
 * Find the start index of the active tool-use continuation span at the tail
 * of the formatted message array. Messages from this index onward may contain
 * thinking blocks that must be preserved for Anthropic's tool-use protocol.
 *
 * The active span is the trailing sequence of alternating
 * assistant(tool_use) → user(tool_result) messages. Everything before it is
 * a completed historical turn whose thinking blocks can be safely stripped.
 *
 * Returns `messages.length` when there is no active tool-use continuation
 * (i.e. all messages are historical — strip thinking from everything).
 */
function findActiveToolUseContinuationStart(
  messages: Anthropic.MessageParam[],
): number {
  // Walk backwards from the end. The tail pattern we're looking for is:
  //   ... assistant(tool_use) user(tool_result) [assistant(tool_use) user(tool_result)]* ...
  // The last message is typically a user message (the new prompt), so if it
  // doesn't contain tool_result blocks, there's no active continuation.
  let i = messages.length - 1;

  while (i >= 0) {
    const msg = messages[i];
    if (msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const hasToolResult = content.some(
        (b) => typeof b !== "string" && isToolResultBlock(b),
      );
      if (!hasToolResult) break;
      // This user message has tool_result — the preceding assistant message
      // should have the matching tool_use and its thinking blocks preserved.
      i--;
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const hasToolUse = content.some(
        (b) => typeof b !== "string" && isToolUseBlock(b),
      );
      if (!hasToolUse) break;
      // This assistant message has tool_use — it's part of the active span.
      // Check if the preceding user message continues the chain.
      i--;
    } else {
      break;
    }
  }

  return i + 1;
}

function ensureToolPairing(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      result.push(msg);
      i++;
      continue;
    }

    const content = Array.isArray(msg.content) ? msg.content : [];

    const { pairedContent, carryoverContent, toolUseIds } =
      splitAssistantForToolPairing(content);

    if (toolUseIds.length === 0) {
      result.push(msg);
      i++;
      continue;
    }

    // Assistant message — push the paired portion (pre-tool text + tool_use blocks)
    result.push({
      role: "assistant" as const,
      content: pairedContent,
    });

    if (carryoverContent.length > 0) {
      log.debug(
        {
          msgIndex: i,
          carryoverBlocks: carryoverContent.length,
          totalToolUse: toolUseIds.length,
        },
        "Split assistant trailing non-tool blocks into post-tool carryover message",
      );
    }

    // There are tool_use blocks — ensure the next message has matching tool_results
    const next = messages[i + 1];
    if (next && next.role === "user") {
      const nextContent = Array.isArray(next.content) ? next.content : [];
      const normalized = normalizeFollowingUserContent(nextContent, toolUseIds);
      if (normalized.missingIds.length > 0) {
        log.warn(
          {
            missingCount: normalized.missingIds.length,
            missingIds: normalized.missingIds,
            totalToolUse: toolUseIds.length,
            msgIndex: i,
          },
          "Injecting synthetic tool_result blocks in Anthropic client",
        );
      }
      if (!normalized.hadOrderedPrefix) {
        log.debug(
          { msgIndex: i, totalToolUse: toolUseIds.length },
          "Reordered user message so tool_result blocks immediately follow assistant tool_use",
        );
      }

      if (carryoverContent.length > 0) {
        // Reconstruct collapsed chronology:
        // assistant(tool_use...) -> user(tool_result...) -> assistant(trailing text) -> user(remaining text)
        result.push({
          role: "user" as const,
          content: normalized.toolResultPrefix,
        });
        result.push({
          role: "assistant" as const,
          content: carryoverContent,
        });
        // Emit a trailing user message when there is remaining content, or when
        // alternation requires it (next message is assistant or end of array).
        // Skip the synthetic placeholder if the next message is already a user
        // turn — it will naturally maintain alternation.
        if (normalized.remainingContent.length > 0) {
          result.push({
            role: "user" as const,
            content: normalized.remainingContent,
          });
        } else {
          const nextAfterPair = messages[i + 2];
          if (!nextAfterPair || nextAfterPair.role !== "user") {
            result.push({
              role: "user" as const,
              content: [
                { type: "text" as const, text: SYNTHETIC_CONTINUATION_TEXT },
              ],
            });
          }
        }
      } else {
        // No carryover assistant text to restore, so preserve existing behavior
        // and keep additional user blocks in the same message.
        result.push({
          role: "user" as const,
          content: [
            ...normalized.toolResultPrefix,
            ...normalized.remainingContent,
          ],
        });
      }
      i += 2; // skip both assistant (already pushed) and original user (replaced)
    } else {
      // No following user message or next is assistant — inject synthetic user
      log.warn(
        {
          toolUseCount: toolUseIds.length,
          toolUseIds,
          msgIndex: i,
          nextRole: next?.role,
        },
        "Injecting synthetic tool_result user message in Anthropic client",
      );
      result.push({
        role: "user" as const,
        content: toolUseIds.map((id) => buildSyntheticToolResult(id)),
      });

      // If the assistant contained collapsed post-tool text, preserve it as a
      // separate assistant message after synthetic tool_result repair.
      if (carryoverContent.length > 0) {
        result.push({
          role: "assistant" as const,
          content: carryoverContent,
        });
      }

      i++; // advance past the assistant; next message (if any) processed next iteration
    }
  }

  // Self-validation: verify no client-side tool_use/tool_result mismatches remain.
  // Server-side tools (server_tool_use / web_search_tool_result) are self-paired
  // within assistant messages and are not validated here.
  for (let j = 0; j < result.length; j++) {
    const m = result[j];
    if (m.role !== "assistant") continue;
    const c = Array.isArray(m.content) ? m.content : [];
    const validationIds = getOrderedToolUseIds(c);
    if (validationIds.length === 0) continue;

    const nxt = result[j + 1];
    const nxtContent =
      nxt && nxt.role === "user" && Array.isArray(nxt.content)
        ? nxt.content
        : [];
    if (!hasOrderedToolResultPrefix(nxtContent, validationIds)) {
      const unmatchedIds = validationIds.filter((id, idx) => {
        const block = nxtContent[idx];
        return !(isToolResultBlock(block) && block.tool_use_id === id);
      });
      log.error(
        {
          unmatchedIds,
          msgIndex: j,
          messageSummary: summarizeMessages(result),
        },
        "ensureToolPairing self-validation FAILED — tool_result prefix mismatch after repair",
      );
    }
  }

  return result;
}

export class AnthropicProvider implements Provider {
  public readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  private useNativeWebSearch: boolean;
  private streamTimeoutMs: number;
  private requestHeaders: Record<string, string>;

  constructor(
    apiKey: string,
    model: string,
    options: {
      useNativeWebSearch?: boolean;
      streamTimeoutMs?: number;
      baseURL?: string;
      /**
       * Authenticate via `Authorization: Bearer <token>` instead of
       * `x-api-key`. Required for proxies that front the Anthropic Messages
       * API with their own Bearer scheme (e.g. OpenRouter). When set, the
       * positional `apiKey` argument is ignored on the wire.
       */
      authToken?: string;
      /** Provider-level request headers merged into every API request. */
      requestHeaders?: Record<string, string>;
    } = {},
  ) {
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
    this.requestHeaders = options.requestHeaders ?? {};
    // Pass the same deadline to the SDK so its per-request timeout can't
    // fire before `createStreamTimeout` does. The SDK's default is 10 min,
    // which truncates any request we intend to run longer than that. We add
    // a 60s buffer so `createStreamTimeout` always wins — its abort reason
    // produces a clearer error message than the SDK's generic timeout.
    const sdkTimeoutMs = this.streamTimeoutMs + 60_000;
    this.client = options.authToken
      ? new Anthropic({
          apiKey: null,
          authToken: options.authToken,
          baseURL: options.baseURL,
          timeout: sdkTimeoutMs,
        })
      : new Anthropic({
          apiKey,
          baseURL: options.baseURL,
          timeout: sdkTimeoutMs,
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
    const cacheTtl: "5m" | "1h" =
      ((config as Record<string, unknown> | undefined)?.cacheTtl as
        | "5m"
        | "1h") ?? "1h";
    // Opt-out for callers (e.g. the memory router) that send a single
    // user message per call with content that changes every time. The
    // turn-start cache breakpoint below is only useful when the same
    // prefix is re-sent on a subsequent call (typical for the main agent
    // loop's tool-use iterations); one-shot callers pay cache_creation
    // cost without a future hit.
    const disableTurnStartCache =
      (config as Record<string, unknown> | undefined)?.disableTurnStartCache ===
      true;
    // When true, the latest user message carries per-turn-volatile content
    // (e.g. an injected memory block), so the long-TTL anchor must skip it and
    // land on the most recent stable user message instead. See the breakpoint
    // block below.
    const mutableLatestUserMessage =
      (config as Record<string, unknown> | undefined)
        ?.mutableLatestUserMessage === true;
    // Full prompt-caching opt-out: send no cache breakpoints at all and strip
    // caller-stamped block-level markers. Resolved per call site (see
    // `disableCache` in the LLM config schema) for one-shot prompts where
    // every breakpoint is a paid cache write with no future read.
    const disableCache =
      (config as Record<string, unknown> | undefined)?.disableCache === true;
    let sentMessages: Anthropic.MessageParam[] | undefined;
    const startedAt = Date.now();
    // Hoisted so the catch block can distinguish our inner stream timeout
    // (30 min default) from an external transport abort (bun fetch deadline,
    // edge LB, NAT idle) — only the latter should be retried.
    let innerTimeoutSignal: AbortSignal | undefined;
    try {
      sentMessages = this.buildSentMessages(messages);
      const {
        effort,
        speed,
        output_config,
        cacheTtl: _cacheTtl,
        disableTurnStartCache: _disableTurnStartCache,
        mutableLatestUserMessage: _mutableLatestUserMessage,
        disableCache: _disableCache,
        max_tokens: callerMaxTokens,
        usageAttributionHeaders,
        // Pulled out of `restConfig` so they are forwarded conditionally below:
        // newer models reject them outright (see `deprecatesSamplingParams`).
        temperature: callerTemperature,
        top_p: callerTopP,
        top_k: callerTopK,
        ...restConfig
      } = (config ?? {}) as Record<string, unknown> & {
        // "xhigh" is an intermediate tier between "high" and "max" supported
        // by newer Anthropic models (e.g. Opus 4.7). The SDK's OutputConfig
        // type doesn't yet include it, so we widen to the internal effort
        // union and cast when building mergedOutputConfig. "none" is a
        // Vellum-wide value meaning "omit the effort param entirely" — we
        // skip the output_config.effort field in that case.
        effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
        speed?: "standard" | "fast";
        output_config?: Record<string, unknown>;
        usageAttributionHeaders?: Record<string, string>;
        temperature?: number;
        top_p?: number;
        top_k?: number;
      };
      // Haiku does not support the effort / output_config parameter or
      // extended cache TTL betas.
      // Determine the effective model (per-call override or provider default)
      // and gate features accordingly.
      const effectiveModel =
        (restConfig as Record<string, unknown>).model?.toString() ?? this.model;
      const isHaiku = effectiveModel.includes("haiku");
      const supportsEffort = !isHaiku;
      // opus-4-7 / opus-4-8 and sonnet-5 reject `temperature`, `top_p`, and
      // `top_k` with a 400 "`temperature`/`top_p` is deprecated for this model"
      // — model-wide, not effort-conditional (verified 2026-06-23). opus-4-6 /
      // sonnet-4-6 / haiku-4-5 still accept them. fable-5 is included
      // conservatively (a frontier model that could not be verified directly
      // but follows the same deprecation direction). Stripping the params here
      // keeps callers that set them (e.g. the memory-v3 L2 selector's
      // `temperature: 0`) from 400ing. OpenRouter `anthropic/...` models
      // delegate to this provider, so the bare-id suffix is what matches.
      const deprecatesSamplingParams =
        /claude-opus-4-[78]\b/.test(effectiveModel) ||
        /claude-sonnet-5\b/.test(effectiveModel) ||
        effectiveModel.startsWith("claude-fable-");
      const mergedOutputConfig = {
        ...(output_config ?? {}),
        ...(effort && effort !== "none" && supportsEffort
          ? { effort: effort as Anthropic.OutputConfig["effort"] }
          : {}),
      };
      // Build cache_control objects: Haiku doesn't support the extended
      // cache TTL beta, so omit the ttl field for Haiku models.
      const cacheControl = isHaiku
        ? { type: "ephemeral" as const }
        : { type: "ephemeral" as const, ttl: cacheTtl };
      const tailCacheControl = isHaiku
        ? { type: "ephemeral" as const }
        : { type: "ephemeral" as const, ttl: "5m" as const };

      let params: Anthropic.MessageStreamParams = {
        model: this.model,
        max_tokens: isHaiku
          ? Math.min(
              typeof callerMaxTokens === "number" ? callerMaxTokens : 8192,
              8192,
            )
          : typeof callerMaxTokens === "number"
            ? callerMaxTokens
            : 64000,
        messages: sentMessages,
        ...restConfig,
        // Forward `temperature` / `top_p` / `top_k` only to models that still
        // accept them; newer models 400 on any of the deprecated sampler params.
        // `temperature: 0` is preserved for accepting models (a `typeof ===
        // "number"` check, not truthiness).
        ...(deprecatesSamplingParams
          ? {}
          : {
              ...(typeof callerTemperature === "number"
                ? { temperature: callerTemperature }
                : {}),
              ...(typeof callerTopP === "number" ? { top_p: callerTopP } : {}),
              ...(typeof callerTopK === "number" ? { top_k: callerTopK } : {}),
            }),
        ...(Object.keys(mergedOutputConfig).length > 0
          ? { output_config: mergedOutputConfig }
          : {}),
      };

      if (systemPrompt) {
        // The system prompt may carry a cache boundary (placed by the
        // section pipeline — see `prompts/sections.ts`) splitting it into
        // a stable-prefix block and a volatile-suffix block, each with
        // its own breakpoint so a volatile-section change doesn't
        // re-create the stable prefix.  A 1-hour cache TTL is used (when
        // supported by the model) so the breakpoints survive turn gaps
        // that exceed the default 5-minute window.
        params.system = systemPrompt
          .split(SYSTEM_PROMPT_CACHE_BOUNDARY)
          .filter((text) => text.length > 0)
          .map((text) => ({
            type: "text" as const,
            text,
            ...(disableCache ? {} : { cache_control: cacheControl }),
          }));
        if (params.system.length === 0) delete params.system;
      }

      // Tools precede the system blocks in the cached prefix, so the first
      // system breakpoint already covers the tool definitions.  When the
      // system prompt is split into two blocks, skip the explicit last-tool
      // breakpoint to stay within Anthropic's 4-breakpoint budget; with a
      // single (or no) system block the tool breakpoint is kept.
      const systemBlockCount = Array.isArray(params.system)
        ? params.system.length
        : 0;
      const applyToolCacheControl = systemBlockCount < 2;

      if (tools && tools.length > 0) {
        if (
          this.useNativeWebSearch &&
          tools.some((t) => t.name === "web_search")
        ) {
          const otherTools = tools.filter((t) => t.name !== "web_search");
          const mappedOther = otherTools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool["input_schema"],
            ...(applyToolCacheControl &&
            !disableCache &&
            i === otherTools.length - 1
              ? { cache_control: cacheControl }
              : {}),
          }));
          const webSearchTool: Anthropic.WebSearchTool20250305 = {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
          };
          params.tools = [...mappedOther, webSearchTool];
        } else {
          params.tools = tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool["input_schema"],
            ...(applyToolCacheControl && !disableCache && i === tools.length - 1
              ? { cache_control: cacheControl }
              : {}),
          }));
        }
      }

      // Manual cache breakpoint on the turn-starting user message.
      // This is the stable anchor for the current turn — everything up to
      // and including it won't change during tool-use iterations, so a long
      // TTL is appropriate. Walk backwards to find the last user message
      // with a real text block (skipping tool_result-only messages and
      // synthetic continuation placeholders injected by ensureToolPairing).
      const msgs = sentMessages;
      const findUserTextMsgIdx = (startIdx: number): number => {
        for (let i = startIdx; i >= 0; i--) {
          const msg = msgs[i];
          if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
          const hasText = msg.content.some(
            (b) =>
              typeof b !== "string" &&
              b.type === "text" &&
              b.text !== SYNTHETIC_CONTINUATION_TEXT,
          );
          if (hasText) return i;
        }
        return -1;
      };
      const applyCacheControlToLastBlock = (msgIdx: number): void => {
        const content = msgs[msgIdx].content;
        if (!Array.isArray(content) || content.length === 0) return;
        const lastBlock = content[content.length - 1];
        if (typeof lastBlock !== "string") {
          (lastBlock as unknown as Record<string, unknown>).cache_control =
            cacheControl;
        }
      };
      const turnStartIdx = findUserTextMsgIdx(msgs.length - 1);
      // When the latest user message is volatile (`mutableLatestUserMessage`)
      // and it is itself the turn-start (first-of-turn, no tool-use loop yet),
      // skip the long-TTL anchor here — it would land on per-turn-varying
      // content and never hit again. The previous-turn anchor below becomes the
      // primary stable breakpoint. During tool-use loops (`turnStartIdx <
      // msgs.length - 1`) the turn-start block is fixed within the turn, so
      // behavior is unchanged. Independent from `disableTurnStartCache`, which
      // expresses a different intent (one-shot callers with no future hit).
      const skipVolatileTurnStartAnchor =
        mutableLatestUserMessage && turnStartIdx === msgs.length - 1;
      if (
        turnStartIdx >= 0 &&
        !disableCache &&
        !disableTurnStartCache &&
        !skipVolatileTurnStartAnchor
      ) {
        applyCacheControlToLastBlock(turnStartIdx);
      }

      // Previous-turn anchor: when this request is the first of a new turn
      // (turn-start is the very last message — no tool-use loop yet), also
      // place a 1h breakpoint on the *previous* turn-starting user message.
      // Anthropic only matches the cache at cache_control points present in
      // the current request, so without this anchor the breakpoint slides
      // forward each new user turn and the prior cached prefix becomes
      // unreachable — forcing a full re-creation of history (200K+
      // cache_creation tokens per new turn). Skipped during tool-use loops
      // where the current turn-start already covers the same prefix and a
      // second anchor would blow the 4-breakpoint budget.
      if (
        !disableCache &&
        turnStartIdx === msgs.length - 1 &&
        turnStartIdx > 0
      ) {
        const prevTurnAnchorIdx = findUserTextMsgIdx(turnStartIdx - 1);
        if (prevTurnAnchorIdx >= 0)
          applyCacheControlToLastBlock(prevTurnAnchorIdx);
      }

      // Advancing tail: place a short-lived 5m cache breakpoint on the last
      // block of the last message. This caches the growing tail cheaply
      // without conflicting with the 1h breakpoints above. It fires during
      // tool-use loops (the tail falls after the turn-starting user message)
      // and also on a first-of-turn request whose volatile turn-start anchor
      // was skipped while a previous-turn anchor exists: there the latest
      // message would otherwise carry no breakpoint, so the next request's
      // anchor can land far ahead of the previous-turn anchor and Anthropic's
      // ~20-block cache lookback can't bridge the gap — forcing a full
      // re-creation of the prefix. The 5m breakpoint gives the next call an
      // exact, reachable boundary; cross-turn it expires harmlessly. The
      // first-of-turn bridge lands on the turn-start block, so it honors
      // `disableTurnStartCache` like the long-TTL anchor above. Skip
      // thinking/redacted_thinking blocks — Anthropic doesn't allow
      // cache_control on those types.
      if (
        !disableCache &&
        turnStartIdx >= 0 &&
        (turnStartIdx < sentMessages.length - 1 ||
          (skipVolatileTurnStartAnchor &&
            turnStartIdx > 0 &&
            !disableTurnStartCache))
      ) {
        const lastMsg = sentMessages[sentMessages.length - 1];
        if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
          const NON_CACHEABLE_TYPES = new Set([
            "thinking",
            "redacted_thinking",
          ]);
          let tailBlock: (typeof lastMsg.content)[number] | undefined;
          for (let j = lastMsg.content.length - 1; j >= 0; j--) {
            const block = lastMsg.content[j];
            if (
              typeof block !== "string" &&
              !NON_CACHEABLE_TYPES.has((block as { type: string }).type)
            ) {
              tailBlock = block;
              break;
            }
          }
          if (tailBlock && typeof tailBlock !== "string") {
            (tailBlock as unknown as Record<string, unknown>).cache_control =
              tailCacheControl;
          }
        }
      }

      // Cache-breakpoint accounting: system(≤2) + tools(1, only when the
      // system is a single block or absent) + at most two message anchors
      // ≤ 4 — Anthropic's per-request cap. The two message anchors are
      // turn-start + prev-turn-anchor (first-of-turn), turn-start + tail
      // (tool-use loop), or prev-turn-anchor + tail (first-of-turn with the
      // volatile turn-start anchor skipped — the freed turn-start slot covers
      // the tail). At most two message-level breakpoints are placed, so the
      // total can't drift past 4.

      // Strip orphaned UTF-16 surrogates so the Anthropic JSON parser never
      // sees invalid strings produced by upstream surrogate-splitting `.slice()` calls.
      const sanitized = stripOrphanedSurrogatesDeep(params);
      if (sanitized.changed) {
        logOrphanedSurrogateWarning(sanitized.fixedStringCount, sentMessages);
        params = sanitized.value;
        sentMessages = params.messages;
      }

      // Callers can stamp `cache_control` on message blocks before the
      // provider sees them. Two repairs apply:
      // - `disableCache`: strip the marker entirely — this call opted out of
      //   prompt caching, and a leftover block-level marker would still incur
      //   a cache write.
      // - Haiku: strip only the `ttl` field — Haiku does not support the
      //   extended-cache-ttl beta, so a `ttl` would make the request invalid.
      //   The client's own breakpoints already omit it for Haiku.
      if (disableCache || isHaiku) {
        for (const msg of sentMessages) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (typeof block === "string") continue;
            const blockRecord = block as {
              cache_control?: { ttl?: unknown };
            };
            if (!blockRecord.cache_control) continue;
            if (disableCache) {
              delete blockRecord.cache_control;
            } else if ("ttl" in blockRecord.cache_control) {
              delete blockRecord.cache_control.ttl;
            }
          }
        }
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);
      innerTimeoutSignal = timeoutSignal;

      /** Minimal stream interface shared by MessageStream and BetaMessageStream. */
      interface UnifiedStream {
        on(event: "text", listener: (text: string) => void): this;
        on(event: "thinking", listener: (thinking: string) => void): this;
        on(
          event: "streamEvent",
          listener: (event: Anthropic.MessageStreamEvent) => void,
        ): this;
        on(event: "inputJson", listener: (partialJson: string) => void): this;
        finalMessage(): Promise<Anthropic.Message>;
      }

      // Fast mode: use the beta endpoint with speed: "fast" for Opus models (4.6, 4.7).
      const useFastMode = speed === "fast" && effectiveModel.includes("opus");

      // Collect request betas that are still explicit transport features.
      // Current long-context Anthropic models expose their larger windows by
      // model capability in the catalog/resolver, not by this generic header.
      const betas: string[] = isHaiku ? [] : ["extended-cache-ttl-2025-04-11"];
      if (useFastMode) {
        betas.push("fast-mode-2026-02-01");
      }

      let response: Anthropic.Message;
      try {
        const requestHeaders = {
          ...this.requestHeaders,
          ...(usageAttributionHeaders ?? {}),
        };
        const requestOptions = {
          signal: timeoutSignal,
          ...(Object.keys(requestHeaders).length > 0
            ? { headers: requestHeaders }
            : {}),
        };
        const stream: UnifiedStream = useFastMode
          ? (this.client.beta.messages.stream(
              {
                ...(params as Record<string, unknown>),
                speed: "fast" as const,
                betas,
              } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming &
                Anthropic.Beta.Messages.MessageCreateParamsStreaming,
              requestOptions,
            ) as unknown as UnifiedStream)
          : betas.length > 0
            ? (this.client.beta.messages.stream(
                {
                  ...(params as Record<string, unknown>),
                  betas,
                } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming &
                  Anthropic.Beta.Messages.MessageCreateParamsStreaming,
                requestOptions,
              ) as unknown as UnifiedStream)
            : (this.client.messages.stream(
                params,
                requestOptions,
              ) as unknown as UnifiedStream);

        // Buffer streaming text until it's clear the accumulated text isn't
        // going to form a placeholder sentinel. Sentinels are injected into
        // outbound requests for role alternation and are sometimes echoed by
        // the model — including an echo whose `\x00` guard arrived as a leading
        // space — so the prefix and completion checks normalize edge whitespace
        // and control bytes (the same normalization cleanAssistantContent and
        // the display serializer use). Holding back partial prefixes keeps them
        // off the live UI before they are stripped at completion. The buffer
        // resets on every content_block_start.
        let textBuffer = "";

        stream.on("text", (text) => {
          textBuffer += text;
          if (couldBePlaceholderSentinelPrefix(textBuffer)) return;
          onEvent?.({ type: "text_delta", text: textBuffer });
          textBuffer = "";
        });

        stream.on("thinking", (thinking) => {
          onEvent?.({ type: "thinking_delta", thinking });
        });

        // Track which tool is currently streaming so we can attribute inputJson deltas.
        let currentStreamingToolName: string | undefined;
        let currentStreamingToolUseId: string | undefined;
        let accumulatedInputJson = "";
        let lastInputJsonEmitMs = 0;
        let pendingInputJsonFlush: ReturnType<typeof setTimeout> | undefined;

        // Anthropic streams `server_tool_use` block input via `input_json_delta`
        // events (the block's own `input` field is `{}` at content_block_start).
        // We accumulate the JSON separately from regular `tool_use` blocks so
        // the daemon can read the resolved query when the paired
        // `web_search_tool_result` arrives — without this, downstream activity
        // metadata sees an empty query.
        let currentServerToolUseId: string | undefined;
        let accumulatedServerToolInputJson = "";
        const resolvedServerToolInputs = new Map<
          string,
          Record<string, unknown>
        >();

        stream.on("streamEvent", (event) => {
          // Reset the text sentinel buffer at each content-block boundary.
          // A new block starts fresh; at the end of a block, flush any
          // buffered text that is NOT a complete sentinel, and drop it if
          // it is one.
          if (event.type === "content_block_start") {
            textBuffer = "";
          }
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            currentStreamingToolName = event.content_block.name;
            currentStreamingToolUseId = event.content_block.id;
            accumulatedInputJson = "";
            lastInputJsonEmitMs = 0;
            onEvent?.({
              type: "tool_use_preview_start",
              toolUseId: event.content_block.id,
              toolName: event.content_block.name,
            });
          }
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "server_tool_use"
          ) {
            currentServerToolUseId = event.content_block.id;
            accumulatedServerToolInputJson = "";
            onEvent?.({
              type: "server_tool_start",
              name: event.content_block.name,
              toolUseId: event.content_block.id,
              input:
                (event.content_block as { input?: Record<string, unknown> })
                  .input ?? {},
            });
          }
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "web_search_tool_result"
          ) {
            const block = event.content_block as {
              tool_use_id: string;
              content?:
                | { type: "web_search_tool_result_error"; error_code?: string }
                | unknown[];
            };
            const isError =
              !Array.isArray(block.content) &&
              block.content?.type === "web_search_tool_result_error";
            const errorCode =
              isError && !Array.isArray(block.content)
                ? block.content?.error_code
                : undefined;
            const resolvedInput = resolvedServerToolInputs.get(
              block.tool_use_id,
            );
            resolvedServerToolInputs.delete(block.tool_use_id);
            onEvent?.({
              type: "server_tool_complete",
              toolUseId: block.tool_use_id,
              isError: !!isError,
              ...(Array.isArray(block.content)
                ? { content: block.content }
                : {}),
              ...(resolvedInput ? { resolvedInput } : {}),
              ...(errorCode ? { errorCode } : {}),
            });
          }
          if (event.type === "content_block_stop") {
            if (pendingInputJsonFlush) {
              clearTimeout(pendingInputJsonFlush);
              pendingInputJsonFlush = undefined;
            }
            if (currentStreamingToolName && accumulatedInputJson) {
              onEvent?.({
                type: "input_json_delta",
                toolName: currentStreamingToolName,
                toolUseId: currentStreamingToolUseId!,
                accumulatedJson: accumulatedInputJson,
              });
            }
            currentStreamingToolName = undefined;
            currentStreamingToolUseId = undefined;
            accumulatedInputJson = "";
            // Finalize the resolved input for a `server_tool_use` block (e.g.
            // the actual web-search query) so the paired `web_search_tool_result`
            // emits `server_tool_complete` with `resolvedInput` populated.
            if (currentServerToolUseId && accumulatedServerToolInputJson) {
              try {
                const parsed = JSON.parse(accumulatedServerToolInputJson);
                if (parsed && typeof parsed === "object") {
                  resolvedServerToolInputs.set(
                    currentServerToolUseId,
                    parsed as Record<string, unknown>,
                  );
                }
              } catch {
                // Malformed partial JSON — drop silently; downstream falls
                // back to whatever was captured at server_tool_start.
              }
            }
            currentServerToolUseId = undefined;
            accumulatedServerToolInputJson = "";
            // Flush residual text buffer unless it is a sentinel.
            if (
              textBuffer.length > 0 &&
              !isPlaceholderSentinelText(textBuffer)
            ) {
              onEvent?.({ type: "text_delta", text: textBuffer });
            }
            textBuffer = "";
          }
        });

        stream.on("inputJson", (partialJson) => {
          if (currentServerToolUseId) {
            // Server-tool input (e.g. `web_search` query) — accumulate without
            // emitting `input_json_delta`; the daemon only consumes the
            // finalized value from `server_tool_complete.resolvedInput`.
            accumulatedServerToolInputJson += partialJson;
            return;
          }
          if (!currentStreamingToolName) return;
          accumulatedInputJson += partialJson;
          const now = Date.now();
          if (now - lastInputJsonEmitMs >= 150) {
            lastInputJsonEmitMs = now;
            if (pendingInputJsonFlush) {
              clearTimeout(pendingInputJsonFlush);
              pendingInputJsonFlush = undefined;
            }
            onEvent?.({
              type: "input_json_delta",
              toolName: currentStreamingToolName,
              toolUseId: currentStreamingToolUseId!,
              accumulatedJson: accumulatedInputJson,
            });
          } else if (!pendingInputJsonFlush) {
            const toolName = currentStreamingToolName;
            const toolUseId = currentStreamingToolUseId!;
            pendingInputJsonFlush = setTimeout(() => {
              pendingInputJsonFlush = undefined;
              lastInputJsonEmitMs = Date.now();
              if (currentStreamingToolName === toolName) {
                onEvent?.({
                  type: "input_json_delta",
                  toolName,
                  toolUseId,
                  accumulatedJson: accumulatedInputJson,
                });
              }
            }, 150);
          }
        });

        response = await stream.finalMessage();
      } finally {
        cleanupTimeout();
      }

      return {
        content: response.content.map((block) =>
          this.fromAnthropicBlock(block),
        ),
        model: response.model,
        usage: {
          inputTokens:
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
          cacheCreationInputTokens:
            response.usage.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens:
            response.usage.cache_read_input_tokens ?? undefined,
        },
        stopReason: response.stop_reason ?? "unknown",
        rawRequest: params,
        rawResponse: response,
      };
    } catch (error) {
      // Propagate a tagged AbortReason (set by the daemon at controller.abort())
      // so wrapped errors can be classified as user cancellation downstream.
      const callerAborted = signal?.aborted === true;
      const abortReason =
        callerAborted && isAbortReason(signal!.reason)
          ? signal!.reason
          : undefined;
      const elapsedMs = Date.now() - startedAt;
      // Inner-timeout means OUR 30-min stream deadline fired, not the caller
      // and not an external transport cutoff. We rewrite the message so the
      // retry layer can distinguish it from a transport abort (which should
      // retry) — a timed-out stream would almost certainly time out again.
      const innerTimeoutFired =
        innerTimeoutSignal?.aborted === true && !callerAborted;
      if (error instanceof Anthropic.APIError) {
        // Log detailed message structure for tool_use/tool_result ordering errors
        if (
          error.status === 400 &&
          /tool_use.*tool_result|tool_result.*tool_use/i.test(error.message) &&
          sentMessages
        ) {
          log.error(
            {
              messageSummary: summarizeMessages(sentMessages),
              messageCount: sentMessages.length,
            },
            "Anthropic 400: tool_use/tool_result pairing error — dumping message structure",
          );
        }
        const isAbortMessage =
          error.status === undefined &&
          /request was aborted/i.test(error.message);
        if (abortReason) {
          log.info(
            { abortReason, elapsedMs, message: error.message },
            "Anthropic request aborted by daemon",
          );
        } else if (isAbortMessage) {
          log.error(
            {
              elapsedMs,
              cause: error.cause,
              callerSignalAborted: callerAborted,
              innerTimeoutFired,
              message: error.message,
            },
            innerTimeoutFired
              ? "Anthropic stream timed out (inner streamTimeoutMs fired)"
              : "Anthropic stream aborted by transport — no daemon or inner-timeout abort; likely bun fetch deadline, edge LB, or network idle cutoff",
          );
        } else {
          log.error(
            {
              status: error.status,
              elapsedMs,
              message: error.message,
              headers: Object.fromEntries(error.headers?.entries() ?? []),
            },
            `Anthropic API error (${error.status})`,
          );
        }
        const overflow = detectAnthropicContextOverflow(error);
        if (overflow) {
          throw new ContextOverflowError(
            `Anthropic API error (${error.status}): ${error.message}`,
            "anthropic",
            {
              actualTokens: overflow.actualTokens,
              maxTokens: overflow.maxTokens,
              statusCode: error.status,
              cause: error,
            },
          );
        }
        const retryAfterMs = extractRetryAfterMs(error.headers);
        const errorOptions: {
          retryAfterMs?: number;
          abortReason?: unknown;
          cause?: unknown;
        } = {};
        if (retryAfterMs !== undefined)
          errorOptions.retryAfterMs = retryAfterMs;
        if (abortReason) errorOptions.abortReason = abortReason;
        // Only preserve the original error as `cause` for transport aborts
        // without a daemon-tagged reason — it's the diagnostic signal the
        // retry layer and log reader rely on. Don't leak it through the
        // caller-aborted path, which already carries `abortReason`.
        if (!abortReason && isAbortMessage) errorOptions.cause = error;
        // Rewrite the message only for inner-timeout, so the retry layer
        // won't retry a request that already hit its 30-min deadline.
        const rewrittenMessage =
          isAbortMessage && innerTimeoutFired
            ? `Anthropic stream timed out after ${Math.round(elapsedMs / 1000)}s (inner streamTimeoutMs)`
            : error.message;
        // Only include the `(status)` parenthetical when the SDK surfaced a
        // real HTTP status. Abort paths and mid-stream protocol errors have
        // `error.status === undefined`, and string-interpolating that produces
        // a confusing "Anthropic API error (undefined): …" message.
        const statusPart =
          error.status !== undefined ? ` (${error.status})` : "";
        throw new ProviderError(
          `Anthropic API error${statusPart}: ${rewrittenMessage}`,
          "anthropic",
          error.status,
          Object.keys(errorOptions).length > 0 ? errorOptions : undefined,
        );
      }
      throw new ProviderError(
        `Anthropic request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "anthropic",
        undefined,
        abortReason ? { cause: error, abortReason } : { cause: error },
      );
    }
  }

  /**
   * Exact prompt-token count via Anthropic's `/v1/messages/count_tokens`
   * endpoint — the real tokenizer, no inference. Serializes `messages` /
   * `systemPrompt` / `tools` the same way {@link sendMessage} does (so the
   * count tracks what the next call would actually send), minus the
   * `cache_control` breakpoints, which don't affect token counts.
   *
   * The serialization here is intentionally simpler than `sendMessage`'s
   * (no role-alternation merge / placeholder injection): on a pathological
   * history `count_tokens` may reject the request, which surfaces as a thrown
   * error the caller turns into a local-estimator fallback. The common path —
   * a well-formed history — counts exactly.
   */
  async countInputTokens(
    messages: Message[],
    systemPrompt: string,
    tools?: ToolDefinition[],
  ): Promise<number> {
    const sentMessages = this.buildSentMessages(messages);

    const system = systemPrompt
      ? systemPrompt
          .split(SYSTEM_PROMPT_CACHE_BOUNDARY)
          .filter((text) => text.length > 0)
          .map((text) => ({ type: "text" as const, text }))
      : [];
    const toolsParam =
      tools && tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool["input_schema"],
          }))
        : undefined;

    const res = await this.client.messages.countTokens({
      model: this.model,
      messages: sentMessages,
      ...(system.length > 0 ? { system } : {}),
      ...(toolsParam ? { tools: toolsParam } : {}),
    });
    return res.input_tokens;
  }

  /**
   * Serialize internal `Message[]` into the Anthropic `MessageParam[]` the
   * Messages API expects: drop unknown/empty blocks, preserve role
   * alternation (placeholder injection + same-role merge), strip stale
   * thinking blocks outside the active tool-use continuation, and repair
   * tool_use/tool_result pairing. Shared by {@link sendMessage} and
   * {@link countInputTokens} so both send the identical message payload —
   * `cache_control` breakpoints (which don't affect token counts) are the
   * only thing layered on top in `sendMessage`.
   */
  private buildSentMessages(messages: Message[]): Anthropic.MessageParam[] {
    // Resolve persisted attachment references to inline base64 before walking
    // the content blocks; live turns already carry base64 and pass through.
    const formatted = resolveMediaReferences(messages)
      .map((m) => {
        // Track whether an unknown block was dropped during filtering
        let droppedUnknownBlock = false;

        const content = m.content
          .map((block) => {
            const result = this.toAnthropicBlockSafe(block);
            if (result == null) {
              droppedUnknownBlock = true;
            }
            return result;
          })
          .filter(
            (block): block is Anthropic.ContentBlockParam => block != null,
          )
          .filter(
            (block) =>
              !(
                block.type === "text" &&
                !(block as { text?: string }).text?.trim()
              ),
          );

        // Preserve assistant turns that would otherwise become empty after filtering
        // unknown block types (e.g. ui_surface). Dropping these messages can violate
        // Anthropic's role alternation requirement.
        if (
          content.length === 0 &&
          m.role === "assistant" &&
          droppedUnknownBlock
        ) {
          return {
            role: m.role as "assistant",
            content: [
              { type: "text" as const, text: PLACEHOLDER_BLOCKS_OMITTED },
            ],
          };
        }

        return {
          role: m.role,
          content,
        } as Anthropic.MessageParam;
      })
      .reduce<Anthropic.MessageParam[]>((acc, m) => {
        if (m.content.length > 0) {
          acc.push(m);
          return acc;
        }
        // Dropping an empty assistant message between two user messages (or vice
        // versa) would create consecutive same-role messages, violating
        // Anthropic's role alternation requirement. Inject a placeholder instead.
        const prev = acc[acc.length - 1];
        if (m.role === "assistant" && prev && prev.role !== "assistant") {
          acc.push({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: PLACEHOLDER_EMPTY_TURN }],
          });
        }
        return acc;
      }, []);

    // Post-processing: merge consecutive same-role messages that violate
    // Anthropic's strict user/assistant alternation requirement. These can
    // arise from:
    //   - Dropping empty messages in the reduce above (placeholder-adjacent)
    //   - History reconstruction artifacts that bypass repairHistory
    //
    // Walk backwards so splice indices stay valid. After a merge+splice
    // the element that was at i+1 shifts to i, potentially creating a
    // new adjacent pair — bump i back up to recheck that position.
    {
      let i = formatted.length - 1;
      while (i > 0 && i < formatted.length) {
        if (formatted[i].role !== formatted[i - 1].role) {
          i--;
          continue;
        }

        const iContent = (
          Array.isArray(formatted[i].content) ? formatted[i].content : []
        ) as Anthropic.ContentBlockParam[];
        const prevContent = (
          Array.isArray(formatted[i - 1].content)
            ? formatted[i - 1].content
            : []
        ) as Anthropic.ContentBlockParam[];
        const isPlaceholder = (c: Anthropic.ContentBlockParam[]): boolean => {
          if (
            c.length !== 1 ||
            typeof c[0] === "string" ||
            c[0].type !== "text"
          )
            return false;
          const text = (c[0] as { text?: string }).text;
          return typeof text === "string" && isPlaceholderSentinelText(text);
        };

        if (isPlaceholder(iContent)) {
          formatted.splice(i, 1);
          // Removed the later element. The new formatted[i] (formerly
          // i+1) may now be same-role as i-1, so decrement once to
          // recheck from the correct position.
          i--;
        } else if (isPlaceholder(prevContent)) {
          formatted.splice(i - 1, 1);
          // Removed the earlier element — everything shifted down by 1.
          // The element that was at i is now at i-1. Decrement so the
          // next iteration compares the new i-1 with i-2 (or exits if
          // i-1 is 0).
          i--;
        } else {
          // Neither is a placeholder — merge content blocks into the
          // earlier message and remove the later one. Skip the merge
          // when either message carries tool_use or tool_result blocks;
          // those require structural alternation for ensureToolPairing
          // to inject the correct synthetic results downstream.
          const hasToolBlock = (c: Anthropic.ContentBlockParam[]): boolean =>
            c.some(
              (b) =>
                typeof b !== "string" &&
                (b.type === "tool_use" || b.type === "tool_result"),
            );
          if (!hasToolBlock(prevContent) && !hasToolBlock(iContent)) {
            formatted[i - 1] = {
              ...formatted[i - 1],
              content: [...prevContent, ...iContent],
            };
            formatted.splice(i, 1);
            // Clamp i to the new last index — the splice may have put
            // us past the end. If there's a new element at i (formerly
            // i+1), it will be rechecked against the merged i-1.
            if (i >= formatted.length) {
              i = formatted.length - 1;
            }
          } else {
            // Can't merge (tool blocks present) — leave for
            // ensureToolPairing which handles tool_use/tool_result
            // alternation in its own forward walk.
            i--;
          }
        }
      }
    }

    // Strip thinking/redacted_thinking blocks from completed historical
    // assistant turns. Anthropic only requires these blocks for active
    // tool-use continuation (the tail span where assistant tool_use is
    // followed by user tool_result). Replaying stale thinking blocks from
    // earlier turns causes 400 errors when the signature is no longer
    // valid (e.g. after a provider/model/profile switch).
    const activeToolUseStart = findActiveToolUseContinuationStart(formatted);
    for (let i = 0; i < activeToolUseStart; i++) {
      const msg = formatted[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const stripped = (msg.content as Anthropic.ContentBlockParam[]).filter(
        (b) =>
          typeof b === "string" ||
          (b.type !== "thinking" && b.type !== "redacted_thinking"),
      );
      if (stripped.length === 0) {
        stripped.push({
          type: "text" as const,
          text: PLACEHOLDER_BLOCKS_OMITTED,
        });
      }
      formatted[i] = { ...msg, content: stripped };
    }

    return ensureToolPairing(repairOrphanedServerToolBlocks(formatted));
  }

  /**
   * Convert a content block to Anthropic format, returning null for unknown
   * block types instead of throwing.  Unknown types (e.g. ui_surface stored
   * in DB) are silently dropped so they don't prevent the request from being
   * sent or break tool_use/tool_result pairing.
   */
  private toAnthropicBlockSafe(
    block: ContentBlock,
  ): Anthropic.ContentBlockParam | null {
    switch (block.type) {
      case "text": {
        // Preserve a caller-stamped cache_control breakpoint (a stable prefix
        // block a caller marks so it is cached on its own rather than only as
        // part of the per-turn anchor prefix). The internal ContentBlock type
        // omits the field, so reach for it via cast. The Haiku ttl-strip
        // downstream still applies. Callers that stamp this keep within the
        // per-request breakpoint budget (≤4), so other callers are unaffected.
        const cacheControl = (
          block as { cache_control?: Anthropic.CacheControlEphemeral }
        ).cache_control;
        return cacheControl
          ? { type: "text", text: block.text, cache_control: cacheControl }
          : { type: "text", text: block.text };
      }
      case "thinking":
        if (!block.signature) {
          return null;
        }
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      case "image": {
        const imageSource = base64Source(block.source);
        if (!ANTHROPIC_SUPPORTED_IMAGE_TYPES.has(imageSource.media_type)) {
          log.warn(
            `Unsupported image MIME type for Anthropic: ${imageSource.media_type}; replacing with text placeholder`,
          );
          return {
            type: "text",
            text: `[Image: ${imageSource.media_type} — format not supported by this provider]`,
          };
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type:
              imageSource.media_type as Anthropic.Base64ImageSource["media_type"],
            data: imageSource.data,
          },
        };
      }
      case "file": {
        const { media_type, data, filename } = base64Source(block.source);
        if (media_type === "application/pdf") {
          // Only valid base64 document source for Anthropic
          return {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data },
            ...(filename ? { title: filename } : {}),
          } as unknown as Anthropic.ContentBlockParam;
        }
        if (isTextBasedMimeType(media_type)) {
          // Decode base64 to UTF-8 text and send as PlainTextSource
          const decodedText = Buffer.from(data, "base64").toString("utf-8");
          return {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: decodedText,
            },
            ...(filename ? { title: filename } : {}),
          } as unknown as Anthropic.ContentBlockParam;
        }
        // Binary non-text file: use extracted_text if available, otherwise a placeholder
        log.warn(
          `Binary file type not natively supported by Anthropic: ${media_type}; falling back to text`,
        );
        const fallbackText = block.extracted_text?.trim()
          ? block.extracted_text
          : `[File: ${filename ?? "unknown"} (${media_type}) — binary file]`;
        return { type: "text", text: fallbackText };
      }
      case "tool_use":
        return {
          type: "tool_use",
          id: sanitizeToolId(block.id),
          name: block.name,
          input: block.input,
        };
      case "tool_result": {
        const toolUseId = sanitizeToolId(block.tool_use_id);
        // Anthropic API: when is_error is true, all content must be type "text".
        // Filter out non-text blocks (e.g. images) for error results.
        const usableBlocks = block.is_error
          ? block.contentBlocks?.filter((cb) => cb.type === "text")
          : block.contentBlocks;
        if (usableBlocks && usableBlocks.length > 0) {
          // Build rich content array: text + images for Anthropic's native multi-part tool results
          const parts: Anthropic.ToolResultBlockParam["content"] = [
            { type: "text" as const, text: block.content },
          ];
          for (const cb of usableBlocks) {
            if (cb.type === "image") {
              const cbSource = base64Source(cb.source);
              parts.push({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type:
                    cbSource.media_type as Anthropic.Base64ImageSource["media_type"],
                  data: cbSource.data,
                },
              });
            } else if (cb.type === "text") {
              parts.push({ type: "text" as const, text: cb.text });
            }
          }
          return {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: parts,
            is_error: block.is_error,
          };
        }
        return {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: block.content,
          is_error: block.is_error,
        };
      }
      case "server_tool_use":
        return {
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        } as unknown as Anthropic.ContentBlockParam;
      case "web_search_tool_result":
        return {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
        } as unknown as Anthropic.ContentBlockParam;
      default: {
        log.warn(
          { blockType: (block as { type: string }).type },
          "Dropping unknown content block type",
        );
        return null;
      }
    }
  }

  private fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock {
    switch (block.type) {
      case "text":
        return { type: "text", text: (block as Anthropic.TextBlock).text };
      case "thinking":
        return {
          type: "thinking",
          thinking: (block as Anthropic.ThinkingBlock).thinking,
          signature: (block as Anthropic.ThinkingBlock).signature,
        };
      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          data: (block as Anthropic.RedactedThinkingBlock).data,
        };
      case "tool_use": {
        const tu = block as Anthropic.ToolUseBlock;
        return {
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        };
      }
      case "server_tool_use": {
        const stu = block as Anthropic.ServerToolUseBlock;
        return {
          type: "server_tool_use",
          id: stu.id,
          name: stu.name,
          input: stu.input as Record<string, unknown>,
        };
      }
      case "web_search_tool_result": {
        const wsr = block as Anthropic.WebSearchToolResultBlock;
        return {
          type: "web_search_tool_result",
          tool_use_id: wsr.tool_use_id,
          content: wsr.content,
        };
      }
      default:
        return {
          type: "text",
          text: `[unsupported block type: ${(block as { type: string }).type}]`,
        };
    }
  }
}
