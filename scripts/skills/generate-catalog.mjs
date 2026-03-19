/**
 * Generates `skills/catalog.json` from the SKILL.md frontmatter in each
 * skill directory under `skills/`.
 *
 * The catalog is a manifest of first-party Vellum skills that is fetched
 * from GitHub at runtime so the assistant can discover and install new
 * skills maintained by Vellum.
 *
 * Usage:
 *   node scripts/skills/generate-catalog.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./parse-skill-yaml.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../skills");
const CATALOG_PATH = join(SKILLS_DIR, "catalog.json");

/**
 * Build a catalog entry from a skill directory.
 */
function buildEntry(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  const skillMdPath = join(skillDir, "SKILL.md");

  const stat = statSync(skillMdPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return null;
  }

  const content = readFileSync(skillMdPath, "utf-8");
  const { frontmatter } = parseFrontmatter(content);

  const entry = {
    id: skillName,
    name: frontmatter.name || skillName,
    description: frontmatter.description || "",
  };

  // Extract metadata (per agentskills.io spec, metadata is an arbitrary key-value map)
  if (frontmatter.metadata && typeof frontmatter.metadata === "object") {
    entry.metadata = frontmatter.metadata;
  }

  // Extract compatibility
  if (frontmatter.compatibility && typeof frontmatter.compatibility === "string") {
    entry.compatibility = frontmatter.compatibility;
  }

  return entry;
}

// --- Main ---

const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((name) => buildEntry(name))
  .filter(Boolean);

const catalog = {
  description:
    "Manifest of first-party Vellum skills. Fetched from GitHub at runtime so the assistant can discover and install new skills maintained by Vellum.",
  version: 1,
  skills: entries,
};

const output = JSON.stringify(catalog, null, 2) + "\n";
writeFileSync(CATALOG_PATH, output, "utf-8");

console.log(`Generated ${CATALOG_PATH} with ${entries.length} skill(s).`);
