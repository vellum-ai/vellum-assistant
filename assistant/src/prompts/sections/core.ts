import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CLI_HELP_REFERENCE } from "../../cli/reference.js";
import { getBaseDataDir, getIsContainerized } from "../../config/env-registry.js";
import { getConfig } from "../../config/loader.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import { getLogger } from "../../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";

const log = getLogger("system-prompt");

const PROMPT_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

let cachedCliHelp: string | undefined;

/** @internal Reset the CLI help cache — exposed for testing only. */
export function _resetCliHelpCache(): void {
  cachedCliHelp = undefined;
}

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
    "../templates",
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
 * Returns true when BOOTSTRAP.md has been deleted from the workspace,
 * signalling the first-run ritual is complete.
 */
export function isOnboardingComplete(): boolean {
  const bootstrapPath = getWorkspacePromptPath("BOOTSTRAP.md");
  return !existsSync(bootstrapPath);
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

export function readPromptFile(path: string): string | null {
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

export function buildContainerizedSection(): string {
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

export function buildConfigSection(): string {
  // Always use `file_edit` (not `host_file_edit`) for workspace files — file_edit
  // handles sandbox path mapping internally, and host_file_edit is permission-gated
  // which would trigger approval prompts for routine workspace updates.
  const hostWorkspaceDir = getWorkspaceDir();

  const config = getConfig();
  const configPreamble = `Your configuration directory is \`${hostWorkspaceDir}/\`.`;

  return [
    "## Configuration",
    `- **Active model**: \`${config.model}\` (provider: ${config.provider})`,
    `${configPreamble} **Always use \`file_read\` and \`file_edit\` (not \`host_file_read\` / \`host_file_edit\`) for these files** — they are inside your sandbox working directory and do not require host access or user approval:`,
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
    "The heartbeat feature runs your `HEARTBEAT.md` checklist periodically in a background thread. To enable it, set `heartbeat.enabled: true` and `heartbeat.intervalMs` (default: 3600000 = 1 hour) in `config.json`. You can also set `heartbeat.activeHoursStart` and `heartbeat.activeHoursEnd` (0-23) to restrict runs to certain hours. When asked to set up a heartbeat, edit both the config and `HEARTBEAT.md` directly — no restart is needed for checklist changes, but toggling `heartbeat.enabled` requires a daemon restart.",
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
    "When reading or updating workspace files, always use the sandbox tools (`file_read`, `file_edit`). Never use `host_file_read` or `host_file_edit` for workspace files — those are for host-only resources outside your workspace.",
    "",
    "When updating, read the file first, then make a targeted edit. Include all useful information, but don't bloat the files over time",
  ].join("\n");
}

export function buildCliReferenceSection(): string {
  if (cachedCliHelp === undefined) {
    cachedCliHelp = CLI_HELP_REFERENCE.trim();
  }

  return [
    "## Assistant CLI",
    "",
    "The `assistant` CLI is installed on the user's machine and available via `bash`.",
    "For account and authentication work, prefer real `assistant` CLI workflows over any legacy account-record abstraction.",
    "- Use `assistant credentials ...` for stored secrets and credential metadata.",
    "- Use `assistant oauth token <service>` for connected integration tokens.",
    "- Use `assistant mcp auth <name>` when an MCP server needs OAuth login.",
    "- Use `assistant platform status` for platform-linked deployment and auth context.",
    "- If a bundled skill documents a service-specific `assistant <service>` auth or session flow, follow that CLI exactly.",
    "",
    "```",
    cachedCliHelp,
    "```",
    "",
    "Run `assistant <command> --help` for detailed help on any subcommand.",
  ].join("\n");
}
