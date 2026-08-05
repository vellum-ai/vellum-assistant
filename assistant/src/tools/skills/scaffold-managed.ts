import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SkillSource } from "../../config/skills.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { upsertSkillCardInsertJob } from "../../persistence/jobs-store.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import {
  EXISTING_SKILL_THRESHOLD,
  nearestExistingSkills,
} from "../../plugins/defaults/memory/v3/candidate-match.js";
import { readInstallMeta } from "../../skills/install-meta.js";
import {
  createManagedSkill,
  getManagedSkillDir,
} from "../../skills/managed-store.js";
import { recordWatchdogEvent } from "../../telemetry/watchdog-events-store.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("scaffold-managed-skill");

/** Watchdog check_name for the per-creation skill-authoring counter. */
const SKILL_AUTHORED_CHECK_NAME = "skill_authored";

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
  if (raw === undefined) {
    return {};
  }
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
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return { value: normalized.length > 0 ? normalized : undefined };
}

/** Watchdog check_name for the retrospective dedup counter. */
const SKILL_DEDUP_CHECK_NAME = "skill_dedup";

/**
 * Count a dedup decision (admin analytics groups on the watchdog check_name).
 * The rate of these against total retrospective authoring is the first signal
 * we have for how much duplication the catalog was absorbing, split by
 * whether the covering skill was the assistant's own. Skill ids stay out of the detail bag: they derive from
 * user/model content, and watchdog events are metadata-only. Never throws.
 */
function recordDedupOutcome(outcome: "covered_own" | "covered_foreign"): void {
  try {
    recordWatchdogEvent({
      checkName: SKILL_DEDUP_CHECK_NAME,
      value: 1,
      detail: { outcome },
    });
  } catch {
    // recordWatchdogEvent already no-ops on opt-out and a missing telemetry
    // DB; anything past that is not worth surfacing here.
  }
}

/**
 * What the similarity check says a retrospective write should do.
 *
 * `proceed` means no existing skill confidently covers the procedure (or the
 * matcher had nothing usable to say), so the call creates the id it proposed.
 */
type DedupOutcome =
  | { kind: "proceed" }
  | {
      kind: "covered";
      skillId: string;
      source: string;
      ownedByAssistant: boolean;
    };

/**
 * Ask the skill matcher whether an existing skill already covers this
 * procedure, and enforce the answer.
 *
 * The retrospective's instructions already tell it to run this check and act
 * on it; until now nothing verified that it did, so a pass could author a
 * near-duplicate of a bundled skill (or a second copy of its own skill) just
 * by choosing a different `skill_id`. That is how one conversation ended up
 * producing two competing skills: an intermediate conclusion, then its own
 * correction captured as a sibling instead of a revision.
 *
 * This check is purely SUBTRACTIVE: it never writes, redirects, or retargets
 * anything. It only refuses a write that would add a duplicate, and every
 * refusal names what to do instead. Deliberately so, because the write it is
 * declining to make would otherwise become a second, competing skill, while
 * anything stronger (silently retargeting the write onto an existing skill)
 * would turn a background pass into an unattended overwrite of an artifact
 * the user may already rely on, with no undo. `createManagedSkill` writes
 * through an atomic rename and keeps no prior version.
 *
 * A confident match means the procedure is already covered, and the guidance
 * differs by ownership:
 *
 *   - a skill the assistant AUTHORED: refused, and the message names that
 *     skill, so a genuine improvement can land as an explicit
 *     `skill_id` + `overwrite: true` call. That path already exists and the
 *     prompt already asks for it; what changes is that a near-duplicate under
 *     a fresh id is no longer the easy accident. This is the case that
 *     produced two competing skills from one conversation: an intermediate
 *     conclusion, then its own correction captured as a sibling;
 *   - a skill it does NOT own (bundled, plugin, workspace, extra,
 *     user-authored, or untagged managed): refused, and the message routes
 *     the knowledge rather than discarding it, telling the pass to `remember`
 *     anything the covering skill does not capture (a failure mode, a
 *     precondition, a path that held steady). Nothing is mutated, nothing is
 *     shadowed.
 *
 * Deliberately FAIL-OPEN. This is best-effort deduplication, not a
 * correctness gate: an embedding or Qdrant outage makes
 * {@link nearestExistingSkills} return an empty shortlist, and the right
 * trade there is to let the skill be written (a duplicate is recoverable and
 * cheap to merge later) rather than to lose the capture entirely. An
 * unclassifiable hit is treated the same way.
 */
