import { readFileSync, existsSync } from 'node:fs';
import { getConfig, loadRawConfig, saveRawConfig } from '../config/loader.js';
import { initializeProviders } from '../providers/registry.js';
import { loadSkillCatalog } from '../config/skills.js';
import { resolveSkillStates } from '../config/skill-state.js';
import {
  buildInvocableSlashCatalog,
  resolveSlashSkillCommand,
  rewriteKnownSlashCommandPrompt,
} from '../skills/slash-commands.js';
import { getWorkspacePromptPath } from '../util/platform.js';

export type SlashResolution =
  | { kind: 'passthrough'; content: string }
  | { kind: 'rewritten'; content: string; skillId: string }
  | { kind: 'unknown'; message: string };

// ── /model command ───────────────────────────────────────────────────

const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
] as const;

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

/** Read the assistant's name from IDENTITY.md for personalized responses. */
function getAssistantName(): string | null {
  try {
    const path = getWorkspacePromptPath('IDENTITY.md');
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Partial-match a user input like "opus", "sonnet", "haiku" to a full model ID. */
function matchModel(input: string): string | undefined {
  const lower = input.toLowerCase().trim();
  // Exact match first
  const exact = AVAILABLE_MODELS.find((m) => m === lower);
  if (exact) return exact;
  // Partial match (e.g. "opus" → "claude-opus-4-6")
  return AVAILABLE_MODELS.find((m) => m.includes(lower));
}

function resolveModelCommand(content: string): SlashResolution | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/model')) return null;
  // Ensure it's exactly "/model" or "/model " (not "/modelsomething")
  if (trimmed.length > 6 && trimmed[6] !== ' ') return null;

  const args = trimmed.slice(6).trim();
  const name = getAssistantName();

  if (!args) {
    // Show current model
    const config = getConfig();
    const displayName = MODEL_DISPLAY_NAMES[config.model] ?? config.model;
    const prefix = name ? `${name} is running on` : `Currently using`;
    return {
      kind: 'unknown',
      message: `${prefix} **${displayName}** (\`${config.model}\`).`,
    };
  }

  // Try to match the model name
  const matched = matchModel(args);
  if (!matched) {
    const available = AVAILABLE_MODELS.map(
      (m) => `- **${MODEL_DISPLAY_NAMES[m]}** (\`${m}\`)`,
    ).join('\n');
    return {
      kind: 'unknown',
      message: `Hmm, "${args}" doesn't match any available model. Here's what you can pick from:\n${available}`,
    };
  }

  // Check if already using this model
  const currentConfig = getConfig();
  if (currentConfig.model === matched) {
    const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
    const alreadyMsg = name
      ? `${name} is already running on **${displayName}**.`
      : `Already on **${displayName}**.`;
    return {
      kind: 'unknown',
      message: alreadyMsg,
    };
  }

  // Change model: save config and re-initialize providers
  const raw = loadRawConfig();
  raw.model = matched;
  saveRawConfig(raw);
  const config = getConfig();
  initializeProviders(config);

  const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
  const switchedMsg = name
    ? `Switched ${name} to **${displayName}**. New conversations will use this model.`
    : `Switched to **${displayName}**. New conversations will use this model.`;
  return {
    kind: 'unknown',
    message: switchedMsg,
  };
}

/**
 * Resolve slash commands against the current skill catalog.
 * Returns `unknown` with a deterministic message, or the (possibly rewritten) content.
 */
export function resolveSlash(content: string): SlashResolution {
  // Handle /model before skill resolution
  const modelResult = resolveModelCommand(content);
  if (modelResult) return modelResult;
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);
  const invocable = buildInvocableSlashCatalog(catalog, resolved);
  const resolution = resolveSlashSkillCommand(content, invocable);

  if (resolution.kind === 'known') {
    const skill = invocable.get(resolution.skillId.toLowerCase());
    return {
      kind: 'rewritten',
      content: rewriteKnownSlashCommandPrompt({
        rawInput: content,
        skillId: resolution.skillId,
        skillName: skill?.name ?? resolution.skillId,
        trailingArgs: resolution.trailingArgs,
      }),
      skillId: resolution.skillId,
    };
  }

  if (resolution.kind === 'unknown') {
    return { kind: 'unknown', message: resolution.message };
  }

  return { kind: 'passthrough', content };
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
