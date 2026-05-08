import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { getConfig } from "../config/loader.js";
import { getConversationOverrideProfile } from "../memory/conversation-crud.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string }
  | { kind: "compact"; targetInputTokensOverride?: number };

const COMPACT_USAGE_HINT =
  "Usage: `/compact [<tokens>]` (e.g. `/compact 30000`, `/compact 30k`, `/compact 1m`).";

type CompactParse =
  | { kind: "compact"; targetInputTokensOverride?: number }
  | { kind: "unknown"; message: string };

const TOKEN_COUNT_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+(.+?))?\s*$/i;

function parseTokenCount(input: string): number | null {
  const match = input.match(TOKEN_COUNT_PATTERN);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokens = Math.floor(value * multiplier);
  return tokens > 0 ? tokens : null;
}

function parseCompactCommand(trimmed: string): CompactParse | null {
  const match = trimmed.match(COMPACT_COMMAND_PATTERN);
  if (!match) return null;
  const rest = match[1]?.trim();
  if (!rest) return { kind: "compact" };
  const tokens = parseTokenCount(rest);
  if (tokens == null) {
    return {
      kind: "unknown",
      message: `Unrecognized argument to \`/compact\`: \`${rest}\`. ${COMPACT_USAGE_HINT}`,
    };
  }
  return { kind: "compact", targetInputTokensOverride: tokens };
}

// ── /context and /status commands ────────────────────────────────────

export interface SlashContext {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  model: string;
  provider: string;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
}

export interface SlashContextSource {
  conversationId: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
}

export function buildSlashContextForContent(
  content: string,
  source: SlashContextSource,
): SlashContext | undefined {
  if (classifySlash(content) === "passthrough") return undefined;

  const config = getConfig();
  const contextWindow = resolveEffectiveContextWindow({
    llm: config.llm,
    callSite: "mainAgent",
    overrideProfile: getConversationOverrideProfile(source.conversationId),
  });
  return {
    messageCount: source.messageCount,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    maxInputTokens: contextWindow.maxInputTokens,
    model: contextWindow.model,
    provider: contextWindow.provider,
    estimatedCost: source.estimatedCost,
    userMessageInterface: source.userMessageInterface,
  };
}

// ── Deprecated model-switching shortcuts ─────────────────────────────

/**
 * Former provider shortcut commands that switched models. These are now
 * removed — model switching lives in Settings. We reject them explicitly
 * so they don't fall through to the LLM as passthrough text.
 */
const DEPRECATED_MODEL_SHORTCUTS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok-beta",
  "grok-multi",
]);

// ── /models command ──────────────────────────────────────────────────

async function resolveModelList(): Promise<SlashResolution> {
  const config = getConfig();
  const configuredProviders = new Set<string>(await getConfiguredProviders());

  const lines = ["Available models:\n"];

  for (const {
    id: provider,
    displayName: providerName,
    models,
  } of PROVIDER_CATALOG) {
    const hasKey = configuredProviders.has(provider);
    const status = hasKey ? "✓" : "✗";
    lines.push(`**${providerName}** ${status}`);
    for (const { id, displayName } of models) {
      const isCurrent =
        config.llm.default.provider === provider &&
        config.llm.default.model === id;
      const current = isCurrent ? " **[current]**" : "";
      lines.push(`  - ${displayName} (\`${id}\`)${current}`);
    }
    lines.push("");
  }

  lines.push("✓ = API key configured, ✗ = not configured");
  lines.push("\nTip: Configure a provider with `keys set <provider> <key>`");

  return {
    kind: "unknown",
    message: lines.join("\n"),
  };
}

