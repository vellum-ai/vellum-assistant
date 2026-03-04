/**
 * Lint script that ensures no bundled skill imports from another bundled skill.
 *
 * For any given skill directory under `bundled-skills/`, all relative imports
 * must resolve within that same skill directory (or go outside `bundled-skills/`
 * entirely, e.g. into the main assistant codebase). Importing from a sibling
 * skill is a violation.
 *
 * Usage:
 *   bun run assistant/scripts/lint-skill-imports.ts [skill-name ...]
 *
 * If no skill names are provided, all skills are checked.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const BUNDLED_SKILLS_DIR = resolve(
  import.meta.dirname,
  "../src/config/bundled-skills",
);

function getSkillDirs(filter?: string[]): string[] {
  const entries = readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .filter((e) => !filter || filter.length === 0 || filter.includes(e.name))
    .map((e) => e.name)
    .sort();
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
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

interface Violation {
  file: string;
  line: number;
  importPath: string;
  targetSkill: string;
}

function checkSkill(skillName: string): Violation[] {
  const skillDir = join(BUNDLED_SKILLS_DIR, skillName);
  const violations: Violation[] = [];

  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    return violations;
  }

  const tsFiles = findTsFiles(skillDir);

  for (const filePath of tsFiles) {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match import statements and re-exports with relative paths
      const importMatches = line.matchAll(
        /(?:import|export)\s+.*?from\s+["'](\.[^"']+)["']/g,
      );

      for (const match of importMatches) {
        const importPath = match[1];
        const fileDir = dirname(filePath);
        const resolved = resolve(fileDir, importPath);
        const relToBundled = relative(BUNDLED_SKILLS_DIR, resolved);

        // If it goes outside bundled-skills entirely, that's fine
        if (relToBundled.startsWith("..")) {
          continue;
        }

        // Extract the top-level skill directory from the resolved path
        const targetSkill = relToBundled.split("/")[0];

        // If it resolves to _shared, that's allowed
        if (targetSkill === "_shared") {
          continue;
        }

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
