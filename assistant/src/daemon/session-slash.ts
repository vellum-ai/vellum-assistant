import { readFileSync, existsSync } from 'node:fs';
import { getConfig, loadRawConfig, saveRawConfig } from '../config/loader.js';
import { initializeProviders } from '../providers/registry.js';
import { loadSkillCatalog } from '../config/skills.js';
import { resolveSkillStates } from '../config/skill-state.js';
import {
  buildInvocableSlashCatalog,
  rewriteKnownSlashCommandPrompt,
  parseSlashCandidate,
  formatUnknownSlashSkillMessage,
} from '../skills/slash-commands.js';
import { getWorkspacePromptPath } from '../util/platform.js';
import { discoverCCCommands } from '../commands/cc-command-registry.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('session-slash');

export type SlashResolution =
  | { kind: 'passthrough'; content: string }
  | { kind: 'rewritten'; content: string; skillId: string }
  | { kind: 'cc_command'; content: string; commandName: string }
  | { kind: 'unknown'; message: string };

// ── /model command ───────────────────────────────────────────────────

const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-opus-4-6-fast',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-6-fast': 'Claude Opus 4.6 Fast',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

const PROVIDER_MODEL_SHORTCUTS: Record<string, { provider: string; model: string; displayName: string }> = {
  // Anthropic
  'opus': { provider: 'anthropic', model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
  'opus-fast': { provider: 'anthropic', model: 'claude-opus-4-6-fast', displayName: 'Claude Opus 4.6 Fast' },
  'sonnet': { provider: 'anthropic', model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
  'haiku': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },

  // OpenAI
  'gpt4': { provider: 'openai', model: 'gpt-4', displayName: 'GPT-4' },
  'gpt4o': { provider: 'openai', model: 'gpt-4o', displayName: 'GPT-4o' },
  'gpt5': { provider: 'openai', model: 'gpt-5.2', displayName: 'GPT-5.2' },

  // Gemini
  'gemini': { provider: 'gemini', model: 'gemini-3-flash', displayName: 'Gemini 3 Flash' },

  // Ollama
  'ollama': { provider: 'ollama', model: 'llama3.2', displayName: 'Llama 3.2' },

  // Fireworks
  'fireworks': { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p5', displayName: 'Kimi K2.5' },

  // OpenRouter
  'openrouter': { provider: 'openrouter', model: 'x-ai/grok-4', displayName: 'Grok 4 (OpenRouter)' },
};

/** Reverse lookup: model ID → provider, derived from PROVIDER_MODEL_SHORTCUTS. */
export const MODEL_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_MODEL_SHORTCUTS).map(({ model, provider }) => [model, provider]),
);

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

function resolveProviderModelCommand(content: string): SlashResolution | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract the command (e.g., "/gpt4" → "gpt4")
  const match = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const shortcut = PROVIDER_MODEL_SHORTCUTS[command];
  if (!shortcut) return null;

  const { provider, model, displayName } = shortcut;
  const config = getConfig();
  const name = getAssistantName();

  // Check if API key exists for this provider (Ollama doesn't require an API key)
  if (provider !== 'ollama' && !config.apiKeys[provider]) {
    return {
      kind: 'unknown',
      message: `Cannot switch to ${displayName}. No API key configured for ${provider}.\n\nSet it with: \`config set apiKeys.${provider} <your-key>\``,
    };
  }

  // Check if already using this provider+model
  if (config.provider === provider && config.model === model) {
    const alreadyMsg = name
      ? `${name} is already running on **${displayName}**.`
      : `Already using **${displayName}**.`;
    return {
      kind: 'unknown',
      message: alreadyMsg,
    };
  }

  // Update config with both provider and model
  const raw = loadRawConfig();
  raw.provider = provider;
  raw.model = model;
  saveRawConfig(raw);

  // Re-initialize providers with new config
  const newConfig = getConfig();
  initializeProviders(newConfig);

  const switchedMsg = name
    ? `Switched ${name} to **${displayName}**. New conversations will use this model.`
    : `Switched to **${displayName}**. New conversations will use this model.`;

  return {
    kind: 'unknown',
    message: switchedMsg,
  };
}

