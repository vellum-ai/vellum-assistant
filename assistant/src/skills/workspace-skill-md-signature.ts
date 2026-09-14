import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceSkillsDir } from "../util/platform.js";

/**
 * Cheap change detector for workspace skill capability cards: the sorted set
 * of immediate skill directories that contain a top-level `SKILL.md`, each
 * paired with that file's mtime. Capability cards are frontmatter fields from
 * `SKILL.md`. Body files, `TOOLS.json`, scripts, and `references/` are not part
 * of this signature.
 *
 * Listing the skills directory (not only statting known paths) is what makes
 * install and delete visible: a new or removed skill directory changes the
 * signature even when no previously known `SKILL.md` mtime moved.
 */
export function readWorkspaceSkillMdSignature(
  skillsDir: string = getWorkspaceSkillsDir(),
): string {
  if (!existsSync(skillsDir)) {
    return "";
  }

  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    try {
      const st = statSync(skillMdPath);
      if (!st.isFile()) {
        continue;
      }
      parts.push(`${entry.name}:${Math.trunc(st.mtimeMs)}`);
    } catch {
      // No readable SKILL.md: not a catalog skill.
    }
  }

  parts.sort();
  return parts.join("\n");
}
