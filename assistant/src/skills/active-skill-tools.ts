import type { Message } from '../providers/types.js';

const LOADED_SKILL_RE = /<loaded_skill\s+id="([^"]+)"\s*\/>/g;

/**
 * Scans conversation history for `<loaded_skill id="..." />` markers and
 * returns an ordered, deduplicated list of active skill IDs.
 *
 * Only `tool_result` blocks whose corresponding `tool_use` has
 * `name === 'skill_load'` are considered.  This prevents user messages or
 * arbitrary tool outputs from injecting fake skill activations.
 */
export function deriveActiveSkillIds(messages: Message[]): string[] {
  // First pass: collect tool_use IDs that belong to skill_load calls.
  const skillLoadUseIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'skill_load') {
        skillLoadUseIds.add(block.id);
      }
    }
  }

  // Second pass: parse markers only from matching tool_result blocks.
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (!skillLoadUseIds.has(block.tool_use_id)) continue;

      const text = block.content;
      if (!text) continue;

      for (const match of text.matchAll(LOADED_SKILL_RE)) {
        const id = match[1];
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }

  return ids;
}
