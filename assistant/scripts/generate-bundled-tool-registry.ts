#!/usr/bin/env bun
/**
 * Generates `src/config/bundled-tool-registry.ts` by reading every
 * `TOOLS.json` under `src/config/bundled-skills/`.
 *
 * Usage:
 *   cd assistant && bun run scripts/generate-bundled-tool-registry.ts
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../src/config/bundled-skills");
const OUTPUT = resolve(
  import.meta.dir,
  "../src/config/bundled-tool-registry.ts",
);

interface ToolEntry {
  executor: string;
  [key: string]: unknown;
}

interface ToolsJson {
  version: number;
  tools: ToolEntry[];
}

/** Convert a kebab-case filename stem to camelCase. */
function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Build the section separator comment (e.g. `// ── browser ──…`). */
function sectionComment(skillName: string): string {
  const inner = ` ${skillName} `;
  // Target total line width of ~80 chars
  const remaining = 80 - 3 - inner.length; // 3 for "// "
  const suffix = "─".repeat(Math.max(1, remaining));
  return `// ──${inner}${"─".repeat(0)}${suffix}`;
}

async function main() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const skillDirs = entries
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .sort();

  // First pass: collect all executors and detect alias collisions.
  const skills: {
    name: string;
    tools: {
      executor: string;
      registryKey: string;
      importPath: string;
      alias: string;
    }[];
  }[] = [];

  // Map from alias → skill that first claimed it (for collision detection).
  const claimedAliases = new Map<string, string>();
  // Track which aliases need collision-prefixing.
  const collidedAliases = new Set<string>();

  for (const skillDir of skillDirs) {
    const toolsJsonPath = join(ROOT, skillDir, "TOOLS.json");
    let raw: string;
    try {
      raw = await readFile(toolsJsonPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No TOOLS.json — skip this skill.
        continue;
      }
      throw err;
    }

    const toolsJson: ToolsJson = JSON.parse(raw);
    const toolEntries: (typeof skills)[number]["tools"] = [];

    for (const tool of toolsJson.tools) {
      const executor = tool.executor;
      const registryKey = `${skillDir}:${executor}`;
      const importPath = `./bundled-skills/${skillDir}/${executor.replace(".ts", ".js")}`;
      const stem = basename(executor, ".ts");
      const baseAlias = toCamelCase(stem);

      const existingSkill = claimedAliases.get(baseAlias);
      if (existingSkill !== undefined && existingSkill !== skillDir) {
        collidedAliases.add(baseAlias);
      }
      claimedAliases.set(baseAlias, skillDir);

      toolEntries.push({ executor, registryKey, importPath, alias: baseAlias });
    }

    if (toolEntries.length > 0) {
      skills.push({ name: skillDir, tools: toolEntries });
    }
  }

  // Second pass: resolve collided aliases by adding skill prefix.
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (collidedAliases.has(tool.alias)) {
        const prefix = toCamelCase(skill.name);
        tool.alias = `${prefix}_${tool.alias}`;
      }
    }
  }

  // Check for remaining duplicates within same skill (shouldn't happen but be safe).
  const finalAliases = new Set<string>();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (finalAliases.has(tool.alias)) {
        // Append skill prefix if not already present.
        const prefix = toCamelCase(skill.name);
        if (!tool.alias.startsWith(prefix)) {
          tool.alias = `${prefix}${tool.alias.charAt(0).toUpperCase()}${tool.alias.slice(1)}`;
        }
      }
      finalAliases.add(tool.alias);
    }
  }

  // Generate output.
  const lines: string[] = [];

  // File header.
  lines.push(`/**`);
  lines.push(` * Auto-generated registry of bundled skill tool scripts.`);
  lines.push(` *`);
  lines.push(
    ` * In compiled Bun binaries, bundled tool scripts can't be dynamically`,
  );
  lines.push(
    ` * imported from the filesystem because their relative imports point to`,
  );
  lines.push(
    ` * modules that only exist inside the binary's virtual /$bunfs/ filesystem.`,
  );
  lines.push(` *`);
  lines.push(
    ` * This registry eagerly imports every bundled tool script so it becomes`,
  );
  lines.push(
    ` * part of the compiled binary.  At runtime, the skill-script-runner`,
  );
  lines.push(` * checks this map before falling back to a dynamic import.`);
  lines.push(` *`);
  lines.push(` * Regenerate with:`);
  lines.push(` *   bun run scripts/generate-bundled-tool-registry.ts`);
  lines.push(` */`);
  lines.push(
    `import type { SkillToolScript } from "../tools/skills/script-contract.js";`,
  );

  // Import statements grouped by skill, sorted by import path within each
  // group so the output satisfies eslint simple-import-sort.
  for (const skill of skills) {
    // Strip `.js` before comparing so `browser-wait-for` sorts before
    // `browser-wait-for-download`, matching simple-import-sort's order.
    const sorted = [...skill.tools].sort((a, b) =>
      a.importPath
        .replace(/\.js$/, "")
        .localeCompare(b.importPath.replace(/\.js$/, "")),
    );
    lines.push(sectionComment(skill.name));
    for (const tool of sorted) {
      lines.push(`import * as ${tool.alias} from "${tool.importPath}";`);
    }
  }

  // Registry map.
  lines.push(``);
  lines.push(
    `// ─── Registry ────────────────────────────────────────────────────────────────`,
  );
  lines.push(``);
  lines.push(
    `/** Key format: \`skillDirBasename:executorPath\` (e.g. \`schedule:tools/schedule-list.ts\`). */`,
  );
  lines.push(
    `export const bundledToolRegistry = new Map<string, SkillToolScript>([`,
  );

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    lines.push(`  // ${skill.name}`);
    for (const tool of skill.tools) {
      const entry = `["${tool.registryKey}", ${tool.alias}]`;
      // Wrap long lines.
      if (`  ${entry},`.length > 80) {
        lines.push(`  [`);
        lines.push(`    "${tool.registryKey}",`);
        lines.push(`    ${tool.alias},`);
        lines.push(`  ],`);
      } else {
        lines.push(`  ${entry},`);
      }
    }

    if (i < skills.length - 1) {
      lines.push(``);
    }
  }

  lines.push(`]);`);
  lines.push(``); // trailing newline

  await writeFile(OUTPUT, lines.join("\n"), "utf-8");
  console.log(`✓ Generated ${OUTPUT}`);
  console.log(
    `  ${skills.length} skills, ${skills.reduce((n, s) => n + s.tools.length, 0)} tools`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
