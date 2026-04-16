import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/system-prompt.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { stripOrphanedSurrogatesDeep } from "../../util/unicode.js";
import { createStreamTimeout } from "../stream-timeout.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";

const log = getLogger("anthropic-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

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

// Null-byte prefix makes these placeholders impossible to produce via normal
// model output or user input, preventing false positives in isPlaceholder().
export const PLACEHOLDER_EMPTY_TURN =
  "\x00__PLACEHOLDER__[empty assistant turn]";
export const PLACEHOLDER_BLOCKS_OMITTED =
  "\x00__PLACEHOLDER__[internal blocks omitted]";

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
function isWebSearchToolResultBlock(
  block: unknown,
): block is { type: "web_search_tool_result"; tool_use_id: string } {
  return (
    typeof block === "object" &&
    block != null &&
    (block as { type: string }).type === "web_search_tool_result"
  );
}

/**
 * Repair orphaned server_tool_use blocks within assistant messages.
 * Server-side tools (e.g. web_search) are self-paired: the assistant message
 * should contain both server_tool_use and its matching web_search_tool_result.
 * When the stream is interrupted or the API returns a partial response, the
 * web_search_tool_result may be missing. This function injects a synthetic
 * error result for any orphaned server_tool_use block.
 */
function repairOrphanedServerToolUse(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const content = Array.isArray(msg.content) ? msg.content : [];

    // Collect server_tool_use IDs and web_search_tool_result IDs in this message
    const serverToolUseIds = new Set<string>();
    const pairedResultIds = new Set<string>();
    for (const block of content) {
      if (isServerToolUseBlock(block)) {
        serverToolUseIds.add(block.id);
      }
      if (isWebSearchToolResultBlock(block)) {
        pairedResultIds.add(block.tool_use_id);
      }
    }

    // Find orphaned server_tool_use blocks (no matching web_search_tool_result)
    const orphanedIds: string[] = [];
    for (const id of serverToolUseIds) {
      if (!pairedResultIds.has(id)) {
        orphanedIds.push(id);
      }
    }

    if (orphanedIds.length === 0) return msg;

    log.warn(
      { orphanedIds, blockCount: content.length },
      "Injecting synthetic web_search_tool_result for orphaned server_tool_use blocks",
    );

    // Insert a synthetic error web_search_tool_result after each orphaned server_tool_use
    const repairedContent: Anthropic.ContentBlockParam[] = [];
    for (const block of content) {
      repairedContent.push(block);
      if (isServerToolUseBlock(block) && orphanedIds.includes(block.id)) {
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

/**
 * Last-line-of-defense fix that ensures every assistant message with tool_use
 * blocks has matching tool_result blocks in the immediately following user
 * message.  Runs on the FINAL Anthropic-formatted messages after block
 * conversion, filtering, and empty-message filtering.
 *
 * Builds a fresh result array without mutating the input.
 */
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
    } = {},
  ) {
    this.client = options.authToken
      ? new Anthropic({
          apiKey: null,
          authToken: options.authToken,
          baseURL: options.baseURL,
        })
      : new Anthropic({ apiKey, baseURL: options.baseURL });
    this.model = model;
    this.useNativeWebSearch = options.useNativeWebSearch ?? false;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { config, onEvent, signal } = options ?? {};
    const cacheTtl: "5m" | "1h" =
      ((config as Record<string, unknown> | undefined)?.cacheTtl as
        | "5m"
        | "1h") ?? "1h";
    let sentMessages: Anthropic.MessageParam[] | undefined;
    try {
      const formatted = messages
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
              content: [
                { type: "text" as const, text: PLACEHOLDER_EMPTY_TURN },
              ],
            });
          }
          return acc;
        }, []);

      // Post-processing: fix consecutive same-role messages that can arise when
      // dropping empty messages (e.g. empty assistant followed by empty user).
      // Remove placeholder assistant messages that ended up adjacent to another
      // assistant message, since the placeholder is no longer needed.
      for (let i = formatted.length - 1; i > 0; i--) {
        if (formatted[i].role !== formatted[i - 1].role) continue;
        // For consecutive assistant messages, remove whichever one is a
        // placeholder injected by the reduce above.
        if (formatted[i].role === "assistant") {
          const iContent = Array.isArray(formatted[i].content)
            ? formatted[i].content
            : [];
          const prevContent = Array.isArray(formatted[i - 1].content)
            ? formatted[i - 1].content
            : [];
          const isPlaceholder = (c: typeof iContent) => {
            if (
              c.length !== 1 ||
              typeof c[0] === "string" ||
              c[0].type !== "text"
            )
              return false;
            const text = (c[0] as { text?: string }).text;
            return (
              text === PLACEHOLDER_EMPTY_TURN ||
              text === PLACEHOLDER_BLOCKS_OMITTED
            );
          };
          if (isPlaceholder(iContent)) {
            formatted.splice(i, 1);
          } else if (isPlaceholder(prevContent)) {
            formatted.splice(i - 1, 1);
          }
        }
      }

      // Thinking blocks are stripped at rest by DB migration 209 so
      // historical messages are clean when loaded. Within a turn,
      // assistant messages have original thinking with valid signatures
      // — the API accepts them. No provider-side stripping needed.

      sentMessages = ensureToolPairing(repairOrphanedServerToolUse(formatted));
      const {
        effort,
        speed,
        output_config,
        cacheTtl: _cacheTtl,
        max_tokens: callerMaxTokens,
        ...restConfig
      } = (config ?? {}) as Record<string, unknown> & {
        // "xhigh" is an intermediate tier between "high" and "max" supported
        // by newer Anthropic models (e.g. Opus 4.7). The SDK's OutputConfig
        // type doesn't yet include it, so we widen to the internal effort
        // union and cast when building mergedOutputConfig.
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
        speed?: "standard" | "fast";
        output_config?: Record<string, unknown>;
      };
      // Haiku does not support the effort / output_config parameter,
      // extended cache TTL betas, 1M context, or 64K output tokens.
      // Determine the effective model (per-call override or provider default)
      // and gate features accordingly.
      const effectiveModel =
        (restConfig as Record<string, unknown>).model?.toString() ?? this.model;
      const isHaiku = effectiveModel.includes("haiku");
      const supportsEffort = !isHaiku;
      const mergedOutputConfig = {
        ...(output_config ?? {}),
        ...(effort && supportsEffort
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
        ...(Object.keys(mergedOutputConfig).length > 0
          ? { output_config: mergedOutputConfig }
          : {}),
      };

      if (systemPrompt) {
        const boundaryIdx = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        if (boundaryIdx >= 0) {
          // Split into two cache blocks: static instructions (stable across
          // turns) and dynamic workspace content (changes when files are
          // edited).  The static prefix stays cached even when workspace
          // files change, saving ~8-10K tokens of cache creation per turn.
          // Both blocks use 1-hour cache TTL to avoid repeated cache misses
          // for conversations with turn gaps exceeding the default 5-minute
          // window.
          const staticBlock = systemPrompt.slice(0, boundaryIdx);
          const dynamicBlock = systemPrompt.slice(
            boundaryIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length,
          );
          params.system = [
            {
              type: "text" as const,
              text: staticBlock,
              cache_control: cacheControl,
            },
            {
              type: "text" as const,
              text: dynamicBlock,
              cache_control: cacheControl,
            },
          ];
        } else {
          params.system = [
            {
              type: "text" as const,
              text: systemPrompt,
              cache_control: cacheControl,
            },
          ];
        }
      }

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
            ...(i === otherTools.length - 1
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
            ...(i === tools.length - 1 ? { cache_control: cacheControl } : {}),
          }));
        }
      }

      // Manual cache breakpoint on the turn-starting user message.
      // This is the stable anchor for the current turn — everything up to
      // and including it won't change during tool-use iterations, so a long
      // TTL is appropriate. Walk backwards to find the last user message
      // with a real text block (skipping tool_result-only messages and
      // synthetic continuation placeholders injected by ensureToolPairing).
      let turnStartIdx = -1;
      for (let i = sentMessages.length - 1; i >= 0; i--) {
        const msg = sentMessages[i];
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        const hasText = msg.content.some(
          (b) =>
            typeof b !== "string" &&
            b.type === "text" &&
            b.text !== SYNTHETIC_CONTINUATION_TEXT,
        );
        if (!hasText) continue;
        const lastBlock = msg.content[msg.content.length - 1];
        if (typeof lastBlock !== "string") {
          (lastBlock as unknown as Record<string, unknown>).cache_control =
            cacheControl;
        }
        turnStartIdx = i;
        break;
      }

      // Advancing tail: place a short-lived 5m cache breakpoint on the last
      // block of the last message when it falls after the turn-starting user
      // message (i.e. tool-use loop content). This caches the growing tail
      // cheaply without conflicting with the 1h breakpoints above.
      // Skip thinking/redacted_thinking blocks — Anthropic doesn't allow
      // cache_control on those types.
      let tailBreakpointApplied = false;
      if (turnStartIdx >= 0 && turnStartIdx < sentMessages.length - 1) {
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
            tailBreakpointApplied = true;
          }
        }
      }

      // Enforce Anthropic API maximum of 4 cache_control blocks.
      // When the system prompt boundary splits into 2 cached blocks AND
      // tools + turn-start + advancing-tail breakpoints are all present,
      // we'd have 5.  Drop the static system block's breakpoint — it's
      // small (<1K tokens) so the re-read cost is negligible, while the
      // dynamic block (workspace context) rarely changes mid-session and
      // benefits more from caching.
      const hasTailBreakpoint = tailBreakpointApplied;
      const hasToolCacheBreakpoint =
        params.tools?.some(
          (t) => "cache_control" in t && t.cache_control != null,
        ) ?? false;
      if (
        hasTailBreakpoint &&
        Array.isArray(params.system) &&
        params.system.length === 2 &&
        hasToolCacheBreakpoint
      ) {
        delete (params.system[0] as unknown as Record<string, unknown>)
          .cache_control;
      }

      // Strip orphaned UTF-16 surrogates so the Anthropic JSON parser never
      // sees invalid strings produced by upstream surrogate-splitting `.slice()` calls.
      const sanitized = stripOrphanedSurrogatesDeep(params);
      if (sanitized.changed) {
        logOrphanedSurrogateWarning(sanitized.fixedStringCount, sentMessages);
        params = sanitized.value;
        sentMessages = params.messages;
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);

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

      // Fast mode: use the beta endpoint with speed: "fast" for Opus models (4.6, 4.7)
      const useFastMode = speed === "fast" && effectiveModel.includes("opus");

      // Collect required betas: extended cache TTL for 1h system prompt caching,
      // 1M context window, and fast-mode when applicable.
      // Haiku doesn't support the extended cache TTL or 1M context betas.
      const betas: string[] = isHaiku
        ? []
        : ["extended-cache-ttl-2025-04-11", "context-1m-2025-08-07"];
      if (useFastMode) {
        betas.push("fast-mode-2026-02-01");
      }

      let response: Anthropic.Message;
      try {
        const stream: UnifiedStream = useFastMode
          ? (this.client.beta.messages.stream(
              {
                ...(params as Record<string, unknown>),
                speed: "fast" as const,
                betas,
              } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming &
                Anthropic.Beta.Messages.MessageCreateParamsStreaming,
              { signal: timeoutSignal },
            ) as unknown as UnifiedStream)
          : betas.length > 0
            ? (this.client.beta.messages.stream(
                {
                  ...(params as Record<string, unknown>),
                  betas,
                } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming &
                  Anthropic.Beta.Messages.MessageCreateParamsStreaming,
                { signal: timeoutSignal },
              ) as unknown as UnifiedStream)
            : (this.client.messages.stream(params, {
                signal: timeoutSignal,
              }) as unknown as UnifiedStream);

        stream.on("text", (text) => {
          onEvent?.({ type: "text_delta", text });
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

        stream.on("streamEvent", (event) => {
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
              content?: { type: "web_search_tool_result_error" } | unknown[];
            };
            const isError =
              !Array.isArray(block.content) &&
              block.content?.type === "web_search_tool_result_error";
            onEvent?.({
              type: "server_tool_complete",
              toolUseId: block.tool_use_id,
              isError: !!isError,
              ...(Array.isArray(block.content)
                ? { content: block.content }
                : {}),
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
          }
        });

        stream.on("inputJson", (partialJson) => {
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
      const abortReason =
        signal?.aborted && isAbortReason(signal.reason)
          ? signal.reason
          : undefined;
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
        if (abortReason) {
          log.info(
            { abortReason, message: error.message },
            "Anthropic request aborted by daemon",
          );
        } else {
          log.error(
            {
              status: error.status,
              message: error.message,
              headers: Object.fromEntries(error.headers?.entries() ?? []),
            },
            `Anthropic API error (${error.status})`,
          );
        }
        const retryAfterMs = extractRetryAfterMs(error.headers);
        const errorOptions: {
          retryAfterMs?: number;
          abortReason?: unknown;
        } = {};
        if (retryAfterMs !== undefined) errorOptions.retryAfterMs = retryAfterMs;
        if (abortReason) errorOptions.abortReason = abortReason;
        throw new ProviderError(
          `Anthropic API error (${error.status}): ${error.message}`,
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
   * Convert a content block to Anthropic format, returning null for unknown
   * block types instead of throwing.  Unknown types (e.g. ui_surface stored
   * in DB) are silently dropped so they don't prevent the request from being
   * sent or break tool_use/tool_result pairing.
   */
  private toAnthropicBlockSafe(
    block: ContentBlock,
  ): Anthropic.ContentBlockParam | null {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      case "image":
        if (!ANTHROPIC_SUPPORTED_IMAGE_TYPES.has(block.source.media_type)) {
          log.warn(
            `Unsupported image MIME type for Anthropic: ${block.source.media_type}; replacing with text placeholder`,
          );
          return {
            type: "text",
            text: `[Image: ${block.source.media_type} — format not supported by this provider]`,
          };
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.source
              .media_type as Anthropic.Base64ImageSource["media_type"],
            data: block.source.data,
          },
        };
      case "file": {
        const { media_type, data, filename } = block.source;
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
              parts.push({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: cb.source
                    .media_type as Anthropic.Base64ImageSource["media_type"],
                  data: cb.source.data,
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
