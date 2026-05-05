import type { Message } from "../providers/types.js";

/** Matches both old (`<loaded_skill id="..." />`) and new versioned
 *  (`<loaded_skill id="..." version="v1:hex" />`) marker formats.
 *  Group 1 = skill ID, group 2 = version string (optional). */
const LOADED_SKILL_RE =
  /<loaded_skill\s+id="([^"]+)"(?:\s+version="([^"]+)")?\s*\/>/g;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActiveSkillEntry {
  id: string;
  /** Present only when the marker includes a `version` attribute; retained for versioned marker compatibility. */
  version?: string;
  /** The selector originally passed to skill_load, when available. */
  selector?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans conversation history for `<loaded_skill>` markers and returns an
 * ordered, deduplicated list of active skill entries (ID + optional version).
 *
 * Supports two marker formats:
 *   - Legacy:     `<loaded_skill id="skill-id" />`
 *   - Versioned:  `<loaded_skill id="skill-id" version="v1:hexhash" />`
 *
 * Only `tool_result` blocks whose corresponding `tool_use` has
 * `name === 'skill_load'` are considered.  This prevents user messages or
 * arbitrary tool outputs from injecting fake skill activations.
 */
export function deriveActiveSkills(messages: Message[]): ActiveSkillEntry[] {
  // First pass: collect tool_use IDs that belong to skill_load calls.
  const skillLoadSelectorsByUseId = new Map<string, string | undefined>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "skill_load") {
        const rawSelector =
          typeof block.input.skill === "string" ? block.input.skill : undefined;
        const selector = rawSelector?.startsWith("bundled:")
          ? rawSelector
          : undefined;
        skillLoadSelectorsByUseId.set(block.id, selector);
      }
    }
  }

  // Second pass: parse markers only from matching tool_result blocks.
  const seen = new Set<string>();
  const entries: ActiveSkillEntry[] = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (!skillLoadSelectorsByUseId.has(block.tool_use_id)) continue;

      const text = block.content;
      if (!text) continue;

      for (const match of text.matchAll(LOADED_SKILL_RE)) {
        const id = match[1];
        if (!seen.has(id)) {
          seen.add(id);
          const entry: ActiveSkillEntry = { id };
          if (match[2]) {
            entry.version = match[2];
          }
          const selector = skillLoadSelectorsByUseId.get(block.tool_use_id);
          if (selector) {
            entry.selector = selector;
          }
          entries.push(entry);
        }
      }
    }
  }

  return entries;
}
