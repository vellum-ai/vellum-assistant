import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { upsertSkillCardInsertJob } from "../../persistence/jobs-store.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import {
  createManagedSkill,
  getManagedSkillDir,
} from "../../skills/managed-store.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("scaffold-managed-skill");

/** Strip embedded newlines/carriage returns to prevent YAML frontmatter injection. */
function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Validate + normalize an optional string-array input (sanitize, drop blanks,
 * dedupe). Returns `{ error }` on the first invalid element, or `{ value }`
 * holding the normalized array (undefined when empty). Shared by the
 * includes / activation_hints / avoid_when inputs so they behave identically.
 * Each element goes through sanitizeFrontmatterValue: activation_hints /
 * avoid_when are concatenated verbatim into capability memory text (see
 * buildSkillContent), so an embedded newline could otherwise smuggle an extra
 * prompt line into a future turn — collapse control chars the same way
 * name/description are.
 */
function normalizeOptionalStringArray(
  raw: unknown,
  field: string,
): { value?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) {
    return { error: `${field} must be an array of strings` };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return { error: `each element in ${field} must be a non-empty string` };
    }
    const cleaned = sanitizeFrontmatterValue(item);
    if (!cleaned) {
      return { error: `each element in ${field} must be a non-empty string` };
    }
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return { value: normalized.length > 0 ? normalized : undefined };
}

/**
 * Core execution logic for scaffold_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 *
 * `deps` injects the catalog and conversation-lookup seams so the ownership
 * backstop's non-managed collision check and the lineage resolution can be
 * exercised without standing up a real bundled/plugin catalog or a live DB.
 */
export async function executeScaffoldManagedSkill(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    loadCatalog?: () => { id: string; source: SkillSource }[];
    getConversation?: (
      id: string,
    ) => { forkParentConversationId: string | null } | null;
  } = {},
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

  // Validate and normalize the optional string-array inputs. `includes` lists
  // child skill IDs; activation_hints / avoid_when become the skill's
  // "Use when:" / "Avoid when:" retrieval signal in memory.
  const includesResult = normalizeOptionalStringArray(
    input.includes,
    "includes",
  );
  if (includesResult.error) {
    return { content: `Error: ${includesResult.error}`, isError: true };
  }
  const includes = includesResult.value;

  const activationHintsResult = normalizeOptionalStringArray(
    input.activation_hints,
    "activation_hints",
  );
  if (activationHintsResult.error) {
    return { content: `Error: ${activationHintsResult.error}`, isError: true };
  }
  const activationHints = activationHintsResult.value;

  const avoidWhenResult = normalizeOptionalStringArray(
    input.avoid_when,
    "avoid_when",
  );
  if (avoidWhenResult.error) {
    return { content: `Error: ${avoidWhenResult.error}`, isError: true };
  }
  const avoidWhen = avoidWhenResult.value;

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

  // Whether a managed SKILL.md already existed before this call. Resolved for
  // retrospective calls only — it drives both the ownership backstop below and
  // the created-vs-refined discriminant for the skill-card enqueue: only a
  // genuine CREATE (no pre-existing skill, regardless of the `overwrite` flag)
  // gets a card.
  let managedSkillExistedBefore = false;

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
    managedSkillExistedBefore = existsSync(join(managedDir, "SKILL.md"));
    if (
      managedSkillExistedBefore &&
      readInstallMeta(managedDir)?.author !== "assistant"
    ) {
      return {
        content: `Error: skill "${id}" is not verifiably assistant-authored; the retrospective may not overwrite it or write companion files into it. Author a new skill instead.`,
        isError: true,
      };
    }
  }

  // Conversation lineage (retrospective origin only). The retrospective runs
  // in a background fork of the conversation it distilled the procedure from,
  // so the fork's parent is this skill's durable source conversation.
  // Resolution is best-effort: a missing or unresolvable parent must never
  // fail the scaffold.
  let sourceConversationId: string | undefined;
  let retrospectiveConversationId: string | undefined;
  if (fromRetrospective && context.conversationId) {
    retrospectiveConversationId = context.conversationId;
    try {
      const lookupConversation = deps.getConversation ?? getConversation;
      sourceConversationId =
        lookupConversation(context.conversationId)?.forkParentConversationId ??
        undefined;
    } catch {
      // Lineage stays unset; the scaffold itself still proceeds.
    }
  }

  // Normalized frontmatter values, shared by the persisted SKILL.md and the
  // skill-card payload below so the card always shows the values as persisted.
  const normalizedName = sanitizeFrontmatterValue(name);
  const normalizedDescription = sanitizeFrontmatterValue(description);
  const normalizedEmoji =
    typeof input.emoji === "string"
      ? sanitizeFrontmatterValue(input.emoji)
      : undefined;

  const result = createManagedSkill({
    id,
    name: normalizedName,
    description: normalizedDescription,
    bodyMarkdown: bodyMarkdown,
    emoji: normalizedEmoji,
    overwrite: input.overwrite === true,
    includes,
    activationHints,
    avoidWhen,
    category,
    files,
    author,
    sourceConversationId,
    retrospectiveConversationId,
  });

  if (!result.created) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  refreshSkillCapabilityMemories();

  // Surface a genuine retrospective CREATE to the user as a skill card on the
  // source conversation, via the durable `skill_card_insert` delivery job
  // (memory-retrospective-skill-card.ts). The creation site is the one place
  // that knows created-vs-refined (`managedSkillExistedBefore` — an
  // `overwrite: true` call on a skill that did not previously exist is still a
  // create), the request origin, and the fork-parent lineage as facts.
  // Refinements of a pre-existing skill never get a card, and delivery needs a
  // resolved source conversation to land in. Best-effort: an enqueue failure
  // must never fail the scaffold — the skill is already created.
  if (
    fromRetrospective &&
    !managedSkillExistedBefore &&
    sourceConversationId &&
    retrospectiveConversationId
  ) {
    try {
      upsertSkillCardInsertJob({
        sourceConversationId,
        runConversationId: retrospectiveConversationId,
        skills: [
          {
            skillId: id,
            name: normalizedName,
            description: normalizedDescription,
            ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}),
          },
        ],
      });
      log.info(
        {
          skillId: id,
          sourceConversationId,
          runConversationId: retrospectiveConversationId,
        },
        "skill card: enqueued skill_card_insert for retrospective-authored skill",
      );
    } catch (err) {
      log.warn(
        { err, skillId: id, sourceConversationId },
        "skill card: failed to enqueue skill_card_insert; skill creation unaffected",
      );
    }
  }

  return {
    content: JSON.stringify({
      created: true,
      skill_id: id,
      path: result.path,
    }),
    isError: false,
  };
}
