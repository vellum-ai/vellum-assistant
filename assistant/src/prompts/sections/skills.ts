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

  sections.push(buildDynamicSkillWorkflowSection(config, flagFiltered));

  return sections.join("\n\n");
}

function buildDynamicSkillWorkflowSection(
  _config: import("../../config/schema.js").AssistantConfig,
  activeSkills: SkillSummary[],
): string {
  const lines = [
    "## Dynamic Skill Authoring Workflow",
    "",
    "When no existing tool or skill can satisfy a request:",
    "1. Validate the gap — confirm no existing tool/skill covers it.",
    "2. Draft a TypeScript snippet exporting a `default` or `run` function (`(input: unknown) => unknown | Promise<unknown>`).",
    '3. Test the snippet by writing it to a temp file with `bash` (e.g., `bash command="mkdir -p /tmp/vellum-eval && cat > /tmp/vellum-eval/snippet.ts << \'SNIPPET_EOF\'\\n...\\nSNIPPET_EOF"`) and running it with `bash command="bun run /tmp/vellum-eval/snippet.ts"`. Do not use `file_write` for temp files outside the working directory. Iterate until it passes (max 3 attempts, then ask the user). Clean up temp files after.',
    "4. Persist with `scaffold_managed_skill` only after user consent.",
    "5. Load with `skill_load` before use.",
    "",
    "**Never persist or delete skills without explicit user confirmation.** To remove: `delete_managed_skill`.",
    "After a skill is written or deleted, the next turn may run in a recreated session due to file-watcher eviction. Continue normally.",
  ];

  const activeSkillIds = new Set(activeSkills.map((s) => s.id));

  if (activeSkillIds.has("browser")) {
    lines.push(
      "",
      "### Browser Skill Prerequisite",
      'If you need browser capabilities (navigating web pages, clicking elements, extracting content) and `browser_*` tools are not available, load the "browser" skill first using `skill_load`.',
    );
  }

  if (activeSkillIds.has("messaging")) {
    lines.push(
      "",
      "### Messaging Skill",
      'When the user asks about email, messaging, inbox management, or wants to read/send/search messages on any platform (Gmail, Slack, Telegram), load the "messaging" skill using `skill_load`. The messaging skill handles connection setup, credential flows, and all messaging operations — do not improvise setup instructions from general knowledge.',
    );
  }

  return lines.join("\n");
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
    const locAttr = escapeXml(skill.directoryPath);
    const credAttr = skill.credentialSetupFor
      ? ` credential-setup-for="${escapeXml(skill.credentialSetupFor)}"`
      : "";
    lines.push(
      `<skill id="${idAttr}" name="${nameAttr}" description="${descAttr}" location="${locAttr}"${credAttr} />`,
    );
  }
  lines.push("</available_skills>");

  return [
    "## Available Skills",
    "The following skills are available. Before executing one, call the `skill_load` tool with its `id` to load the full instructions.",
    "When a credential is missing, check if any skill declares `credential-setup-for` matching that service — if so, load that skill.",
    "",
    lines.join("\n"),
    "",
    "### Installing additional skills",
    "If `skill_load` fails because a skill is not found, additional first-party skills may be available in the Vellum catalog.",
    "Use `bash` to discover and install them:",
    "- `assistant skills list` — list all available catalog skills",
    "- `assistant skills install <skill-id>` — install a skill, then retry `skill_load`",
  ].join("\n");
}