async function resolveRetrospectiveDedup(
  description: string,
  deps: {
    findNearest?: typeof nearestExistingSkills;
    loadCatalog?: () => { id: string; source: SkillSource }[];
    managedSkillExists?: (skillId: string) => boolean;
    readManagedAuthor?: (skillId: string) => "assistant" | "user" | undefined;
  },
): Promise<DedupOutcome> {
  const findNearest = deps.findNearest ?? nearestExistingSkills;
  const loadCatalog = deps.loadCatalog ?? (() => loadSkillCatalog());
  const managedSkillExists =
    deps.managedSkillExists ??
    ((skillId: string) =>
      existsSync(join(getManagedSkillDir(skillId), "SKILL.md")));
  const readManagedAuthor =
    deps.readManagedAuthor ??
    ((skillId: string) => {
      try {
        return readInstallMeta(getManagedSkillDir(skillId))?.author;
      } catch {
        return undefined;
      }
    });

  let hits: Array<{ skillId: string; score: number }>;
  try {
    hits = await findNearest(description);
  } catch (err) {
    log.warn({ err }, "skill dedup: matcher failed; proceeding without it");
    return { kind: "proceed" };
  }

  const top = hits
    .filter((hit) => hit.score >= EXISTING_SKILL_THRESHOLD)
    .sort((a, b) => b.score - a.score)[0];
  if (!top) {
    return { kind: "proceed" };
  }

  const catalogEntry = loadCatalog().find((s) => s.id === top.skillId);
  if (catalogEntry && catalogEntry.source !== "managed") {
    return {
      kind: "covered",
      skillId: top.skillId,
      source: catalogEntry.source,
      ownedByAssistant: false,
    };
  }
  if (!managedSkillExists(top.skillId)) {
    // Ranked but not resolvable on disk (a stale corpus entry): nothing
    // proven to collide with, so let the write proceed.
    return { kind: "proceed" };
  }
  return {
    kind: "covered",
    skillId: top.skillId,
    source: "managed",
    ownedByAssistant: readManagedAuthor(top.skillId) === "assistant",
  };
}

/**
 * Core execution logic for scaffold_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 *
 * `deps` injects the catalog, conversation-lookup, and skill-matcher seams so
 * the ownership backstop's non-managed collision check, the lineage
 * resolution, and the retrospective dedup can be exercised without standing
 * up a real bundled/plugin catalog, a live DB, or Qdrant.
 */
