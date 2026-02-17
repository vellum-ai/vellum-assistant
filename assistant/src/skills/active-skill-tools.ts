import type { Message } from '../providers/types.js';

const LOADED_SKILL_RE = /<loaded_skill\s+id="([^"]+)"\s*\/>/g;

/**
 * Scans conversation history for `<loaded_skill id="..." />` markers and
 * returns an ordered, deduplicated list of active skill IDs.  The function is
 * intentionally pure — no caching or side-effects — so callers can invoke it on
 * every turn without worrying about stale state.
 */
export function deriveActiveSkillIds(messages: Message[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      let text: string | undefined;

      if (block.type === 'text') {
        text = block.text;
      } else if (block.type === 'tool_result') {
        text = block.content;
      }

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
