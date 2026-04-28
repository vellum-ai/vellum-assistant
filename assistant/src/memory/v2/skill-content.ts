import { getConfig } from "../../config/loader.js";
import type { SkillCapabilityInput } from "../../skills/skill-memory.js";

/**
 * Render the prose-style capability statement embedded into the
 * `memory_v2_skills` Qdrant collection and rendered in
 * `### Skills You Can Use`. Capped at 500 chars to match v1's behavior.
 */
export function buildSkillContent(input: SkillCapabilityInput): string {
  let content = `The "${input.displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (input.activationHints && input.activationHints.length > 0) {
    content += ` Use when: ${input.activationHints.join("; ")}.`;
  }
  if (input.avoidWhen && input.avoidWhen.length > 0) {
    content += ` Avoid when: ${input.avoidWhen.join("; ")}.`;
  }
  if (content.length > 500) {
    content = content.slice(0, 500);
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
