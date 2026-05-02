import type { SlimSkillResponse } from "../daemon/message-types/skills.js";
import type { SkillFileEntry } from "./skill-file-types.js";

/**
 * A file provider can resolve file listings and single-file content for
 * skills that are NOT installed locally. Each origin (vellum catalog,
 * skills.sh, clawhub) implements this interface.
 */
export interface SkillFileProvider {
  /**
   * Return true if this provider can handle the given skill id.
   * Called synchronously — must not perform I/O.
   */
  canHandle(skillId: string): boolean;

  /**
   * List all files in the skill directory. Returns entries with
   * `content: null` (content is fetched on demand via `readFileContent`).
   * Returns `null` if the skill doesn't exist in this provider.
   */
  listFiles(skillId: string): Promise<SkillFileEntry[] | null>;

  /**
   * Read a single file's content. `relativePath` has already been
   * sanitized by the caller (sanitizeRelativePath + hasHiddenOrSkippedSegment).
   * Returns `null` if the file doesn't exist.
   */
  readFileContent(
    skillId: string,
    sanitizedPath: string,
  ): Promise<SkillFileEntry | null>;

  /**
   * Synthesize a SlimSkillResponse for an uninstalled skill in this
   * provider. Used by getSkill/getSkillFiles when the skill isn't in
   * the local catalog. Returns `null` if the provider can't produce
   * metadata for this skill.
   */
  toSlimSkill(skillId: string): Promise<SlimSkillResponse | null>;
}
