import { createManagedSkill } from "../../skills/managed-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/** Strip embedded newlines/carriage returns to prevent YAML frontmatter injection. */
function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Core execution logic for scaffold_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 */
export async function executeScaffoldManagedSkill(
  input: Record<string, unknown>,
  _context: ToolContext,
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

  const result = createManagedSkill({
    id: skillId.trim(),
    name: sanitizeFrontmatterValue(name),
    description: sanitizeFrontmatterValue(description),
    bodyMarkdown: bodyMarkdown,
    emoji:
      typeof input.emoji === "string"
        ? sanitizeFrontmatterValue(input.emoji)
        : undefined,
    overwrite: input.overwrite === true,
    addToIndex: input.add_to_index !== false,
    includes,
  });

  if (!result.created) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  return {
    content: JSON.stringify({
      created: true,
      skill_id: skillId.trim(),
      path: result.path,
      index_updated: result.indexUpdated,
    }),
    isError: false,
  };
}
