import type { InterfaceId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string }
  | { kind: "compact" };

// ── /status command ──────────────────────────────────────────────────

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
    "/models — List all available models",
  ];
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) return fallbackLines;

  if (context.userMessageInterface === "macos") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
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
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
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
  if (trimmed === "/compact") return "compact";
  if (trimmed === "/status") return "unknown";
  if (trimmed === "/commands") return "unknown";
  return "passthrough";
}

/**
 * Resolve built-in slash commands (/models, /status, /commands, /compact).
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

  // Handle /compact command
  if (trimmed === "/compact") {
    return { kind: "compact" };
  }

  // Handle /status command
  if (trimmed === "/status") {
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
