import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { skillFlagKey } from "../../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../../config/skills.js";

export function appendSkillsCatalog(basePrompt: string): string {
  const skills = loadSkillCatalog();
  const config = getConfig();

  // Filter out skills whose assistant feature flag is explicitly OFF
  const flagFiltered = skills.filter((s) => {
    const flagKey = skillFlagKey(s);
    return !flagKey || isAssistantFeatureFlagEnabled(flagKey, config);
  });

  const sections: string[] = [basePrompt];

  const catalog = formatSkillsCatalog(flagFiltered);
  if (catalog) sections.push(catalog);

  sections.push(buildSkillFallbackSection());

  return sections.join("\n\n");
}

function buildSkillFallbackSection(): string {
  return [
    "## Skill Authoring",
    "",
    "When no existing tool or skill can satisfy a request, load the `skill-authoring` skill for the full scaffold/test/persist workflow. Never persist or delete skills without explicit user confirmation.",
  ].join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a dynamic description for the mcp-setup skill that includes
 * configured MCP server names, so the model knows which servers exist.
 */
function getMcpSetupDescription(): string {
  const config = getConfig();
  const servers = config.mcp?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return "Add, authenticate, list, and remove MCP (Model Context Protocol) servers";
  }

  const serverNames = Object.keys(servers);
  return `Manage MCP servers. Configured: ${serverNames.join(", ")}. Load this skill to check status, authenticate, or add/remove servers.`;
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  // Filter out skills with disableModelInvocation or unsupported OS
  const visible = skills.filter((s) => {
    if (s.disableModelInvocation) return false;
    const os = s.metadata?.os;
    if (os && os.length > 0 && !os.includes(process.platform)) return false;
    return true;
  });
  if (visible.length === 0) return "";

  const lines = ["<available_skills>"];
  for (const skill of visible) {
    const idAttr = escapeXml(skill.id);
    const nameAttr = escapeXml(skill.displayName);
    const descAttr =
      skill.id === "mcp-setup"
        ? escapeXml(getMcpSetupDescription())
        : escapeXml(skill.description);
    const credAttr = skill.credentialSetupFor
      ? ` credential-setup-for="${escapeXml(skill.credentialSetupFor)}"`
      : "";
    const hintsAttr =
      skill.activationHints && skill.activationHints.length > 0
        ? ` hints="${escapeXml(skill.activationHints.join("; "))}"`
        : "";
    const avoidAttr =
      skill.avoidWhen && skill.avoidWhen.length > 0
        ? ` avoid-when="${escapeXml(skill.avoidWhen.join("; "))}"`
        : "";
    lines.push(
      `<skill id="${idAttr}" name="${nameAttr}" description="${descAttr}"${credAttr}${hintsAttr}${avoidAttr} />`,
    );
  }
  lines.push("</available_skills>");

  return [
    "## Available Skills",
    "Call `skill_load` with a skill's `id` to load its full instructions, then use `skill_execute` to invoke the skill's tools. When a credential is missing, check for a skill with a matching `credential-setup-for` attribute.",
    "",
    lines.join("\n"),
    "",
    "Additional first-party skills: `assistant skills list` / `assistant skills install <id>`.",
  ].join("\n");
}
