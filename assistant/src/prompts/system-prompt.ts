import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getBaseDataDir, getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { skillFlagKey } from "../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { countConversations } from "../memory/conversation-queries.js";
import { listConnections } from "../oauth/oauth-store.js";
import { resolveBundledDir } from "../util/bundled-asset.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath, isMacOS } from "../util/platform.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./cache-boundary.js";

export { SYSTEM_PROMPT_CACHE_BOUNDARY };

const log = getLogger("system-prompt");

const PROMPT_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

/**
 * Copy template prompt files into the data directory if they don't already exist.
 * Called once during daemon startup so users always have discoverable files to edit.
 *
 * BOOTSTRAP.md is handled separately: it is only created when *none* of the core
 * prompt files existed beforehand (a truly fresh install).  This prevents the
 * daemon from recreating the file on every restart after the user deletes it to
 * signal that onboarding is complete.
 */
export function ensurePromptFiles(): void {
  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );

  // Track whether this is a fresh workspace (no core prompt files exist yet).
  const isFirstRun = PROMPT_FILES.every(
    (file) => !existsSync(getWorkspacePromptPath(file)),
  );

  for (const file of PROMPT_FILES) {
    const dest = getWorkspacePromptPath(file);
    if (existsSync(dest)) continue;

    const src = join(templatesDir, file);
    try {
      if (!existsSync(src)) {
        log.warn({ src }, "Prompt template not found, skipping");
        continue;
      }
      copyFileSync(src, dest);
      log.info({ file, dest }, "Created prompt file from template");
    } catch (err) {
      log.warn({ err, file }, "Failed to create prompt file from template");
    }
  }

  // Only seed BOOTSTRAP.md on a truly fresh install so that deleting it
  // reliably signals onboarding completion across daemon restarts.
  if (isFirstRun) {
    const bootstrapDest = getWorkspacePromptPath("BOOTSTRAP.md");
    if (!existsSync(bootstrapDest)) {
      const bootstrapSrc = join(templatesDir, "BOOTSTRAP.md");
      try {
        if (existsSync(bootstrapSrc)) {
          copyFileSync(bootstrapSrc, bootstrapDest);
          log.info(
            { file: "BOOTSTRAP.md", dest: bootstrapDest },
            "Created BOOTSTRAP.md for first-run onboarding",
          );
        }
      } catch (err) {
        log.warn(
          { err, file: "BOOTSTRAP.md" },
          "Failed to create BOOTSTRAP.md from template",
        );
      }
    }
  }
}

/**
 * Build the system prompt from ~/.vellum prompt files,
 * then append a generated skills catalog (if any skills are available).
 *
 * Composition:
 *   1. Base prompt: IDENTITY.md + SOUL.md (guaranteed to exist after ensurePromptFiles)
 *   2. Append USER.md (user profile)
 *   3. If BOOTSTRAP.md exists, append first-run ritual instructions
 *   4. Append skills catalog from ~/.vellum/workspace/skills
 */
export interface BuildSystemPromptOptions {
  hasNoClient?: boolean;
  excludeBootstrap?: boolean;
}

/**
 * Sentinel that separates the static instruction prefix (stable across turns)
 * from the dynamic workspace suffix (changes when workspace files are edited).
 *
 * The Anthropic provider splits on this marker to create two system-prompt
 * cache blocks so that static instructions stay cached even when workspace
 * files change between turns.
 */
