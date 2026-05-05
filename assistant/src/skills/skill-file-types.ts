/**
 * Types extracted from catalog-files.ts to break the
 * catalog-files ↔ skill-file-provider cycle.
 */

export interface SkillFileEntry {
  path: string; // relative to skill directory root (e.g. "SKILL.md", "tools/foo.ts")
  name: string; // basename
  size: number;
  mimeType: string;
  isBinary: boolean;
  content: string | null; // inline text if ≤ 2 MB and text MIME, else null
}
