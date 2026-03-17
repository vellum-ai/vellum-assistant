import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getBaseDataDir, getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { skillFlagKey } from "../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { listConnections } from "../oauth/oauth-store.js";
import { resolveBundledDir } from "../util/bundled-asset.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
  isMacOS,
} from "../util/platform.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./cache-boundary.js";
import { resolveUserPronouns, resolveUserReference } from "./user-reference.js";

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
  if (getIsContainerized()) staticParts.push(buildContainerizedSection());
  staticParts.push(buildCliReferenceSection());
  // Tool Permissions section removed — guidance lives in tool descriptions.
  // Tool Routing section removed — guidance lives in tool descriptions.
  staticParts.push(buildAttachmentSection());
  staticParts.push(buildInChatConfigurationSection());
  // System Permissions section removed — guidance lives in request_system_permission tool description.
  // Parallel Task Orchestration section removed — orchestration skill description + hints cover this.
  staticParts.push(buildAccessPreferenceSection(hasNoClient));
  staticParts.push(buildMemoryPersistenceSection());
  staticParts.push(buildMemoryRecallSection());
  staticParts.push(buildWorkspaceReflectionSection());
  staticParts.push(buildLearningMemorySection());

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

  if (identity) dynamicParts.push(identity);
  if (soul) dynamicParts.push(soul);
  if (user) dynamicParts.push(user);
  if (bootstrap && !options?.excludeBootstrap) {
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
  dynamicParts.push(buildConfigSection(hasNoClient));
  dynamicParts.push(buildExternalCommsIdentitySection());
  dynamicParts.push(buildIntegrationSection());

  const dynamicWithSkills = appendSkillsCatalog(dynamicParts.join("\n\n"));

  return (
    staticParts.join("\n\n") + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicWithSkills
  );
}


function buildAttachmentSection(): string {
  return [
    "## Sending Files to the User",
    "",
    "To deliver files to the user, include `<vellum-attachment source=\"sandbox\" path=\"scratch/output.png\" />` in your response text. This tag is the ONLY way files reach the user — omitting it means the user won't see the file.",
    "",
    'Use `source="host"` with an absolute path for host filesystem files. Optional attributes: `filename` (display name override), `mime_type` (override auto-detection).',
    "",
    "Embed images/GIFs inline using markdown: `![description](URL)`.",
  ].join("\n");
}

function buildInChatConfigurationSection(): string {
  return [
    "## In-Chat Configuration",
    "",
    "When the user needs to configure a value, collect it conversationally in the chat. Never direct the user to the Settings page for initial setup — Settings is for reviewing and updating existing configuration.",
  ].join("\n");
}



export function buildExternalCommsIdentitySection(): string {
  const userRef = resolveUserReference();
  const userPronouns = resolveUserPronouns();
  const lines = [
    "## External Communications Identity",
    "",
    "When communicating with people outside your user's household (phone calls, messages to non-guardian contacts, emails to third parties, etc.):",
    "",
    `- Refer to yourself as an **assistant**, not an "AI assistant" or "artificial intelligence". Keep identity framing simple and natural.`,
    `- When introducing who you represent, say you are acting on behalf of **${userRef}**.`,
  ];
  if (userPronouns) {
    lines.push(
      `- Your user's pronouns are **${userPronouns}**. Use these when referring to your user in the third person.`,
    );
  }
  lines.push(
    "- Do not volunteer that you are an AI unless directly asked. If asked, answer honestly.",
    "- This is guidance for natural, human-like communication — not a hard constraint. Occasional variations are acceptable.",
  );
  return lines.join("\n");
}