export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  const hasNoClient = options?.hasNoClient ?? false;

  // ── Static instruction sections (stable across turns) ──
  // These sections are deterministic within a process lifetime.  They form
  // the first cache block so they remain cached even when workspace files
  // (IDENTITY.md, SOUL.md, USER.md, etc.) are edited between turns.
  const staticParts: string[] = [];
  staticParts.push(buildParallelToolCallsSection());
  if (getIsContainerized()) staticParts.push(buildContainerizedSection());
  staticParts.push(buildCliReferenceSection());
  // Tool Permissions section removed — guidance lives in tool descriptions.
  // Tool Routing section removed — guidance lives in tool descriptions.
  staticParts.push(buildAttachmentSection());
  staticParts.push(buildInChatConfigurationSection());
  // System Permissions section removed — guidance lives in request_system_permission tool description.
  // Parallel Task Orchestration section removed — orchestration skill description + hints cover this.
  staticParts.push(buildAccessPreferenceSection(hasNoClient));
  // Memory Persistence, Memory Recall, Workspace Reflection, Learning from Mistakes
  // sections removed — guidance lives in memory_manage/memory_recall tool descriptions
  // and the Proactive Workspace Editing subsection in Configuration.

  // ── Dynamic sections (may change between turns) ──
  // Workspace files, config, external comms identity, connected services,
  // and skills catalog are all re-read from disk/DB each turn.  They form
  // the second cache block.
  const dynamicParts: string[] = [];

  const soulPath = getWorkspacePromptPath("SOUL.md");
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  const userPath = getWorkspacePromptPath("USER.md");
  const bootstrapPath = getWorkspacePromptPath("BOOTSTRAP.md");
  const updatesPath = getWorkspacePromptPath("UPDATES.md");

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);
  const user = readPromptFile(userPath);
  const bootstrap = readPromptFile(bootstrapPath);
  const updates = readPromptFile(updatesPath);

  // Only include BOOTSTRAP.md when there are zero existing conversations
  // (truly first-time user).  Once the user has any conversation history,
  // bootstrap is suppressed so it doesn't re-trigger on new threads — even
  // if the user skipped or ignored onboarding.
  let includeBootstrap = !!bootstrap && !options?.excludeBootstrap;
  if (includeBootstrap) {
    try {
      if (countConversations() > 0) {
        includeBootstrap = false;
      }
    } catch {
      // DB not ready yet (e.g. during early startup) — fall back to
      // including bootstrap if the file exists.
    }
  }

  // Template prompt files contain placeholder fields and meta-instructions
  // meant for the assistant to fill in during onboarding.  When included
  // verbatim in the system prompt, the model can leak internal details and
  // narrate its own setup process instead of following the BOOTSTRAP.md
  // ritual.  Detect unmodified templates by comparing against the bundled
  // source and skip them — SOUL.md provides sufficient personality defaults
  // until onboarding completes.
  const identityIsTemplate = isTemplateContent(identity, "IDENTITY.md");
  const userIsTemplate = isTemplateContent(user, "USER.md");

  if (identity && !identityIsTemplate) {
    dynamicParts.push(identity);
  }
  if (soul) dynamicParts.push(soul);
  if (user && !userIsTemplate) dynamicParts.push(user);
  if (includeBootstrap) {
    dynamicParts.push(
      "# First-Run Ritual\n\n" +
        "BOOTSTRAP.md is present — this is your first conversation. Follow its instructions.\n\n" +
        bootstrap,
    );
  }
  if (updates) {
    dynamicParts.push(
      [
        "## Recent Updates",
        "",
        updates,
        "",
        "### Update Handling",
        "",
        "Use your judgment to decide when and how to surface updates to the user:",
        "- Inform the user about updates that are relevant to what they are doing or asking about.",
        "- Apply assistant-relevant changes (e.g., new tools, behavior adjustments) without forced announcement.",
        "- Do not interrupt the user with updates unprompted — weave them naturally into conversation when relevant.",
        "- When you are satisfied all updates have been actioned or communicated, delete `UPDATES.md` to signal completion.",
      ].join("\n"),
    );
  }
  // Configuration section removed — workspace files are self-describing,
  // tool routing lives in tool descriptions.
  // External Communications Identity removed — guidance lives in messaging
  // and phone-calls skill SKILL.md files.
  const integrationSection = buildIntegrationSection();
  if (integrationSection) dynamicParts.push(integrationSection);

  const dynamicWithSkills = appendSkillsCatalog(dynamicParts.join("\n\n"));

  return (
    staticParts.join("\n\n") + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicWithSkills
  );
}