export async function executeScaffoldManagedSkill(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    loadCatalog?: () => { id: string; source: SkillSource }[];
    getConversation?: (
      id: string,
    ) => { forkParentConversationId: string | null } | null;
    findNearest?: typeof nearestExistingSkills;
    managedSkillExists?: (skillId: string) => boolean;
    readManagedAuthor?: (skillId: string) => "assistant" | "user" | undefined;
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

  // Validate and normalize companion files. Each entry carries the file bytes
  // exactly one way: inline `content`, or `copy_from` naming an on-disk source
  // the store validates and reads (managed-store.validateCompanionSource).
  let files:
    | Array<{ path: string; content?: string; copyFrom?: string }>
    | undefined;
  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) {
      return {
        content:
          "Error: files must be an array of { path, content | copy_from } objects",
        isError: true,
      };
    }
    const collected: Array<{
      path: string;
      content?: string;
      copyFrom?: string;
    }> = [];
    for (const item of input.files) {
      if (typeof item !== "object" || item === null) {
        return {
          content:
            "Error: each element in files must be a { path, content | copy_from } object",
          isError: true,
        };
      }
      const { path, content, copy_from } = item as Record<string, unknown>;
      if (typeof path !== "string" || !path.trim()) {
        return {
          content: "Error: each file must have a non-empty string path",
          isError: true,
        };
      }
      if ((content === undefined) === (copy_from === undefined)) {
        return {
          content: `Error: file "${path}" must set exactly one of content or copy_from`,
          isError: true,
        };
      }
      if (content !== undefined && typeof content !== "string") {
        return {
          content: "Error: each file's content must be a string",
          isError: true,
        };
      }
      if (copy_from !== undefined && typeof copy_from !== "string") {
        return {
          content: "Error: each file's copy_from must be a string path",
          isError: true,
        };
      }
      collected.push({
        path: path.trim(),
        ...(content !== undefined ? { content: content as string } : {}),
        ...(copy_from !== undefined ? { copyFrom: copy_from as string } : {}),
      });
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

  const proposedId = skillId.trim();
  const fromRetrospective =
    context.requestOrigin === MEMORY_RETROSPECTIVE_ORIGIN;
  const author = fromRetrospective ? "assistant" : "user";

  // Retrospective dedup: refuse a write that an existing skill already
  // covers, so a near-duplicate cannot land under a fresh id. Purely
  // subtractive and fail-open; see `resolveRetrospectiveDedup`.
  // User-directed scaffolds skip this entirely: when a person asks for a
  // skill, similarity to an existing one is not a reason to refuse it.
  const id = proposedId;
  if (fromRetrospective) {
    const dedup = await resolveRetrospectiveDedup(description, deps);
    if (dedup.kind === "covered") {
      recordDedupOutcome(
        dedup.ownedByAssistant ? "covered_own" : "covered_foreign",
      );
      log.info(
        { proposedId, coveredBy: dedup.skillId, source: dedup.source },
        "skill dedup: refusing a retrospective write already covered by an existing skill",
      );
      return {
        content: dedup.ownedByAssistant
          ? `Error: you already have the skill "${dedup.skillId}" for this procedure, so no second skill was created. If this conversation genuinely improves on it, call again with skill_id "${dedup.skillId}" and overwrite: true, rewriting it from what you observed here. If it does not, skip it.`
          : `Error: the skill "${dedup.skillId}" (${dedup.source}) already covers this procedure, and you may not modify or shadow it, so no skill was created. If this conversation showed something that skill does not capture (a failure mode you hit, a precondition, a value or path that held steady), save that with \`remember\` so it is available the next time "${dedup.skillId}" runs. If there is nothing new, skip it.`,
        isError: true,
      };
    }
  }

  // Whether a managed SKILL.md already existed before this call. Drives the
  // ownership backstop below, the created-vs-refined discriminant for the
  // skill-card enqueue, and the `skill_authored` telemetry counter: only a
  // genuine CREATE (no pre-existing skill, regardless of the `overwrite`
  // flag) gets a card or a counter event.
  const managedSkillExistedBefore = existsSync(
    join(getManagedSkillDir(id), "SKILL.md"),
  );

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
    if (
      managedSkillExistedBefore &&
      readInstallMeta(getManagedSkillDir(id))?.author !== "assistant"
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

  // Central adoption counter for skill authoring (admin analytics groups on
  // the watchdog check_name). Genuine creates only — refinements of a
  // pre-existing skill are not new capabilities and would double-count.
  // `authored_by` distinguishes proactive retrospective authoring from
  // user-directed scaffolds; the skill id itself stays out of the detail
  // bag — ids derive from user/model content (a name can encode a
  // customer or procedure), and watchdog events are metadata-only with no
  // deletion-redaction tie to the source conversation. Never throws: a
  // telemetry failure must not fail a scaffold that already succeeded.
  if (!managedSkillExistedBefore) {
    try {
      recordWatchdogEvent({
        checkName: SKILL_AUTHORED_CHECK_NAME,
        value: 1,
        detail: {
          authored_by: fromRetrospective ? "retrospective" : "user",
        },
      });
    } catch {
      // recordWatchdogEvent already no-ops on opt-out and a missing
      // telemetry DB; anything past that is not worth surfacing here.
    }
  }

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