function resolveModelList(): SlashResolution {
  const config = getConfig();
  const lines = ['Available models:\n'];

  for (const [cmd, { provider, model, displayName }] of Object.entries(PROVIDER_MODEL_SHORTCUTS)) {
    const hasKey = provider === 'ollama' || !!config.apiKeys[provider];
    const isCurrent = config.provider === provider && config.model === model;
    const status = hasKey ? '✓' : '✗';
    const current = isCurrent ? ' **[current]**' : '';
    lines.push(`- **${displayName}** (/${cmd}) ${status}${current}`);
  }

  lines.push('\n✓ = API key configured, ✗ = not configured');
  lines.push('\nTip: Configure a provider with `config set apiKeys.<provider> <key>`');

  return {
    kind: 'unknown',
    message: lines.join('\n'),
  };
}

function resolveModelCommand(content: string): SlashResolution | null {
  const trimmed = content.trim();
  // Match /models → route to list
  if (trimmed === '/models') {
    return resolveModelList();
  }

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

  // Handle /model list
  if (args === 'list') {
    return resolveModelList();
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

  // Validate that Anthropic provider is available
  if (!currentConfig.apiKeys.anthropic) {
    const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
    return {
      kind: 'unknown',
      message: `Cannot switch to ${displayName}. No API key configured for Anthropic.\n\nSet it with: \`config set apiKeys.anthropic <your-key>\``,
    };
  }

  // Change model: save config and re-initialize providers
  const raw = loadRawConfig();
  raw.provider = 'anthropic'; // Ensure provider is set for Anthropic models
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
 * Resolve slash commands against both the Vellum skill catalog and
 * Claude Code `.claude/commands/*.md` files.
 *
 * Returns `unknown` with a deterministic message, or the (possibly rewritten) content.
 */
export function resolveSlash(content: string, cwd?: string): SlashResolution {
  const start = performance.now();

  // Check provider shortcuts first (/gpt4, /opus, etc.)
  const providerResult = resolveProviderModelCommand(content);
  if (providerResult) {
    log.debug({ durationMs: performance.now() - start, kind: providerResult.kind }, 'Slash route resolved');
    return providerResult;
  }

  // Handle /model command
  const modelResult = resolveModelCommand(content);
  if (modelResult) {
    log.debug({ durationMs: performance.now() - start, kind: modelResult.kind }, 'Slash route resolved');
    return modelResult;
  }

  // Handle /commands command — lists all available commands from both sources
  if (content.trim() === '/commands') {
    const lines = [
      '/commands — List all available commands',
      '/model — Show or switch the current model',
      '/models — List all available models',
    ];

    const config = getConfig();
    const catalog = loadSkillCatalog();
    const resolved = resolveSkillStates(catalog, config);
    const invocable = buildInvocableSlashCatalog(catalog, resolved);
    if (invocable.size > 0) {
      lines.push('');
      lines.push('Skills:');
      for (const [, skill] of invocable) {
        lines.push(`- /${skill.canonicalId} — ${skill.name}`);
      }
    }

    if (cwd) {
      const ccRegistry = discoverCCCommands(cwd);
      if (ccRegistry.entries.size > 0) {
        lines.push('');
        lines.push('Claude Code commands:');
        for (const [, entry] of ccRegistry.entries) {
          lines.push(`- /${entry.name} — ${entry.summary}`);
        }
      }
    }

    const result: SlashResolution = { kind: 'unknown', message: lines.join('\n') };
    log.debug({ durationMs: performance.now() - start, kind: result.kind }, 'Slash route resolved');
    return result;
  }

  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);
  const invocable = buildInvocableSlashCatalog(catalog, resolved);

  // Parse the slash candidate before doing dual-source lookup
  const candidate = parseSlashCandidate(content);
  if (candidate.kind === 'none') {
    const result: SlashResolution = { kind: 'passthrough', content };
    log.debug({ durationMs: performance.now() - start, kind: result.kind }, 'Slash route resolved');
    return result;
  }

  const token = candidate.token!;
  const requestedId = token.slice(1);
  const lookupKey = requestedId.toLowerCase();

  // Extract trailing args: everything after the first token
  const trimmed = content.trimStart();
  const firstSpaceIdx = trimmed.search(/\s/);
  const trailingArgs = firstSpaceIdx === -1 ? '' : trimmed.slice(firstSpaceIdx).trim();

  // Lookup in both sources
  const vellumMatch = invocable.get(lookupKey);
  const ccRegistry = cwd ? discoverCCCommands(cwd) : null;
  const ccMatch = ccRegistry?.entries.get(lookupKey);

  const hasVellum = !!vellumMatch;
  const hasCc = !!ccMatch;

  let result: SlashResolution;

  if (hasVellum && !hasCc) {
    // vellum_only → existing rewrite logic
    result = {
      kind: 'rewritten',
      content: rewriteKnownSlashCommandPrompt({
        rawInput: content,
        skillId: vellumMatch.canonicalId,
        skillName: vellumMatch.name,
        trailingArgs,
      }),
      skillId: vellumMatch.canonicalId,
    };
  } else if (hasCc && !hasVellum) {
    // cc_only → route to CC command
    result = buildCCCommandResolution(ccMatch.name, trailingArgs);
  } else if (hasVellum && hasCc) {
    // both → check collision preference
    const preference = config.slashCollisionPreference;
    if (preference === 'prefer_vellum') {
      result = {
        kind: 'rewritten',
        content: rewriteKnownSlashCommandPrompt({
          rawInput: content,
          skillId: vellumMatch.canonicalId,
          skillName: vellumMatch.name,
          trailingArgs,
        }),
        skillId: vellumMatch.canonicalId,
      };
    } else if (preference === 'prefer_cc') {
      result = buildCCCommandResolution(ccMatch.name, trailingArgs);
    } else {
      // 'ask' — return disambiguation message
      result = {
        kind: 'unknown',
        message: [
          `\`/${requestedId}\` matches both a Vellum skill and a Claude Code command.`,
          '',
          `- Vellum skill: **${vellumMatch.name}** (/${vellumMatch.canonicalId})`,
          `- Claude Code command: **${ccMatch.name}**`,
          '',
          'Set `slashCollisionPreference` in your config to `prefer_vellum` or `prefer_cc` to resolve automatically.',
        ].join('\n'),
      };
    }
  } else {
    // none → return unknown with combined listing
    const availableSkillIds = Array.from(invocable.values())
      .map((s) => s.canonicalId)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    const ccCommandNames = ccRegistry
      ? Array.from(ccRegistry.entries.values())
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
      : undefined;
    result = {
      kind: 'unknown',
      message: formatUnknownSlashSkillMessage(requestedId, availableSkillIds, ccCommandNames),
    };
  }

  log.debug({ durationMs: performance.now() - start, kind: result.kind }, 'Slash route resolved');
  return result;
}

/** Build a cc_command resolution with a rewritten prompt. */
function buildCCCommandResolution(commandName: string, trailingArgs: string): SlashResolution {
  const rewrittenPrompt = [
    `The user invoked the slash command \`/${commandName}\`.`,
    `Execute the Claude Code command "${commandName}" using the claude_code tool with command="${commandName}".`,
    trailingArgs ? `\nUser arguments: ${trailingArgs}` : '',
  ].filter(Boolean).join('\n');

  return {
    kind: 'cc_command',
    content: rewrittenPrompt,
    commandName,
  };
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