function resolveStatusCommand(context: SlashContext): SlashResolution {
  const {
    inputTokens,
    maxInputTokens,
    model,
    provider,
    messageCount,
    outputTokens,
    estimatedCost,
  } = context;
  const pct =
    maxInputTokens > 0
      ? Math.min(Math.round((inputTokens / maxInputTokens) * 100), 100)
      : 0;
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const fmt = (n: number) => n.toLocaleString("en-US");

  const lines = [
    "Conversation Status\n",
    `Context:  ${bar}  ${pct}%  (${fmt(inputTokens)} / ${fmt(
      maxInputTokens,
    )} tokens)`,
    `Model:    ${model} (${provider})`,
    `Messages: ${fmt(messageCount)}`,
    `Tokens:   ${fmt(inputTokens)} in / ${fmt(outputTokens)} out`,
    `Cost:     $${estimatedCost.toFixed(2)} (estimated)`,
  ];

  return { kind: "unknown", message: lines.join("\n") };
}

function resolveCommandsList(context?: SlashContext): string[] {
  const fallbackLines = [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
  ];
  if (context) {
    fallbackLines.push("/context — Show conversation context usage");
  }
  fallbackLines.push("/models — List all available models");
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) return fallbackLines;

  if (context.userMessageInterface === "macos") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/context — Show conversation context usage",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  if (context.userMessageInterface === "ios") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/context — Show conversation context usage",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    "/context — Show conversation context usage",
    "/models — List all available models",
    "/status — Show conversation status and context usage",
    "/btw — Ask a side question while the assistant is working",
  ];
}

/**
 * Pure classifier: returns the kind of slash resolution `resolveSlash` would
 * produce for `content`, without triggering any side effects.
 *
 * Queue-drain lookahead (`buildPassthroughBatch`) uses this to decide whether
 * to include a queued message in a contiguous passthrough batch. `resolveSlash`
 * itself may run side effects, so calling it during lookahead and then again
 * in the real drain would execute those side effects twice.
 */
export function classifySlash(
  content: string,
): "passthrough" | "compact" | "unknown" {
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return "unknown";
  }
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return "unknown";
  }
  if (trimmed === "/models") return "unknown";
  const compactParse = parseCompactCommand(trimmed);
  if (compactParse) return compactParse.kind;
  if (trimmed === "/context") return "unknown";
  if (trimmed === "/status") return "unknown";
  if (trimmed === "/commands") return "unknown";
  return "passthrough";
}

/**
 * Resolve built-in slash commands (/models, /context, /status, /commands, /compact).
 * Returns `unknown` with a deterministic message, `compact` for forced compaction,
 * or the (possibly rewritten) content as `passthrough`.
 */
export async function resolveSlash(
  content: string,
  context?: SlashContext,
): Promise<SlashResolution> {
  // Handle deprecated model-switching commands — direct users to Settings
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return {
      kind: "unknown",
      message:
        "The `/model` command has been removed. Use **Settings → Models & Services** to change your model and provider.",
    };
  }

  // Reject deprecated provider shortcut commands (/opus, /sonnet, /haiku, etc.)
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return {
      kind: "unknown",
      message: `The \`/${shortcutMatch[1]}\` shortcut has been removed. Use **Settings → Models & Services** to change your model and provider.`,
    };
  }

  // Handle /models command (read-only listing)
  if (trimmed === "/models") {
    return await resolveModelList();
  }

  // Handle /compact command (with optional `<tokens>` override).
  const compactParse = parseCompactCommand(trimmed);
  if (compactParse) return compactParse;

  // Handle /context and legacy /status commands
  if (trimmed === "/context" || trimmed === "/status") {
    if (!context) {
      return {
        kind: "unknown",
        message: "Status information is not available in this context.",
      };
    }
    return resolveStatusCommand(context);
  }

  // Handle /commands command
  if (trimmed === "/commands") {
    return {
      kind: "unknown",
      message: resolveCommandsList(context).join("\n"),
    };
  }

  return { kind: "passthrough", content };
}

// ── Provider Ordering Error Detection ────────────────────────────────

const ORDERING_ERROR_PATTERNS = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

export function isProviderOrderingError(message: string): boolean {
  return ORDERING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
