import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { getBundledSkillsDir } from "../config/skills.js";
import { getRootDir } from "../util/platform.js";

export interface DefaultRuleTemplate {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: "allow" | "deny" | "ask";
  priority: number;
  allowHighRisk?: boolean;
}

const HOST_FILE_TOOLS = [
  "host_file_read",
  "host_file_write",
  "host_file_edit",
] as const;
const COMPUTER_USE_TOOLS = [
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_key",
  "computer_use_scroll",
  "computer_use_drag",
  "computer_use_wait",
  "computer_use_open_app",
  "computer_use_run_applescript",
  // computer_use_done and computer_use_respond are terminal signal tools
  // (RiskLevel.Low) — they don't perform any computer action, so they
  // should NOT get an 'ask' rule.
] as const;

/**
 * Returns default trust rules shipped with the assistant.
 * Computed at runtime so paths reflect the configured root directory.
 */
export function getDefaultRuleTemplates(): DefaultRuleTemplate[] {
  // Some test suites mock getConfig() with partial objects; treat missing
  // branches as defaults so rule generation remains deterministic.
  const config = getConfig() as {
    sandbox?: { enabled?: boolean };
    skills?: { load?: { extraDirs?: unknown } };
  };

  const hostFileRules = HOST_FILE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:/**`,
    scope: "everywhere",
    decision: "ask" as const,
    priority: 50,
  }));

  // host_bash command candidates are raw commands ("ls", "npm test"), so the
  // global default rule uses "**" (globstar) instead of a "tool:*" prefix
  // because commands often contain "/" (e.g. "cat /etc/hosts").
  const hostShellRule: DefaultRuleTemplate = {
    id: "default:ask-host_bash-global",
    tool: "host_bash",
    pattern: "**",
    scope: "everywhere",
    decision: "ask",
    priority: 50,
  };

  // Sandboxed bash commands run in an isolated container — auto-allow all of
  // them (including high-risk) so the user is never prompted for sandbox work.
  // Only emit this rule when the sandbox is actually enabled; otherwise bash
  // commands execute on the host and must go through normal permission checks.
  const sandboxEnabled = config.sandbox?.enabled !== false;
  const sandboxShellRule: DefaultRuleTemplate | null = sandboxEnabled
    ? {
        id: "default:allow-bash-global",
        tool: "bash",
        pattern: "**",
        scope: "everywhere",
        decision: "allow",
        priority: 50,
        allowHighRisk: true,
      }
    : null;

  // Standalone "**" globstar — minimatch only treats ** as globstar when it is
  // its own path segment, so a "tool:**" prefix would collapse to single-star
  // behavior and fail to match candidates containing "/".  The tool is already
  // filtered by `findHighestPriorityRule` (rule.tool !== tool), so a prefix is
  // unnecessary.
  const computerUseRules = COMPUTER_USE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: "**",
    scope: "everywhere",
    decision: "ask" as const,
    priority: 1000,
  }));

  // Managed skill authoring tools — scaffold and delete modify ~/.vellum/workspace/skills/
  // and should require explicit user approval.
  const MANAGED_SKILL_TOOLS = [
    "scaffold_managed_skill",
    "delete_managed_skill",
  ] as const;
  const managedSkillRules = MANAGED_SKILL_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:*`,
    scope: "everywhere",
    decision: "ask" as const,
    priority: 1000,
  }));

  // Workspace prompt files — the agent should always be able to read, edit,
  // and write these without prompting.  Also allow `rm BOOTSTRAP.md` so the
  // agent can delete it at the end of the onboarding ritual.
  const workspaceDir = join(getRootDir(), "workspace").replaceAll("\\", "/");
  const WORKSPACE_PROMPT_FILES = [
    "IDENTITY.md",
    "USER.md",
    "SOUL.md",
    "BOOTSTRAP.md",
    "UPDATES.md",
  ] as const;
  const WORKSPACE_FILE_TOOLS = [
    "file_read",
    "file_write",
    "file_edit",
  ] as const;
  const workspacePromptRules = WORKSPACE_FILE_TOOLS.flatMap((tool) =>
    WORKSPACE_PROMPT_FILES.map((file) => ({
      id: `default:allow-${tool}-${file.toLowerCase().replace(".md", "")}`,
      tool,
      pattern: `${tool}:${workspaceDir}/${file}`,
      scope: "everywhere",
      decision: "allow" as const,
      priority: 100,
    })),
  );

  const bootstrapDeleteRule: DefaultRuleTemplate = {
    id: "default:allow-bash-rm-bootstrap",
    tool: "bash",
    pattern: "rm BOOTSTRAP.md",
    scope: workspaceDir,
    decision: "allow",
    priority: 100,
    allowHighRisk: true,
  };

  const updatesDeleteRule: DefaultRuleTemplate = {
    id: "default:allow-bash-rm-updates",
    tool: "bash",
    pattern: "rm UPDATES.md",
    scope: workspaceDir,
    decision: "allow",
    priority: 100,
    allowHighRisk: true,
  };

  // Skill source directories — writing or editing skill source files should
  // require explicit user approval so a compromised agent loop cannot silently
  // modify skill code to escalate privileges.
  const managedSkillsDir = join(getRootDir(), "workspace", "skills").replaceAll(
    "\\",
    "/",
  );
  const bundledSkillsDir = getBundledSkillsDir().replaceAll("\\", "/");
  const SKILL_MUTATION_TOOLS = ["file_write", "file_edit"] as const;
  const skillDirs: { dir: string; label: string }[] = [
    { dir: managedSkillsDir, label: "managed" },
    { dir: bundledSkillsDir, label: "bundled" },
  ];

  // Append any user-configured extra skill directories so they get the
  // same default ask rules as managed and bundled dirs.
  const rawExtraDirs = config.skills?.load?.extraDirs;
  const extraDirs = Array.isArray(rawExtraDirs)
    ? rawExtraDirs.filter((dir): dir is string => typeof dir === "string")
    : [];
  for (let i = 0; i < extraDirs.length; i++) {
    skillDirs.push({
      dir: extraDirs[i].replaceAll("\\", "/"),
      label: `extra-${i}`,
    });
  }

  const skillSourceMutationRules = skillDirs.flatMap(({ dir, label }) =>
    SKILL_MUTATION_TOOLS.map((tool) => ({
      id: `default:ask-${tool}-${label}-skills`,
      tool,
      pattern: `${tool}:${dir}/**`,
      scope: "everywhere",
      decision: "ask" as const,
      priority: 50,
    })),
  );

  const skillLoadRule: DefaultRuleTemplate = {
    id: "default:allow-skill_load-global",
    tool: "skill_load",
    pattern: "skill_load:*",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
  };

  const skillExecuteRule: DefaultRuleTemplate = {
    id: "default:allow-skill_execute-global",
    tool: "skill_execute",
    pattern: "skill_execute:*",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
  };

  // Browser tools were previously core-registered with RiskLevel.Low (auto-allowed).
  // After migration to skill-provided tools, default allow rules preserve the
  // same frictionless UX so they don't trigger permission prompts.
  // browser_navigate candidates contain URLs with "/" (e.g.
  // "browser_navigate:https://example.com/path"), so it needs standalone
  // "**" globstar (same as host_bash / computer_use_*).  The tool field
  // already filters by tool name, so a prefix is unnecessary.
  const browserNavigateRule: DefaultRuleTemplate = {
    id: "default:allow-browser_navigate-global",
    tool: "browser_navigate",
    pattern: "**",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
  };

  const BROWSER_TOOLS_NO_SLASH = [
    "browser_snapshot",
    "browser_screenshot",
    "browser_close",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_scroll",
    "browser_select_option",
    "browser_hover",
    "browser_wait_for",
    "browser_extract",
    "browser_wait_for_download",
    "browser_fill_credential",
  ] as const;

  const browserToolRules: DefaultRuleTemplate[] = BROWSER_TOOLS_NO_SLASH.map(
    (tool) => ({
      id: `default:allow-${tool}-global`,
      tool,
      pattern: `${tool}:*`,
      scope: "everywhere",
      decision: "allow" as const,
      priority: 100,
    }),
  );

  // ui_update and ui_dismiss are purely passive operations (modify/remove existing
  // surfaces). ui_show is excluded because it can create forms that collect user
  // input — it goes through normal permission checking instead.
  const UI_SURFACE_TOOLS = ["ui_update", "ui_dismiss"] as const;
  const uiSurfaceRules: DefaultRuleTemplate[] = UI_SURFACE_TOOLS.map(
    (tool) => ({
      id: `default:allow-${tool}-global`,
      tool,
      pattern: `${tool}:*`,
      scope: "everywhere",
      decision: "allow" as const,
      priority: 100,
    }),
  );

  // memory_recall is a read-only tool — always allow without prompting.
  const memoryRecallRule: DefaultRuleTemplate = {
    id: "default:allow-memory_recall-global",
    tool: "memory_recall",
    pattern: "memory_recall:*",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
  };

  return [
    ...hostFileRules,
    hostShellRule,
    ...(sandboxShellRule ? [sandboxShellRule] : []),
    ...computerUseRules,
    ...managedSkillRules,
    ...workspacePromptRules,
    bootstrapDeleteRule,
    updatesDeleteRule,
    ...skillSourceMutationRules,
    skillLoadRule,
    skillExecuteRule,
    browserNavigateRule,
    ...browserToolRules,
    ...uiSurfaceRules,
    memoryRecallRule,
  ];
}