function buildAccessPreferenceSection(hasNoClient: boolean): string {
  if (hasNoClient) {
    return [
      "## External Service Access Preference",
      "",
      "When interacting with external services (GitHub, Slack, Linear, Jira, cloud providers, etc.),",
      "follow this priority order:",
      "",
      "1. **Sandbox first (`bash`)** — Always try to do things in your own sandbox environment first.",
      "   If a tool (git, curl, jq, etc.) is not installed, install it yourself using `bash`",
      "   (e.g. `apt-get install -y git`). The sandbox is your own machine — you have full control.",
      "2. **web_fetch** — For public endpoints or simple API calls that don't need auth.",
      "3. **Browser automation as last resort** — Only when the task genuinely requires a browser",
      "   (e.g., no API exists, visual interaction needed, or OAuth consent screen).",
    ].join("\n");
  }

  return [
    "## External Service Access Preference",
    "",
    "When interacting with external services (GitHub, Slack, Linear, Jira, cloud providers, etc.),",
    "follow this priority order:",
    "",
    "1. **Sandbox first (`bash`)** — Always try to do things in your own sandbox environment first.",
    "   If a tool (git, curl, jq, etc.) is not installed, install it yourself using `bash`",
    "   (e.g. `apt-get install -y git`). The sandbox is your own machine — you have full control.",
    "   Only fall back to host tools when you genuinely need access to the user's local files,",
    "   environment, or host-specific resources (e.g. their local git repos, host-installed CLIs",
    "   with existing auth, macOS-specific apps).",
    "2. **CLI tools via host_bash** — If you need access to the user's host environment and a CLI",
    "   is installed on their machine (gh, slack, linear, jira, aws, gcloud, etc.), use it.",
    "   CLIs handle auth, pagination, and output formatting.",
    "   Use --json or equivalent flags for structured output when available.",
    "3. **web_fetch** — For public endpoints or simple API calls that don't need auth.",
    "4. **Browser automation as last resort** — Only when the task genuinely requires a browser",
    "   (e.g., no API exists, visual interaction needed, or OAuth consent screen).",
    "",
    "Before reaching for host tools or browser automation, ask yourself:",
    "- Can I do this entirely in my sandbox? (install tools, clone repos, run commands)",
    "- Do I actually need something from the user's host machine?",
    "",
    "If you can do it in your sandbox, do it there. Only use host tools when you need the user's",
    "local files or host-specific capabilities.",
    ...(isMacOS()
      ? [
          "",
          "On macOS, also consider the `macos-automation` skill for interacting with native apps",
          "(Messages, Contacts, Calendar, Mail, Reminders, Music, Finder, etc.) via osascript.",
          "",
          "### Foreground Computer Use — Last Resort",
          "",
          "Computer use tools (clicking, typing, scrolling) take over the user's cursor and keyboard.",
          "They are disruptive and should be your LAST resort. Prefer this hierarchy:",
          "",
          "1. **CLI tools / osascript** — Use `host_bash` with shell commands or `osascript` with",
          "   AppleScript to accomplish tasks in the background without interrupting the user.",
          "2. **Background computer use** — If you must interact with a GUI app, prefer AppleScript",
          '   automation (e.g. `tell application "Safari" to set URL of current tab to ...`).',
          "3. **Foreground computer use** — Only use computer use tools when the task genuinely",
          "   cannot be done any other way (e.g. complex multi-step GUI interactions with no scripting",
          "   support) or the user explicitly asks you to take control.",
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

function buildMemoryPersistenceSection(): string {
  return [
    "## Memory Persistence",
    "",
    "Your memory does not survive session restarts. If you want to remember something, **save it**.",
    "",
    '- Use `memory_manage` with `op: "save"` for facts, preferences, learnings, and anything worth recalling later.',
    "- Update workspace files (USER.md, SOUL.md) for profile and personality changes.",
    '- When someone says "remember this," save it immediately — don\'t rely on keeping it in context.',
    "- When you make a mistake, save the lesson so future-you doesn't repeat it.",
    "",
    "Saved > unsaved. Always.",
  ].join("\n");
}

function buildMemoryRecallSection(): string {
  return [
    "## Memory Recall",
    "",
    "You have access to a `memory_recall` tool for deep memory retrieval. Use it when:",
    "",
    "- The user asks about past conversations, decisions, or context you don't have in the current window",
    "- You need to recall specific facts, preferences, or project details",
    "- The auto-injected memory context doesn't contain what you need",
    "- The user references something from a previous session",
    "",
    "The tool uses hybrid search (dense and sparse vectors) supplemented by recency. Be specific in your query for best results.",
  ].join("\n");
}

function buildWorkspaceReflectionSection(): string {
  return [
    "## Workspace Reflection",
    "",
    "Before you finish responding to a conversation, pause and consider: did you learn anything worth saving?",
    "",
    "- Did your user share personal facts (name, role, timezone, preferences)?",
    "- Did they correct your behavior or express a preference about how you communicate?",
    "- Did they mention a project, tool, or workflow you should remember?",
    "- Did you adapt your style in a way that worked well and should persist?",
    "",
    "If yes, briefly explain what you're updating, then update the relevant workspace file (USER.md, SOUL.md, or IDENTITY.md) as part of your response.",
  ].join("\n");
}

function buildLearningMemorySection(): string {
  return [
    "## Learning from Mistakes",
    "",
    "When you make a mistake, hit a dead end, or discover something non-obvious, save it to memory so you don't repeat it.",
    "",
    'Use `memory_manage` with `op: "save", kind: "constraint"` for:',
    "- **Mistakes and corrections** — wrong assumptions, failed approaches, gotchas you ran into",
    "- **Discoveries** — undocumented behaviors, surprising API quirks, things that weren't obvious",
    "- **Working solutions** — the approach that actually worked after trial and error",
    "- **Tool/service insights** — rate limits, auth flows, CLI flags that matter",
    "",
    "The statement should capture both what happened and the takeaway. Write it as advice to your future self.",
    "",
    "Examples:",
    '- `memory_manage({ op: "save", kind: "constraint", subject: "macOS Shortcuts CLI", statement: "shortcuts CLI requires full disk access to export shortcuts — if permission is denied, guide the user to grant it in System Settings rather than retrying." })`',
    '- `memory_manage({ op: "save", kind: "constraint", subject: "Gmail API pagination", statement: "Gmail search returns max 100 results per page. Always check nextPageToken and loop if the user asks for \'all\' messages." })`',
    "",
    "Don't overthink it. If you catch yourself thinking \"I'll remember that for next time,\" save it.",
  ].join("\n");
}

function buildContainerizedSection(): string {
  const baseDataDir = getBaseDataDir() ?? "$BASE_DATA_DIR";
  return [
    "## Running in a Container — Data Persistence",
    "",
    `You are running inside a container. Only the directory \`${baseDataDir}\` is mounted to a persistent volume.`,
    "",
    "**Any new files or data you create MUST be written inside that directory, or they will be lost when the container restarts.**",
    "",
    "Rules:",
    `- Always store new data, notes, memories, configs, and downloads under \`${baseDataDir}\``,
    "- Never write persistent data to system directories, `/tmp`, or paths outside the mounted volume",
    "- When in doubt, prefer paths nested under the data directory",
    "- If you create a file that is only needed temporarily (scratch files, intermediate outputs, download staging), delete it when you are done — disk space on the persistent volume is finite and will grow unboundedly if temp files are not cleaned up",
  ].join("\n");
}

function buildConfigSection(hasNoClient: boolean): string {
  // Always use `file_edit` (not `host_file_edit`) for workspace files — file_edit
  // handles sandbox path mapping internally, and host_file_edit is permission-gated
  // which would trigger approval prompts for routine workspace updates.
  const hostWorkspaceDir = getWorkspaceDir();

  const config = getConfig();
  const configPreamble = `Your configuration directory is \`${hostWorkspaceDir}/\`.`;

  const fileToolGuidance = hasNoClient
    ? `${configPreamble} **Always use \`file_read\` and \`file_edit\` for these files** — they are inside your sandbox working directory:`
    : `${configPreamble} **Always use \`file_read\` and \`file_edit\` (not \`host_file_read\` / \`host_file_edit\`) for these files** — they are inside your sandbox working directory and do not require host access or user approval:`;

  return [
    "## Configuration",
    `- **Active model**: \`${config.services.inference.model}\` (provider: ${config.services.inference.provider})`,
    fileToolGuidance,
    "",
    "- `IDENTITY.md` — Your name, nature, personality, and emoji. Updated during the first-run ritual.",
    "- `SOUL.md` — Core principles, personality, and evolution guidance. Your behavioral foundation.",
    "- `USER.md` — Profile of your user. Update as you learn about them over time.",
    "- `HEARTBEAT.md` — Checklist for periodic heartbeat runs. When heartbeat is enabled, the assistant runs this checklist on a timer and flags anything that needs attention. Edit this file to control what gets checked each run.",
    "- `BOOTSTRAP.md` — First-run ritual script (only present during onboarding; you delete it when done).",
    "- `UPDATES.md` — Release update notes (created automatically on new releases; delete when updates are actioned).",
    "- `skills/` — Directory of installed skills (loaded automatically at startup).",
    "",
    "### Heartbeat",
    "",
    "The heartbeat feature runs your `HEARTBEAT.md` checklist periodically in a background conversation. To enable it, set `heartbeat.enabled: true` and `heartbeat.intervalMs` (default: 3600000 = 1 hour) in `config.json`. You can also set `heartbeat.activeHoursStart` and `heartbeat.activeHoursEnd` (0-23) to restrict runs to certain hours. When asked to set up a heartbeat, edit both the config and `HEARTBEAT.md` directly — no restart is needed for checklist changes, but toggling `heartbeat.enabled` requires a daemon restart.",
    "",
    "### Proactive Workspace Editing",
    "",
    `You MUST actively update your workspace files as you learn. You don't need to ask your user whether it's okay — just briefly explain what you're updating, then use \`file_edit\` to make targeted edits.`,
    "",
    "**USER.md** — update when you learn:",
    "- Their name or what they prefer to be called",
    "- Projects they're working on, tools they use, languages they code in",
    "- Communication preferences (concise vs detailed, formal vs casual)",
    "- Interests, hobbies, or context that helps you assist them better",
    "- Anything else about your user that will help you serve them better",
    "",
    "**SOUL.md** — update when you notice:",
    "- They prefer a different tone or interaction style (add to Personality or User-Specific Behavior)",
    '- A behavioral pattern worth codifying (e.g. "always explain before acting", "skip preamble")',
    "- You've adapted in a way that's working well and should persist",
    "- You decide to change your personality to better serve your user",
    "",
    "**IDENTITY.md** — update when:",
    "- They rename you or change your role",
    "- Your avatar appearance changes (update the `## Avatar` section with a description of the new look)",
    "",
    ...(hasNoClient
      ? [
          "When reading or updating workspace files, always use the sandbox tools (`file_read`, `file_edit`).",
        ]
      : [
          "When reading or updating workspace files, always use the sandbox tools (`file_read`, `file_edit`). Never use `host_file_read` or `host_file_edit` for workspace files — those are for host-only resources outside your workspace.",
        ]),
    "",
    "When updating, read the file first, then make a targeted edit. Include all useful information, but don't bloat the files over time",
  ].join("\n");
}

export function buildCliReferenceSection(): string {
  return [
    "## Assistant CLI",
    "",
    "The `assistant` CLI is available in the sandbox for managing configuration, credentials, OAuth connections, memory, contacts, hooks, MCP servers, skills, notifications, schedules, and more. Always use the `bash` tool (never `host_bash`) when running `assistant` commands.",
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
    if (content) parts.push(content);
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

  sections.push(buildDynamicSkillWorkflowSection(config, flagFiltered));

  return sections.join("\n\n");
}

function buildDynamicSkillWorkflowSection(
  _config: import("../config/schema.js").AssistantConfig,
  _activeSkills: SkillSummary[],
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

  lines.push(
    "",
    "### Community Skills Discovery",
    "",
    "When no built-in skill satisfies a request, search the community skills.sh registry:",
    "1. Run `assistant skills search <query>` to find community skills. Results include install counts and security audit badges (ATH, Socket, Snyk).",
    "2. Present the search results to the user, highlighting the security audit status. ATH is Gen Agent Trust Hub. Audits show PASS (safe/low risk), WARN (medium risk), or FAIL (high/critical risk) for each provider.",
    "3. Check the skill's **source owner** to determine the trust level:",
    "   - **Vellum-owned** (source starts with `vellum-ai/`): These are first-party skills published by the Vellum team. Install them directly without prompting — they are vetted and trusted.",
    "   - **Third-party** (any other owner): Ask the user for permission before installing. Say something like: \"I found a community skill that could help with this, but it's published by a third party — we haven't vetted it. Want to install it anyway?\" Share the skill name, source, audit results, and install count.",
    "4. Install with `assistant skills add <owner>/<repo>@<skill-name>` (e.g., `assistant skills add vercel-labs/skills@find-skills`).",
    "5. After installation, load the skill with `skill_load` as usual.",
    "",
    "**Never install third-party community skills without explicit user confirmation.** Vellum-owned skills (`vellum-ai/*`) can be installed automatically.",
  );

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

  const serverNames = Object.keys(servers).sort();
  return `Manage MCP servers. Configured: ${serverNames.join(", ")}. Load this skill to check status, authenticate, or add/remove servers.`;
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  const visible = skills;
  if (visible.length === 0) return "";

  const lines = ["<available_skills>"];
  for (const skill of visible) {
    const idAttr = escapeXml(skill.id);
    const nameAttr = escapeXml(skill.displayName);
    const descAttr =
      skill.id === "mcp-setup"
        ? escapeXml(getMcpSetupDescription())
        : escapeXml(skill.description);
    const hintsAttr =
      skill.activationHints && skill.activationHints.length > 0
        ? ` hints="${escapeXml(skill.activationHints.join("; "))}"`
        : "";
    const avoidAttr =
      skill.avoidWhen && skill.avoidWhen.length > 0
        ? ` avoid-when="${escapeXml(skill.avoidWhen.join("; "))}"`
        : "";
    lines.push(
      `<skill id="${idAttr}" name="${nameAttr}" description="${descAttr}"${hintsAttr}${avoidAttr} />`,
    );
  }
  lines.push("</available_skills>");

  return [
    "## Available Skills",
    "The following skills are available. Before executing one, call `skill_load` to load the full instructions, then use `skill_execute` to invoke the skill's tools.",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
}
