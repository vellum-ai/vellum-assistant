/**
 * Validates that every SKILL.md file under `skills/` conforms to the
 * Agent Skills specification (https://agentskills.io/specification).
 *
 * Checks performed:
 *   1. Each skill directory contains a SKILL.md file.
 *   2. SKILL.md starts with valid YAML frontmatter (delimited by `---`).
 *   3. Required fields: `name` and `description`.
 *   4. `name` matches the parent directory name.
 *   5. `name` constraints: 1-64 chars, lowercase alphanumeric + hyphens,
 *      no consecutive hyphens, no leading/trailing hyphens.
 *   6. `description` constraints: 1-1024 chars, non-empty.
 *   7. Optional `compatibility`: 1-500 chars if present.
 *   8. Required `metadata.emoji` (Vellum extension).
 *   9. Frontmatter is followed by Markdown body content.
 *  10. Non-standard top-level fields emit migration guidance:
 *      - Vellum-specific fields → move to `metadata.vellum`
 *      - Environment requirements → move to `compatibility`
 *
 * Usage:
 *   node scripts/skills/lint-skill-spec.mjs [skill-name ...]
 *
 * If no skill names are provided, all skills are checked.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../skills");

/**
 * Parse YAML frontmatter from a string.
 * Returns { frontmatter: Record<string, unknown>, body: string } or throws.
 *
 * This is a minimal parser that handles the subset of YAML used in
 * SKILL.md frontmatter without requiring external dependencies.
 */
function parseFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter (---).");
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error(
      "SKILL.md frontmatter is missing closing delimiter (---).",
    );
  }

  const yamlBlock = trimmed.slice(trimmed.indexOf("\n", 0) + 1, endIndex);
  const body = trimmed.slice(endIndex + 4).trim();
  const frontmatter = parseSimpleYaml(yamlBlock);

  return { frontmatter, body };
}

/**
 * Minimal YAML parser for flat key-value pairs and nested maps.
 * Handles string values (quoted or unquoted) and multiple levels of nesting.
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  // Stack of { indent, obj } to track nesting context
  const stack = [{ indent: -1, obj: result, key: null }];

  for (const line of lines) {
    // Skip blank lines and comments
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
    } else {
      parent[key] = stripQuotes(value);
    }
  }

  return result;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
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

// --- Validation Rules ---

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Standard fields per Agent Skills spec (https://agentskills.io/specification).
 */
const STANDARD_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

/**
 * Known vellum-specific extension fields that should be migrated to metadata.vellum.
 */
const VELLUM_EXTENSION_FIELDS = new Set([
  "user-invocable",
  "user_invocable",
  "credential-setup-for",
  "disable-model-invocation",
]);

/**
 * Fields that should be migrated to the compatibility field.
 */
const COMPATIBILITY_MIGRATION_FIELDS = new Set([
  "includes",
]);

function validateName(name, dirName) {
  const errors = [];

  if (typeof name !== "string" || name.length === 0) {
    errors.push('Required field "name" is missing or empty.');
    return errors;
  }

  if (name.length > 64) {
    errors.push(`"name" must be at most 64 characters (got ${name.length}).`);
  }

  if (!NAME_PATTERN.test(name)) {
    errors.push(
      `"name" must contain only lowercase letters, numbers, and hyphens, and must not start or end with a hyphen. Got: "${name}".`,
    );
  }

  if (name.includes("--")) {
    errors.push(`"name" must not contain consecutive hyphens (--). Got: "${name}".`);
  }

  if (name !== dirName) {
    errors.push(
      `"name" must match the parent directory name. Expected "${dirName}", got "${name}".`,
    );
  }

  return errors;
}

function validateDescription(description) {
  const errors = [];

  if (typeof description !== "string" || description.length === 0) {
    errors.push('Required field "description" is missing or empty.');
    return errors;
  }

  if (description.length > 1024) {
    errors.push(
      `"description" must be at most 1024 characters (got ${description.length}).`,
    );
  }

  return errors;
}

function validateCompatibility(compatibility) {
  const errors = [];

  if (compatibility === undefined || compatibility === null) {
    return errors;
  }

  if (typeof compatibility === "string" && compatibility.length > 500) {
    errors.push(
      `"compatibility" must be at most 500 characters (got ${compatibility.length}).`,
    );
  }

  return errors;
}

