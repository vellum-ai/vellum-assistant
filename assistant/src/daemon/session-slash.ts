import { getConfig } from '../config/loader.js';
import { loadSkillCatalog } from '../config/skills.js';
import { resolveSkillStates } from '../config/skill-state.js';
import {
  buildInvocableSlashCatalog,
  resolveSlashSkillCommand,
  rewriteKnownSlashCommandPrompt,
} from '../skills/slash-commands.js';

export type SlashResolution =
  | { kind: 'passthrough' | 'rewritten'; content: string }
  | { kind: 'unknown'; message: string };

/**
 * Resolve slash commands against the current skill catalog.
 * Returns `unknown` with a deterministic message, or the (possibly rewritten) content.
 */
export function resolveSlash(content: string): SlashResolution {
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
