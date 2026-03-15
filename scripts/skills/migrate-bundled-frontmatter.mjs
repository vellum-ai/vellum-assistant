/**
 * Migration script: Convert all bundled SKILL.md files to Agent Skills spec-compliant frontmatter.
 *
 * For each bundled skill, this script:
 *   1. Parses the existing frontmatter
 *   2. Builds a new spec-compliant frontmatter block:
 *      - `name`: directory name (kebab-case)
 *      - `description`: kept unchanged
 *      - `compatibility`: "Designed for Vellum personal assistants"
 *      - `license`: kept if present
 *      - `metadata`: JSON object with emoji + vellum sub-object
 *   3. Writes the updated SKILL.md preserving the original body content
 *
 * Usage:
 *   node scripts/skills/migrate-bundled-frontmatter.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = resolve(
  __dirname,
  "../../assistant/src/config/bundled-skills",
);

// --- Frontmatter parsing (same logic as lint-skill-spec.mjs) ---

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter (---).");
  }

  const frontmatterRaw = match[1];
  const body = content.slice(match[0].length);
  const fields = parseSimpleYaml(frontmatterRaw);

  return { fields, body, frontmatterRaw };
}

/**
 * Minimal YAML parser for flat key-value pairs and nested maps.
 * Handles string values (quoted or unquoted), multiline JSON values,
 * and multiple levels of nesting.
 *
 * Uses the same continuation-line logic as the TypeScript frontmatter.ts
 * to handle multiline JSON metadata blocks.
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split(/\r?\n/);
  let currentKey = undefined;
  let continuationLines = [];

  function flushContinuation() {
    if (currentKey !== undefined) {
      if (continuationLines.length > 0) {
        const joined = continuationLines.map((l) => l.trim()).join(" ");
        try {
          JSON.parse(joined);
          result[currentKey] = joined;
        } catch {
          result[currentKey] = joined.replace(/,\s*([}\]])/g, "$1");
        }
      } else {
        result[currentKey] = "";
      }
    }
    currentKey = undefined;
    continuationLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Continuation line: indented and we have a pending key
    if (currentKey !== undefined && /^\s/.test(line)) {
      continuationLines.push(trimmed);
      continue;
    }

    // Flush any pending multiline value
    flushContinuation();

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!value) {
      // Value may continue on subsequent indented lines
      currentKey = key;
      continuationLines = [];
      continue;
    }

    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
      if (isDoubleQuoted) {
        value = value.replace(/\\(["\\nr])/g, (_, ch) => {
          if (ch === "n") return "\n";
          if (ch === "r") return "\r";
          return ch;
        });
      }
    }

    result[key] = value;
  }

  flushContinuation();
  return result;
}

// --- Standard top-level fields (Agent Skills spec) ---
const STANDARD_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

// --- Migration logic ---

function migrateSkill(dirName, skillDir) {
  const skillMdPath = join(skillDir, "SKILL.md");
  const content = readFileSync(skillMdPath, "utf-8");

  const { fields, body } = parseFrontmatter(content);

  const changes = [];

  // Original name value (for display-name)
  const originalName = fields.name || dirName;

  // 1. Set name to directory name
  const newName = dirName;
  if (originalName !== dirName) {
    changes.push(`name: "${originalName}" → "${newName}"`);
  }

  // 2. Keep description
  const description = fields.description || "";

  // 3. Keep license if present
  const license = fields.license || undefined;

  // 4. Parse existing metadata JSON (if any)
  let existingMetadata = {};
  const metadataRaw = fields.metadata?.trim();
  if (metadataRaw) {
    try {
      existingMetadata = JSON.parse(metadataRaw);
    } catch {
      // Try cleaning trailing commas
      try {
        existingMetadata = JSON.parse(
          metadataRaw.replace(/,\s*([}\]])/g, "$1"),
        );
      } catch (e2) {
        console.warn(
          `  WARNING: Failed to parse metadata JSON for ${dirName}: ${e2.message}`,
        );
      }
    }
  }

  // 5. Extract emoji from various locations
  let emoji =
    existingMetadata?.vellum?.emoji ||
    existingMetadata?.emoji ||
    fields.emoji ||
    undefined;

  if (!emoji) {
    console.warn(`  WARNING: No emoji found for ${dirName}`);
  }

  // 6. Build vellum sub-object
  const vellum = {};

  // display-name: only if original name differs from directory name
  if (originalName !== dirName) {
    vellum["display-name"] = originalName;
    changes.push(`display-name: "${originalName}"`);
  }

  // user-invocable: only if explicitly set in frontmatter
  if (fields["user-invocable"] !== undefined) {
    const val = fields["user-invocable"].trim().toLowerCase();
    vellum["user-invocable"] = val !== "false";
    if (val === "false") {
      changes.push(`user-invocable: false (preserved)`);
    }
  } else if (
    existingMetadata?.vellum?.["user-invocable"] !== undefined
  ) {
    vellum["user-invocable"] = existingMetadata.vellum["user-invocable"];
  }
  // If not explicitly set anywhere, omit (runtime defaults to true)

  // disable-model-invocation: only if true
  const dmiFromField = fields["disable-model-invocation"]?.trim().toLowerCase();
  const dmiFromMetadata =
    existingMetadata?.vellum?.["disable-model-invocation"];
  if (dmiFromField === "true" || dmiFromMetadata === true) {
    vellum["disable-model-invocation"] = true;
    changes.push(`disable-model-invocation: true (preserved)`);
  }
  // Note: if it's explicitly "false", we omit it (false is the default)

  // includes: only if present
  let includesValue;
  if (fields.includes) {
    try {
      includesValue = JSON.parse(fields.includes);
    } catch {
      // Try as raw string
      includesValue = fields.includes;
    }
  }
  if (existingMetadata?.vellum?.includes) {
    includesValue = existingMetadata.vellum.includes;
  }
  if (includesValue) {
    vellum["includes"] = includesValue;
    changes.push(`includes moved to metadata.vellum`);
  }

  // credential-setup-for: only if present
  const credSetupFor =
    fields["credential-setup-for"] ||
    existingMetadata?.vellum?.["credential-setup-for"];
  if (credSetupFor) {
    vellum["credential-setup-for"] = credSetupFor;
    changes.push(`credential-setup-for moved to metadata.vellum`);
  }

  // Preserve other existing metadata.vellum fields (feature-flag, etc.)
  // Dead keys (cli, requires, os, primaryEnv, install) have been removed.
  if (existingMetadata?.vellum) {
    const HANDLED_KEYS = new Set([
      "emoji",
      "display-name",
      "user-invocable",
      "disable-model-invocation",
      "includes",
      "credential-setup-for",
      // Dead keys — strip during migration
      "cli",
      "requires",
      "os",
      "primaryEnv",
      "install",
    ]);
    for (const [key, val] of Object.entries(existingMetadata.vellum)) {
      if (HANDLED_KEYS.has(key)) {
        continue;
      }
      vellum[key] = val;
    }
  }

  // 7. Build top-level metadata object
  const newMetadata = {};
  if (emoji) {
    newMetadata["emoji"] = emoji;
  }
  if (Object.keys(vellum).length > 0) {
    newMetadata["vellum"] = vellum;
  }

  // 8. Build the new frontmatter
  const metadataJson = JSON.stringify(newMetadata);

  let frontmatterLines = [];
  frontmatterLines.push(`name: ${newName}`);

  // Quote description if it contains colons or other special chars
  const escapedDescription = escapeYamlValue(description);
  frontmatterLines.push(`description: ${escapedDescription}`);

  frontmatterLines.push(
    `compatibility: "Designed for Vellum personal assistants"`,
  );

  if (license) {
    frontmatterLines.push(`license: ${escapeYamlValue(license)}`);
  }

  frontmatterLines.push(`metadata: ${metadataJson}`);

  // Preserve allowed-tools if present
  if (fields["allowed-tools"]) {
    frontmatterLines.push(
      `allowed-tools: ${escapeYamlValue(fields["allowed-tools"])}`,
    );
  }

  const newContent = `---\n${frontmatterLines.join("\n")}\n---\n${body}`;

  writeFileSync(skillMdPath, newContent, "utf-8");

  return changes;
}

/**
 * Escape a YAML value — quote it if it contains special characters.
 * If the value already contains double quotes, use appropriate quoting.
 */
