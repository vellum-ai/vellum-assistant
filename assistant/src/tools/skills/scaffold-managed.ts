import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import {
  createManagedSkill,
  getManagedSkillDir,
} from "../../skills/managed-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Origin tag the memory-retrospective wake stamps onto `ToolContext`. Scaffolds
 * under this origin are tagged `author: "assistant"` and may not folder-rewrite
 * a `author: "user"` skill (see the backstop in `executeScaffoldManagedSkill`).
 */
const MEMORY_RETROSPECTIVE_ORIGIN = "memory_retrospective";

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
  context: ToolContext,
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

  const fromRetrospective =
    context.requestOrigin === MEMORY_RETROSPECTIVE_ORIGIN;
  const author = fromRetrospective ? "assistant" : "user";

  // Backstop: a retrospective pass may only overwrite or write companion files
  // into a skill IT authored. Refuse an overwrite OR companion-file write that
  // targets an EXISTING skill that is not `author: "assistant"` — i.e. both
  // `author: "user"` AND untagged/legacy skills (e.g. those created via the
  // `createSkill` API route, whose install-meta carries no author) are
  // protected, matching the prune side where untagged skills are never pruned.
  // The prompt already directs the model to refine such skills conservatively or
  // author a new one; this is the enforcement layer behind that judgement call.
  // `readInstallMeta` returns null for a not-yet-existing skill, so a fresh
  // create falls through.
  if (fromRetrospective && (input.overwrite === true || files !== undefined)) {
    const existingMeta = readInstallMeta(getManagedSkillDir(skillId.trim()));
    if (existingMeta !== null && existingMeta.author !== "assistant") {
      return {
        content: `Error: skill "${skillId.trim()}" is not assistant-authored; the retrospective may not overwrite it or write companion files into it. Author a new skill instead.`,
        isError: true,
      };
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
    includes,
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
      skill_id: skillId.trim(),
      path: result.path,
    }),
    isError: false,
  };
}
