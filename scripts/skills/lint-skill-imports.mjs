/**
 * Ensures no skill imports from a sibling skill directory.
 *
 * For any given skill under `skills/`, all relative imports must resolve
 * within that same skill (or go outside `skills/` entirely). Importing
 * from a sibling skill is a violation.
 *
 * Usage:
 *   node scripts/lint-skill-imports.mjs [skill-name ...]
 *
 * If no skill names are provided, all skills are checked.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../skills");

function getSkillDirs(filter) {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => !filter || filter.length === 0 || filter.includes(e.name))
    .map((e) => e.name)
    .sort();
}

function findTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function checkSkill(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  const violations = [];

  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    return violations;
  }

  const tsFiles = findTsFiles(skillDir);

  for (const filePath of tsFiles) {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatches = line.matchAll(
        /(?:import|export)\s+.*?from\s+["'](\.[^"']+)["']/g,
      );

      for (const match of importMatches) {
        const importPath = match[1];
        const fileDir = dirname(filePath);
        const resolved = resolve(fileDir, importPath);
        const relToSkills = relative(SKILLS_DIR, resolved);

        // If it goes outside skills/ entirely, that's fine
        if (relToSkills.startsWith("..")) {
          continue;
        }

        const targetSkill = relToSkills.split("/")[0];

        // If it resolves to a different skill, that's a violation
        if (targetSkill !== skillName) {
          violations.push({
            file: relative(process.cwd(), filePath),
            line: i + 1,
            importPath,
            targetSkill,
          });
        }
      }
    }
  }

  return violations;
}

// --- Main ---

const filterSkills = process.argv.slice(2);
const skillDirs = getSkillDirs(filterSkills);

let totalViolations = 0;

for (const skill of skillDirs) {
  const violations = checkSkill(skill);
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line} - imports from sibling skill "${v.targetSkill}" (${v.importPath})`,
    );
  }
  totalViolations += violations.length;
}

if (totalViolations > 0) {
  console.error(`\nFound ${totalViolations} cross-skill import violation(s).`);
  process.exit(1);
} else {
  console.log(
    `Checked ${skillDirs.length} skill(s) - no cross-skill import violations found.`,
  );
}
