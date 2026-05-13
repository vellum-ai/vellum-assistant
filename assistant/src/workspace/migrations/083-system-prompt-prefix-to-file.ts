/**
 * Workspace migration 083: Move config.systemPromptPrefix to a workspace file.
 *
 * The custom system prompt prefix used to live as a top-level config field
 * (`config.json` → `systemPromptPrefix`).  Editable system-prompt sections
 * now live under `<workspace>/prompts/system/<id>.md`.  This migration
 * carries any existing config value over to `00-prefix.md` and strips the
 * key from `config.json`.
 *
 * Behavior:
 *   - config has non-empty string + 00-prefix.md body is empty → write the
 *     prefix into the file body, preserving the bundled frontmatter
 *   - config has non-empty string + 00-prefix.md body already has content →
 *     leave the file alone (user authorship wins).  Just strip the config key
 *   - config has null / missing field / whitespace-only string → no-op for
 *     the file; strip the key
 *
 * On filesystem write failure we **throw**.  The runner marks the migration
 * as `"failed"` so the operator can see it in checkpoints; we explicitly do
 * not silently mark it complete.  Note the config key is only deleted on a
 * successful path, so the user's prefix is preserved in `config.json` until
 * the next attempt.
 *
 * Per workspace-migration AGENTS.md, all helpers are inlined.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-083-system-prompt-prefix-to-file");

/**
 * Default frontmatter used when the bundled 00-prefix.md is somehow missing
 * (e.g. running a development build where seeding hasn't happened yet).  In
 * the normal startup order, `ensurePromptFiles()` runs before this migration,
 * so the file already exists with the canonical bundled frontmatter.
 */
const FALLBACK_PREFIX_FRONTMATTER = [
  "---",
  'enabled: "!excludeCustomPrefix"',
  "---",
  "",
].join("\n");

/** Matches a `---`-delimited frontmatter block at the start of a file. */
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export const systemPromptPrefixToFileMigration: WorkspaceMigration = {
  id: "083-system-prompt-prefix-to-file",
  description:
    "Move config.systemPromptPrefix to <workspace>/prompts/system/00-prefix.md",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (err) {
      log.warn({ err, configPath }, "Failed to read config.json, skipping");
      return;
    }

    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        log.warn({ configPath }, "config.json is not a JSON object, skipping");
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      log.warn({ err, configPath }, "Failed to parse config.json, skipping");
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(config, "systemPromptPrefix")) {
      // Already migrated (or never set). Nothing to do.
      return;
    }

    const value = config.systemPromptPrefix;
    const trimmed = typeof value === "string" ? value.trim() : "";

    const sysDir = join(workspaceDir, "prompts", "system");
    const prefixFile = join(sysDir, "00-prefix.md");

    if (trimmed.length > 0) {
      // Read the existing file (if any) so we can preserve frontmatter and
      // avoid clobbering user-authored content.
      let existingFrontmatter = FALLBACK_PREFIX_FRONTMATTER;
      let existingBody = "";
      if (existsSync(prefixFile)) {
        const existingRaw = readFileSync(prefixFile, "utf-8");
        const fmMatch = existingRaw.match(FRONTMATTER_REGEX);
        if (fmMatch) {
          existingFrontmatter = fmMatch[0];
          existingBody = existingRaw.slice(fmMatch[0].length).trim();
        } else {
          existingBody = existingRaw.trim();
        }
      }

      if (existingBody.length > 0) {
        // User already authored content here.  Leave the file alone, but
        // continue on to strip the now-superseded config key.
        log.info(
          { prefixFile },
          "00-prefix.md already has user content; keeping it, dropping config key only",
        );
      } else {
        mkdirSync(sysDir, { recursive: true });
        writeFileSync(
          prefixFile,
          existingFrontmatter + trimmed + "\n",
          "utf-8",
        );
        log.info({ prefixFile }, "Wrote system prompt prefix to file");
      }
    }

    // Strip the field from config.json regardless of whether we wrote a body
    // — the field is removed from the schema either way.
    delete config.systemPromptPrefix;
    writeJsonAtomic(configPath, config);
  },

  down(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    const prefixFile = join(workspaceDir, "prompts", "system", "00-prefix.md");

    if (!existsSync(configPath) || !existsSync(prefixFile)) return;

    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        return;
      config = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    let body = "";
    try {
      const raw = readFileSync(prefixFile, "utf-8");
      const stripped = raw.replace(FRONTMATTER_REGEX, "").trim();
      // Strip `_` comment lines too — same convention as runtime renderer.
      body = stripped
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("_"))
        .join("\n")
        .trim();
    } catch {
      return;
    }

    config.systemPromptPrefix = body.length > 0 ? body : null;
    writeJsonAtomic(configPath, config);
  },
};

/**
 * Atomic JSON write: write to temp file alongside the target, then rename.
 * Throws on failure so callers can propagate to the migration runner (which
 * marks the migration `"failed"`).  Inlined per workspace-migration
 * self-containment rule.
 */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}