function buildAttachmentSection(): string {
  return [
    "## Sending Files to the User",
    "",
    'To deliver files to the user, include `<vellum-attachment source="sandbox" path="scratch/output.png" />` in your response text. This tag is the ONLY way files reach the user - omitting it means the user won\'t see the file.',
    "",
    'Use `source="host"` with an absolute path for host filesystem files. Optional attributes: `filename` (display name override), `mime_type` (override auto-detection).',
    "",
    "Image and video attachments can render inline in chat. If the user asks to preview a media file here, attach it instead of only printing its path.",
    "",
    "Embed images/GIFs inline using markdown: `![description](URL)`.",
  ].join("\n");
}

function buildInChatConfigurationSection(): string {
  return [
    "## In-Chat Configuration",
    "",
    "When the user needs to configure a value, collect it conversationally in the chat. Never direct the user to the Settings page for initial setup - Settings is for reviewing and updating existing configuration.",
  ].join("\n");
}

function buildAccessPreferenceSection(hasNoClient: boolean): string {
  if (hasNoClient) {
    return [
      "## External Service Access",
      "",
      "Priority: (1) sandbox `bash` — install tools yourself; (2) browser automation as last resort (no API, visual interaction, or OAuth consent).",
    ].join("\n");
  }

  return [
    "## External Service Access",
    "",
    "Priority: (1) sandbox `bash` - install tools yourself, only fall back to host when you need local files/auth; (2) `host_bash` with CLIs (gh, aws, etc.) using --json flags; (3) browser automation as last resort (no API, visual interaction, or OAuth consent).",
    ...(isMacOS()
      ? [
          "",
          "On macOS, prefer osascript/CLI via `host_bash` over computer use tools, which take over the user's cursor. Use foreground computer use only when no scripting alternative exists or the user explicitly asks.",
        ]
      : []),
  ].join("\n");
}

function buildIntegrationSection(): string {
  let connections: { providerKey: string; accountInfo?: string | null }[];
  try {
    connections = listConnections().filter((c) => c.status === "active");
  } catch {
    // DB not available — no connected services to show
    return "";
  }

  if (connections.length === 0) return "";

  const lines = ["## Connected Services", ""];
  for (const conn of connections) {
    const state = conn.accountInfo
      ? `Connected (${conn.accountInfo})`
      : "Connected";
    lines.push(`- **${conn.providerKey}**: ${state}`);
  }

  return lines.join("\n");
}

function buildContainerizedSection(): string {
  const baseDataDir = getBaseDataDir() ?? "$BASE_DATA_DIR";
  return [
    "## Running in a Container - Data Persistence",
    "",
    `You are running inside a container. Only the directory \`${baseDataDir}\` is mounted to a persistent volume.`,
    "",
    "**Any new files or data you create MUST be written inside that directory, or they will be lost when the container restarts.**",
    "",
    "Rules:",
    `- Always store new data, notes, memories, configs, and downloads under \`${baseDataDir}\``,
    "- Never write persistent data to system directories, `/tmp`, or paths outside the mounted volume",
    "- When in doubt, prefer paths nested under the data directory",
    "- If you create a file that is only needed temporarily (scratch files, intermediate outputs, download staging), delete it when you are done - disk space on the persistent volume is finite and will grow unboundedly if temp files are not cleaned up",
  ].join("\n");
}

function buildParallelToolCallsSection(): string {
  return [
    "<use_parallel_tool_calls>",
    "For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like `ls` or `list_dir`, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.",
    "</use_parallel_tool_calls>",
  ].join("\n");
}

