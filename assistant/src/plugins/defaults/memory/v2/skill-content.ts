import { getConfig } from "../../../../config/loader.js";
import type { SkillCapabilityInput } from "../../../../skills/skill-memory.js";

/**
 * Character budget for an always-candidate skill's capability statement. Larger
 * than the default so a cross-cutting skill (pinned into the selector pool every
 * turn) can describe its full range of uses rather than a single mode — see
 * `buildSkillContent`'s `maxChars` and `skill-store.ts`'s seeding loop.
 */
export const ALWAYS_CANDIDATE_CARD_CHARS = 900;

/**
 * Render the prose-style capability statement embedded into the unified
 * `memory_v2_concept_pages` Qdrant collection (under the `skills/<id>` slug
 * prefix) and rendered in `### Skills You Can Use` / the memory-v3 selector
 * card. Capped at `maxChars` (default 500). A larger budget switches the hints
 * to a bulleted list — easier for the selector to parse one mode per line — so
 * always-candidate skills can carry a fuller, multi-mode description.
 */
export function buildSkillContent(
  input: SkillCapabilityInput,
  maxChars = 500,
): string {
  const list = maxChars > 500;
  let content = `The "${input.displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (input.activationHints && input.activationHints.length > 0) {
    content += list
      ? `\nUse when:\n${input.activationHints.map((h) => `- ${h}`).join("\n")}`
      : ` Use when: ${input.activationHints.join("; ")}.`;
  }
  if (input.avoidWhen && input.avoidWhen.length > 0) {
    content += list
      ? `\nAvoid when:\n${input.avoidWhen.map((a) => `- ${a}`).join("\n")}`
      : ` Avoid when: ${input.avoidWhen.join("; ")}.`;
  }
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
  }
  return content;
}

/**
 * mcp-setup is special-cased in v1 (`capability-seed.ts:102-112`):
 * its description is augmented with the list of configured MCP server
 * names so the model can pattern-match against them. Port verbatim.
 */
export function augmentMcpSetupDescription(
  input: SkillCapabilityInput,
): SkillCapabilityInput {
  if (input.id !== "mcp-setup") return input;
  const servers = getConfig().mcp?.servers;
  if (!servers) return input;
  const names = Object.keys(servers).filter(
    (name) => servers[name]?.enabled !== false,
  );
  if (names.length === 0) return input;
  return {
    ...input,
    description: `${input.description} Configured: ${names.join(", ")}`,
  };
}