function escapeYamlValue(value) {
  if (!value) return '""';

  // If value contains newlines, colons, or other YAML-special chars, quote it
  if (
    value.includes(":") ||
    value.includes("#") ||
    value.includes("\n") ||
    value.includes('"') ||
    value.startsWith("'") ||
    value.startsWith("{") ||
    value.startsWith("[") ||
    value.startsWith("*") ||
    value.startsWith("&") ||
    value.startsWith("!") ||
    value.startsWith("|") ||
    value.startsWith(">") ||
    value.startsWith("%") ||
    value.startsWith("@") ||
    value.startsWith("`")
  ) {
    // Use double quotes with escaping
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  return value;
}

// --- Main ---

function main() {
  const entries = readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .filter((e) => {
      const skillMdPath = join(BUNDLED_SKILLS_DIR, e.name, "SKILL.md");
      try {
        return statSync(skillMdPath).isFile();
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort();

  console.log(`Found ${skillDirs.length} bundled skills to migrate.\n`);

  let totalChanges = 0;
  const summary = [];

  for (const dirName of skillDirs) {
    const skillDir = join(BUNDLED_SKILLS_DIR, dirName);
    try {
      const changes = migrateSkill(dirName, skillDir);
      if (changes.length > 0) {
        console.log(`✓ ${dirName}: ${changes.join(", ")}`);
      } else {
        console.log(`✓ ${dirName}: (spec-compliant structure applied)`);
      }
      totalChanges += changes.length;
      summary.push({ name: dirName, changes });
    } catch (err) {
      console.error(`✗ ${dirName}: ERROR — ${err.message}`);
      summary.push({ name: dirName, error: err.message });
    }
  }

  console.log(
    `\nMigration complete. Processed ${skillDirs.length} skills with ${totalChanges} changes.`,
  );

  // Print any errors
  const errors = summary.filter((s) => s.error);
  if (errors.length > 0) {
    console.error(`\n${errors.length} skill(s) had errors:`);
    for (const err of errors) {
      console.error(`  - ${err.name}: ${err.error}`);
    }
    process.exit(1);
  }
}

main();