export function buildCliReferenceSection(): string {
  return [
    "## Assistant CLI",
    "",
    "The `assistant` CLI is available in the sandbox for managing assistant settings, integrations, and services. Always use the `bash` tool (never `host_bash`) when running `assistant` commands.",
    "",
    "Run `assistant --help` to see all available commands, or `assistant <command> --help` for detailed help on any subcommand.",
  ].join("\n");
}

/**
 * Strip lines starting with `_` (comment convention for prompt .md files)
 * and collapse any resulting consecutive blank lines.
 *
 * Lines inside fenced code blocks (``` or ~~~ delimiters per CommonMark)
 * are never stripped, so code examples with `_`-prefixed identifiers are preserved.
 */
export function stripCommentLines(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  let openFenceChar: string | null = null;
  const filtered = normalized.split("\n").filter((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!openFenceChar) {
        openFenceChar = char;
      } else if (char === openFenceChar) {
        openFenceChar = null;
      }
    }
    if (openFenceChar) return true;
    return !line.trimStart().startsWith("_");
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Returns true when the prompt file content is still the unmodified template
 * shipped with the daemon.  Compares the stripped workspace content against
 * the stripped bundled template source so the check stays accurate even if
 * templates are edited in future releases.
 */
export function isTemplateContent(
  content: string | null,
  templateFileName: string,
): boolean {
  if (content == null) return false;
  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );
  const templatePath = join(templatesDir, templateFileName);
  if (!existsSync(templatePath)) return false;
  try {
    const templateContent = stripCommentLines(
      readFileSync(templatePath, "utf-8"),
    );
    return content === templateContent;
  } catch {
    return false;
  }
}

function readPromptFile(path: string): string | null {
  if (!existsSync(path)) return null;

  try {
    const content = stripCommentLines(readFileSync(path, "utf-8"));
    if (content.length === 0) return null;
    log.debug({ path }, "Loaded prompt file");
    return content;
  } catch (err) {
    log.warn({ err, path }, "Failed to read prompt file");
    return null;
  }
}

/**
 * Reads the core identity/personality prompt files (SOUL.md, IDENTITY.md, USER.md)
 * and concatenates whichever exist. Returns null if none are present.
 *
 * This is useful for injecting identity context into subsystems (e.g. memory
 * extraction) that run outside the main system prompt pipeline.
 */
export function buildCoreIdentityContext(): string | null {
  const parts: string[] = [];
  for (const file of PROMPT_FILES) {
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) continue;
    // SOUL.md is always included — it provides personality defaults even
    // before onboarding completes.  Only skip IDENTITY.md and USER.md when
    // they are still unmodified templates (matching buildSystemPrompt).
    if (file !== "SOUL.md" && isTemplateContent(content, file)) continue;
    parts.push(content);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function appendSkillsCatalog(basePrompt: string): string {
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

  return sections.join("\n\n");
}

/**
 * Build a dynamic description for the mcp-setup skill that includes
 * configured MCP server names, so the model knows which servers exist.
 */
function getMcpSetupDescription(): string {
  const config = getConfig();
  const servers = config.mcp?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return "Add, authenticate, list, and remove MCP servers";
  }

  const serverNames = Object.keys(servers).sort();
  return `Manage MCP servers. Configured: ${serverNames.join(", ")}. Load to check status, authenticate, or add/remove servers.`;
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const lines = ["## Available Skills", ""];
  for (const skill of skills) {
    const desc =
      skill.id === "mcp-setup" ? getMcpSetupDescription() : skill.description;

    // Build a single line: - **id**: description. Hints. Avoid: ...
    const parts = [desc.replace(/\.\s*$/, "")];
    if (skill.activationHints && skill.activationHints.length > 0) {
      parts.push(skill.activationHints.join(". "));
    }
    if (skill.avoidWhen && skill.avoidWhen.length > 0) {
      parts.push(`Avoid: ${skill.avoidWhen.join(". ")}`);
    }
    lines.push(`- **${skill.id}**: ${parts.join(". ")}`);
  }

  return lines.join("\n");
}
