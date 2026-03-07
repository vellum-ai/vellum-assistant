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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../skills");
const CATALOG_PATH = join(SKILLS_DIR, "catalog.json");

/**
 * Minimal YAML frontmatter parser (same approach as lint-skill-spec.mjs).
 * Returns the parsed frontmatter object.
 */
function parseFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter (---).");
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error("SKILL.md frontmatter is missing closing delimiter (---).");
  }

  const yamlBlock = trimmed.slice(trimmed.indexOf("\n", 0) + 1, endIndex);
  return parseSimpleYaml(yamlBlock);
}

/**
 * Minimal YAML parser for flat key-value pairs and nested maps.
 * Handles string values (quoted or unquoted), inline JSON objects/arrays,
 * and multiple levels of nesting.
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  // Stack of { indent, obj } to track nesting context
  const stack = [{ indent: -1, obj: result, key: null }];

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // Calculate indentation (number of leading spaces)
    const indent = line.match(/^(\s*)/)[1].length;
    const match = line.match(/^(\s*)(\S+):\s*(.*)/);
    if (!match) continue;

    const key = match[2];
    const value = match[3].trim();

    // Pop stack to find the parent at the right indentation level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (value === "" || value === "|" || value === ">") {
      // Start of a nested object
      parent[key] = {};
      stack.push({ indent, obj: parent[key], key });
    } else if (
      (value.startsWith("{") && value.endsWith("}")) ||
      (value.startsWith("[") && value.endsWith("]"))
    ) {
      // Inline JSON
      try {
        parent[key] = JSON.parse(value);
      } catch {
        parent[key] = stripQuotes(value);
      }
    } else {
      parent[key] = stripQuotes(value);
    }
  }

  return result;
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return processEscapes(s.slice(1, -1));
  }
  return s;
}

/**
 * Process JSON-style unicode escape sequences (\uXXXX) in a string.
 */
function processEscapes(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

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
  const frontmatter = parseFrontmatter(content);

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
