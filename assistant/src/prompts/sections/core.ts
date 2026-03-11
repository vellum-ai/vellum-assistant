import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getBaseDataDir } from "../../config/env-registry.js";
import { getConfig } from "../../config/loader.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import { getLogger } from "../../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";

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

  return [
    "## Configuration",
    `- **Active model**: \`${config.model}\` (provider: ${config.provider})`,
    `- **Workspace**: \`${hostWorkspaceDir}/\`. **Always use \`file_read\` / \`file_edit\`** (not \`host_file_*\`) for these files — they are inside your sandbox and do not require host approval.`,
    "",
    "Workspace files:",
    "- `IDENTITY.md` — Name, personality, emoji. `SOUL.md` — Behavioral foundation. `USER.md` — User profile.",
    "- `HEARTBEAT.md` — Periodic checklist (enable via `heartbeat.enabled` in `config.json`). `BOOTSTRAP.md` — First-run ritual (delete when done).",
    "- `UPDATES.md` — Release notes (delete when actioned). `skills/` — Installed skills.",
    "",
    "Update workspace files proactively as you learn -- explain briefly what you are updating, then use `file_edit`. Read first, edit targeted, don't bloat.",
  ].join("\n");
}

export function buildCliReferenceSection(): string {
  return [
    "## Assistant CLI",
    "",
    "The `assistant` CLI is available via `bash`. Prefer it for account, auth, and integration work:",
    "- `assistant credentials ...` — stored secrets and credential metadata",
    "- `assistant oauth token <service>` — connected integration tokens",
    "- `assistant mcp auth <name>` — MCP server OAuth login",
    "- `assistant platform status` — platform deployment and auth context",
    "- If a bundled skill documents a service-specific `assistant <service>` flow, follow that CLI exactly.",
    "",
    "Run `assistant --help` for the full command list and `assistant <command> --help` for subcommand details.",
  ].join("\n");
}
