import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "../../memory/memory-retrospective-constants.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import {
  createManagedSkill,
  getManagedSkillDir,
} from "../../skills/managed-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/** Strip embedded newlines/carriage returns to prevent YAML frontmatter injection. */
function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Core execution logic for scaffold_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 *
 * `deps` injects the catalog seam so the ownership backstop's non-managed
 * collision check can be exercised without standing up a real bundled/plugin
 * catalog.
 */
export async function executeScaffoldManagedSkill(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: { loadCatalog?: () => { id: string; source: SkillSource }[] } = {},
): Promise<ToolExecutionResult> {
  const skillId = input.skill_id;
  if (typeof skillId !== "string" || !skillId.trim()) {
    return {
      content: "Error: skill_id is required and must be a non-empty string",
      isError: true,
    };
  }

  const name = input.name;
  if (typeof name !== "string" || !name.trim()) {
    return {
      content: "Error: name is required and must be a non-empty string",
      isError: true,
    };
  }

  const description = input.description;
  if (typeof description !== "string" || !description.trim()) {
    return {
      content: "Error: description is required and must be a non-empty string",
      isError: true,
    };
  }

  const bodyMarkdown = input.body_markdown;
  if (typeof bodyMarkdown !== "string" || !bodyMarkdown.trim()) {
    return {
      content:
        "Error: body_markdown is required and must be a non-empty string",
      isError: true,
    };
  }

  // Validate and normalize includes
  let includes: string[] | undefined;
  if (input.includes !== undefined) {
    if (!Array.isArray(input.includes)) {
      return {
        content: "Error: includes must be an array of strings",
        isError: true,
      };
    }
    for (const item of input.includes) {
      if (typeof item !== "string") {
        return {
          content: "Error: each element in includes must be a non-empty string",
          isError: true,
        };
      }
      if (!item.trim()) {
        return {
          content: "Error: each element in includes must be a non-empty string",
          isError: true,
        };
      }
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of input.includes as string[]) {
      const trimmed = item.trim();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    if (normalized.length > 0) {
      includes = normalized;
    }
  }

  // Validate and normalize companion files
  let files: Array<{ path: string; content: string }> | undefined;
  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) {
      return {
        content: "Error: files must be an array of { path, content } objects",
        isError: true,
      };
    }
    const collected: Array<{ path: string; content: string }> = [];
    for (const item of input.files) {
      if (typeof item !== "object" || item === null) {
        return {
          content:
            "Error: each element in files must be a { path, content } object",
          isError: true,
        };
      }
      const { path, content } = item as Record<string, unknown>;
      if (typeof path !== "string" || !path.trim()) {
        return {
          content: "Error: each file must have a non-empty string path",
          isError: true,
        };
      }
      if (typeof content !== "string") {
        return {
          content: "Error: each file must have a string content",
          isError: true,
        };
      }
      collected.push({ path: path.trim(), content });
    }
    if (collected.length > 0) {
      files = collected;
    }
  }

  // Validate and normalize the optional category (lowercased/trimmed for
  // consistency with the lowercase Skills-UI sidebar buckets). Blank or
  // whitespace-only values become undefined so they never land in frontmatter.
  let category: string | undefined;
  if (input.category !== undefined) {
    if (typeof input.category !== "string") {
      return {
        content: "Error: category must be a string",
        isError: true,
      };
    }
    const normalized = input.category.trim().toLowerCase();
    if (normalized) {
      category = normalized;
    }
  }

  const id = skillId.trim();
  const fromRetrospective =
    context.requestOrigin === MEMORY_RETROSPECTIVE_ORIGIN;
  const author = fromRetrospective ? "assistant" : "user";

  // Ownership backstop (retrospective origin only): the retrospective may author
  // a skill ONLY if it owns it. Fail closed on either of two collisions.
  if (fromRetrospective) {
    // (1) A non-managed catalog entry (bundled, plugin, workspace, extra) owns
    // this id. Creating a managed skill with that id SHADOWS the catalog entry,
    // and an overwrite under the managed dir would never touch it — either way
    // the retrospective must not stand on a skill it did not author. This covers
    // create AND overwrite. The prompt directs the model to skip when an
    // existing skill of any source already covers the procedure; this enforces
    // it.
    const loadCatalog = deps.loadCatalog ?? (() => loadSkillCatalog());
    const nonManagedOwner = loadCatalog().find(
      (s) => s.id === id && s.source !== "managed",
    );
    if (nonManagedOwner) {
      return {
        content: `Error: skill "${id}" is owned by a ${nonManagedOwner.source} skill; the retrospective may not create, overwrite, or shadow it. The procedure is already covered — skip it.`,
        isError: true,
      };
    }

    // (2) A managed skill already exists on disk but is not VERIFIABLY
    // assistant-authored. `readInstallMeta` returns null for a fresh create AND
    // for an existing skill whose install-meta/version.json is missing or
    // corrupt — so gate on the SKILL.md existing and the author tag reading
    // exactly "assistant". This fails closed on user-authored, untagged, and
    // unverifiable (missing/corrupt meta) managed skills alike, matching the
    // prune side where such skills are never pruned.
    const managedDir = getManagedSkillDir(id);
    const managedSkillExists = existsSync(join(managedDir, "SKILL.md"));
    if (
      managedSkillExists &&
      readInstallMeta(managedDir)?.author !== "assistant"
    ) {
      return {
        content: `Error: skill "${id}" is not verifiably assistant-authored; the retrospective may not overwrite it or write companion files into it. Author a new skill instead.`,
        isError: true,
      };
    }
  }

  const result = createManagedSkill({
    id,
    name: sanitizeFrontmatterValue(name),
    description: sanitizeFrontmatterValue(description),
    bodyMarkdown: bodyMarkdown,
    emoji:
      typeof input.emoji === "string"
        ? sanitizeFrontmatterValue(input.emoji)
        : undefined,
    overwrite: input.overwrite === true,
    includes,
    category,
    files,
    author,
  });

  if (!result.created) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  refreshSkillCapabilityMemories();

  return {
    content: JSON.stringify({
      created: true,
      skill_id: id,
      path: result.path,
    }),
    isError: false,
  };
}
