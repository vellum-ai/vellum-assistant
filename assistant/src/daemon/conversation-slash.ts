import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { orderProfileKeys } from "../config/profile-order.js";
import { getConversationOverrideProfile } from "../persistence/conversation-crud.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";
import { getVisibleProviderCatalog } from "../providers/provider-catalog-visibility.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string }
  | { kind: "compact" }
  | { kind: "clean" };

type CompactParse = { kind: "compact" } | { kind: "unknown"; message: string };

const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+(.+?))?\s*$/i;

function parseCompactCommand(trimmed: string): CompactParse | null {
  const match = trimmed.match(COMPACT_COMMAND_PATTERN);
  if (!match) return null;
  const rest = match[1]?.trim();
  if (rest) {
    return {
      kind: "unknown",
      message: `\`/compact\` does not take arguments. Usage: \`/compact\`.`,
    };
  }
  return { kind: "compact" };
}

type CleanParse = { kind: "clean" } | { kind: "unknown"; message: string };

const CLEAN_COMMAND_PATTERN = /^\/clean(?:\s+(.+?))?\s*$/i;

function parseCleanCommand(trimmed: string): CleanParse | null {
  const match = trimmed.match(CLEAN_COMMAND_PATTERN);
  if (!match) return null;
  const rest = match[1]?.trim();
  if (rest) {
    return {
      kind: "unknown",
      message: `\`/clean\` does not take arguments. Usage: \`/clean\`.`,
    };
  }
  return { kind: "clean" };
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

// ── /model command (inference profile switcher) ──────────────────────

type ModelCommandParse =
  | { kind: "list" }
  | { kind: "switch"; profileName: string };

/**
 * Parse `/model` and `/model <name>` forms. Returns `null` for any input
 * that isn't a `/model` invocation (so the caller can fall through).
 */
function parseModelCommand(trimmed: string): ModelCommandParse | null {
  if (trimmed === "/model") return { kind: "list" };
  if (!trimmed.startsWith("/model ")) return null;
  const rest = trimmed.slice("/model ".length).trim();
  if (rest.length === 0) return { kind: "list" };
  return { kind: "switch", profileName: rest };
}

async function resolveModelCommand(
  parse: ModelCommandParse,
): Promise<SlashResolution> {
  const config = getConfig();
  const profiles = (config.llm.profiles ?? {}) as Record<
    string,
    { label?: string; description?: string; status?: "active" | "disabled" }
  >;
  const profileNames = orderProfileKeys(profiles, config.llm.profileOrder);
  const activeProfile = config.llm.activeProfile;

  if (parse.kind === "list") {
    if (profileNames.length === 0) {
      return {
        kind: "unknown",
        message:
          "No inference profiles are defined. Use **Settings → Models & Services** to create one.",
      };
    }
    const lines = ["Inference profiles:\n"];
    for (const name of profileNames) {
      const profile = profiles[name];
      const label = profile.label ?? name;
      const isCurrent = name === activeProfile;
      const isDisabled = profile.status === "disabled";
      const marker = isCurrent ? " **[current]**" : "";
      const disabled = isDisabled ? " *(disabled)*" : "";
      const description = profile.description
        ? ` — ${profile.description}`
        : "";
      lines.push(
        `  - \`${name}\` (${label})${marker}${disabled}${description}`,
      );
    }
    lines.push("\nSwitch with `/model <name>`.");
    return { kind: "unknown", message: lines.join("\n") };
  }

  const target = parse.profileName;
  if (!(target in profiles)) {
    const available = profileNames.map((n) => `\`${n}\``).join(", ");
    const hint = available.length > 0 ? ` Available: ${available}.` : "";
    return {
      kind: "unknown",
      message: `Profile \`${target}\` not found.${hint}`,
    };
  }
  if (profiles[target].status === "disabled") {
    return {
      kind: "unknown",
      message: `Profile \`${target}\` is disabled. Enable it in **Settings → Models & Services** first.`,
    };
  }
  if (target === activeProfile) {
    const label = profiles[target].label ?? target;
    return {
      kind: "unknown",
      message: `Already using profile \`${target}\` (${label}).`,
    };
  }

  // Write `llm.activeProfile` directly to the raw config file. We invalidate
  // the in-process cache so the very next `getConfig()` reflects the switch;
  // the file watcher will also pick this up but its debounce can lag a tick.
  const raw = loadRawConfig();
  const llm: Record<string, unknown> =
    raw.llm != null && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? (raw.llm as Record<string, unknown>)
      : {};
  llm.activeProfile = target;
  raw.llm = llm;
  saveRawConfig(raw);
  invalidateConfigCache();

  const label = profiles[target].label ?? target;
  return {
    kind: "unknown",
    message: `Switched to profile \`${target}\` (${label}).`,
  };
}

// ── /models command ──────────────────────────────────────────────────

async function resolveModelList(): Promise<SlashResolution> {
  const config = getConfig();
  const resolvedMainAgent = resolveCallSiteConfig("mainAgent", config.llm);
  const configuredProviders = new Set<string>(await getConfiguredProviders());

  const lines = ["Available models:\n"];

  for (const {
    id: provider,
    displayName: providerName,
    models,
  } of getVisibleProviderCatalog(config)) {
    const hasKey = configuredProviders.has(provider);
    const status = hasKey ? "✓" : "✗";
    lines.push(`**${providerName}** ${status}`);
    for (const { id, displayName } of models) {
      const isCurrent =
        resolvedMainAgent.provider === provider &&
        resolvedMainAgent.model === id;
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

const CLEAN_HELP_LINE =
  "/clean — Strip injected runtime context and reset memory injection state (no summarization)";

function resolveCommandsList(context?: SlashContext): string[] {
  const fallbackLines = [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    CLEAN_HELP_LINE,
  ];
  if (context) {
    fallbackLines.push("/context — Show conversation context usage");
  }
  fallbackLines.push("/model — List or switch inference profile");
  fallbackLines.push("/models — List all available models");
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) return fallbackLines;

  if (context.userMessageInterface === "macos") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      CLEAN_HELP_LINE,
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
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
      CLEAN_HELP_LINE,
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    CLEAN_HELP_LINE,
    "/context — Show conversation context usage",
    "/model — List or switch inference profile",
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
): "passthrough" | "compact" | "clean" | "unknown" {
  const trimmed = content.trim();
  if (parseModelCommand(trimmed) != null) {
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
  const cleanParse = parseCleanCommand(trimmed);
  if (cleanParse) return cleanParse.kind;
  if (trimmed === "/context") return "unknown";
  if (trimmed === "/status") return "unknown";
  if (trimmed === "/commands") return "unknown";
  return "passthrough";
}

/**
 * Resolve built-in slash commands (/models, /context, /status, /commands,
 * /compact, /clean). Returns `unknown` with a deterministic message,
 * `compact` for forced compaction, `clean` for injection stripping, or the
 * (possibly rewritten) content as `passthrough`.
 */
export async function resolveSlash(
  content: string,
  context?: SlashContext,
): Promise<SlashResolution> {
  // Handle `/model` — list profiles (no arg) or switch active profile.
  const trimmed = content.trim();
  const modelParse = parseModelCommand(trimmed);
  if (modelParse != null) {
    return await resolveModelCommand(modelParse);
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

  // Handle /compact command (summarize history; takes no arguments).
  const compactParse = parseCompactCommand(trimmed);
  if (compactParse) return compactParse;

  // Handle /clean command (strip injections, no summarization).
  const cleanParse = parseCleanCommand(trimmed);
  if (cleanParse) return cleanParse;

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