function validateMetadataEmoji(metadata) {
  const errors = [];

  if (!metadata || typeof metadata !== "object") {
    errors.push(
      'Required field "metadata.emoji" is missing. Skills must have an emoji in metadata.',
    );
    return errors;
  }

  const emoji = metadata.emoji;
  if (typeof emoji !== "string" || emoji.length === 0) {
    errors.push(
      'Required field "metadata.emoji" is missing or empty. Skills must have an emoji in metadata.',
    );
  }

  return errors;
}

/**
 * Detect non-standard top-level fields and recommend migration.
 *
 * Returns errors for:
 * - Known vellum extension fields → recommend moving to metadata.vellum
 * - Compatibility-related fields → recommend moving to compatibility
 * - Unknown fields → recommend using metadata for custom data or compatibility for requirements
 */
function validateNonStandardFields(frontmatter) {
  const errors = [];

  for (const key of Object.keys(frontmatter)) {
    if (STANDARD_FIELDS.has(key)) {
      continue;
    }

    if (VELLUM_EXTENSION_FIELDS.has(key)) {
      errors.push(
        `Non-standard field "${key}" should be moved to metadata.vellum.${key}. ` +
          `The Agent Skills spec reserves top-level fields for standard properties. ` +
          `Use the "metadata" field for vendor-specific extensions: metadata: { "vellum": { "${key}": ... } }`,
      );
    } else if (COMPATIBILITY_MIGRATION_FIELDS.has(key)) {
      errors.push(
        `Non-standard field "${key}" should be moved to the "compatibility" field. ` +
          `The "compatibility" field is for environment requirements (required skills, CLIs, packages, network access).`,
      );
    } else {
      errors.push(
        `Unknown top-level field "${key}". ` +
          `Only standard fields (name, description, license, compatibility, metadata, allowed-tools) are allowed at the top level. ` +
          `Use "metadata" for custom properties: metadata: { "${key}": ... }. ` +
          `Use "compatibility" for environment requirements (e.g., required CLIs, packages, network access).`,
      );
    }
  }

  return errors;
}

function validateSkill(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  const skillMdPath = join(skillDir, "SKILL.md");
  const errors = [];

  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    return errors;
  }

  // 1. SKILL.md must exist
  const stat = statSync(skillMdPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    errors.push(`skills/${skillName}/SKILL.md is missing.`);
    return errors;
  }

  // 2. Parse frontmatter
  const content = readFileSync(skillMdPath, "utf-8");
  let frontmatter;
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
  } catch (e) {
    errors.push(`skills/${skillName}/SKILL.md: ${e.message}`);
    return errors;
  }

  // 3. Validate required fields
  errors.push(
    ...validateName(frontmatter.name, skillName).map(
      (e) => `skills/${skillName}/SKILL.md: ${e}`,
    ),
  );

  errors.push(
    ...validateDescription(frontmatter.description).map(
      (e) => `skills/${skillName}/SKILL.md: ${e}`,
    ),
  );

  // 4. Validate optional fields
  errors.push(
    ...validateCompatibility(frontmatter.compatibility).map(
      (e) => `skills/${skillName}/SKILL.md: ${e}`,
    ),
  );

  // 5. Validate required metadata.emoji (Vellum requirement)
  errors.push(
    ...validateMetadataEmoji(frontmatter.metadata).map(
      (e) => `skills/${skillName}/SKILL.md: ${e}`,
    ),
  );

  // 6. Check for non-standard fields and recommend migration
  errors.push(
    ...validateNonStandardFields(frontmatter).map(
      (e) => `skills/${skillName}/SKILL.md: ${e}`,
    ),
  );

  return errors;
}

// --- Main ---

function getSkillDirs(filter) {
  let entries;
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    console.log("No skills/ directory found. Nothing to validate.");
    process.exit(0);
  }

  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => !filter || filter.length === 0 || filter.includes(e.name))
    .map((e) => e.name)
    .sort();
}

const filterSkills = process.argv.slice(2);
const skillDirs = getSkillDirs(filterSkills);

let totalErrors = 0;

for (const skill of skillDirs) {
  const errors = validateSkill(skill);
  for (const err of errors) {
    console.error(err);
  }
  totalErrors += errors.length;
}

if (totalErrors > 0) {
  console.error(`\nFound ${totalErrors} SKILL.md spec violation(s).`);
  process.exit(1);
} else {
  console.log(
    `Validated ${skillDirs.length} skill(s) - all SKILL.md files conform to the spec.`,
  );
}
