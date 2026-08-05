import { existsSync } from "node:fs";
import { join } from "node:path";

import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { upsertSkillCardInsertJob } from "../../persistence/jobs-store.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import {
  finalizePromotion,
  type StabilizerDeps,
  stabilizeRetrospectiveProcedure,
} from "../../plugins/defaults/memory/procedure-candidate-stabilizer.js";
import type { CandidateArtifact } from "../../plugins/defaults/memory/procedure-candidate-store.js";
import {
  createManagedSkill,
  getManagedSkillDir,
  validateCompanionSource,
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

/**
 * Materialize a retrospective observation's companion files into inline
 * bytes. A candidate can sit pending for days before it promotes, long after
 * a `copy_from` source (a workspace scratch file, a /tmp path) is gone, so
 * the bytes are read at capture time and persisted with the candidate rather
 * than the path. Uses the same validation the managed store applies to a
 * direct scaffold, so a candidate can never capture a source the store would
 * have refused.
 */
function materializeCompanionFiles(
  files: Array<{ path: string; content?: string; copyFrom?: string }>,
): { value?: Array<{ path: string; content: string }>; error?: string } {
  const materialized: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    if (file.content !== undefined) {
      materialized.push({ path: file.path, content: file.content });
      continue;
    }
    if (file.copyFrom === undefined) {
      return { error: `companion file "${file.path}" carries no content` };
    }
    const source = validateCompanionSource(file.copyFrom);
    if (source.error !== undefined || source.content === undefined) {
      return { error: source.error ?? "invalid copy_from source" };
    }
    materialized.push({ path: file.path, content: source.content });
  }
  return { value: materialized };
}

/**
 * Core execution logic for scaffold_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 *
 * Interactive and user-directed calls behave exactly as they always have: the
 * skill is created (or overwritten) immediately, tagged `author: "user"`.
 *
 * A call from the memory retrospective (`requestOrigin` is
 * `memory_retrospective`) instead routes through the procedure-candidate
 * stabilizer first: capture and promotion are separated, so a procedure
 * observed in one conversation is recorded durably as a pending candidate and
 * only becomes a live skill once it is confirmed (a second distinct source
 * conversation, or a confident match against a skill the assistant already
 * authored). When the stabilizer decides to promote, the canonical write
 * still happens here, through this one path, so capability-memory refresh,
 * the `skill_authored` counter, and the skill-created card all fire exactly
 * where they always did: at an actual promotion. See
 * `plugins/defaults/memory/procedure-candidate-stabilizer.ts`.
 *
 * `deps` injects the stabilizer seams so the promotion state machine can be
 * exercised without a live catalog, matcher, or database.
 */
export async function executeScaffoldManagedSkill(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    stabilizer?: StabilizerDeps;
    finalizePromotion?: typeof finalizePromotion;
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

  // Normalized frontmatter values, shared by the persisted SKILL.md and the
  // skill-card payload below so the card always shows the values as persisted.
  const normalizedName = sanitizeFrontmatterValue(name);
  const normalizedDescription = sanitizeFrontmatterValue(description);
  const normalizedEmoji =
    typeof input.emoji === "string"
      ? sanitizeFrontmatterValue(input.emoji)
      : undefined;

  // What actually gets written, once anything does. For a user-directed call
  // this is the call's own input. For a retrospective call the stabilizer
  // decides, and on promotion supplies the merged candidate artifact (which
  // carries companion bytes captured on earlier observations).
  let targetId = proposedId;
  let writeFiles = files;
  let promotedCandidateId: string | undefined;
  let sourceConversationId: string | undefined;
  let retrospectiveConversationId: string | undefined;

  if (fromRetrospective) {
    // Companion bytes are materialized BEFORE capture: a candidate outlives
    // the `copy_from` paths a single pass can see.
    const materialized = materializeCompanionFiles(files ?? []);
    if (materialized.error) {
      return { content: `Error: ${materialized.error}`, isError: true };
    }
    const artifact: CandidateArtifact = {
      name: normalizedName,
      description: normalizedDescription,
      bodyMarkdown,
      ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}),
      ...(includes ? { includes } : {}),
      ...(activationHints ? { activationHints } : {}),
      ...(avoidWhen ? { avoidWhen } : {}),
      ...(category ? { category } : {}),
      ...(materialized.value && materialized.value.length > 0
        ? { files: materialized.value }
        : {}),
    };

    const citedEvidence = normalizeOptionalStringArray(
      input.evidence_tool_use_ids,
      "evidence_tool_use_ids",
    );
    if (citedEvidence.error) {
      return { content: `Error: ${citedEvidence.error}`, isError: true };
    }

    const decision = await stabilizeRetrospectiveProcedure({
      runConversationId: context.conversationId,
      proposedSkillId: proposedId,
      artifact,
      citedToolUseIds: citedEvidence.value ?? [],
      deps: deps.stabilizer,
    });

    // Fail closed. The errored tool result carries no durable evidence, so
    // the observation stays available to a later pass.
    if (decision.kind === "failed") {
      return { content: `Error: ${decision.message}`, isError: true };
    }
    // Captured (pending or refined) and covered are both durable outcomes
    // that deliberately write no skill.
    if (decision.kind === "captured" || decision.kind === "covered") {
      return {
        content: JSON.stringify({
          created: false,
          status: decision.kind === "covered" ? "covered" : "pending",
          candidate_id: decision.candidateId,
          note: decision.message,
        }),
        isError: false,
      };
    }

    targetId = decision.targetSkillId;
    promotedCandidateId = decision.candidateId;
    sourceConversationId = decision.sourceConversationId;
    retrospectiveConversationId = context.conversationId;
    writeFiles = decision.artifact.files;
  }

  // Whether a managed SKILL.md already existed before this call. Drives the
  // created-vs-refined discriminant for the skill-card enqueue and the
  // `skill_authored` telemetry counter: only a genuine CREATE (no
  // pre-existing skill, regardless of the `overwrite` flag) gets a card or a
  // counter event. On a promotion retry the skill already exists, so neither
  // side effect repeats.
  const managedSkillExistedBefore = existsSync(
    join(getManagedSkillDir(targetId), "SKILL.md"),
  );

  const result = createManagedSkill({
    id: targetId,
    name: normalizedName,
    description: normalizedDescription,
    bodyMarkdown: bodyMarkdown,
    emoji: normalizedEmoji,
    // A promotion onto an existing skill is the canonical UPDATE of that
    // skill, so it always overwrites; a user-directed call keeps its explicit
    // flag.
    overwrite: fromRetrospective
      ? managedSkillExistedBefore
      : input.overwrite === true,
    includes,
    activationHints,
    avoidWhen,
    category,
    files: writeFiles,
    author: fromRetrospective ? "assistant" : "user",
    sourceConversationId,
    retrospectiveConversationId,
  });

  if (!result.created) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  // Close the candidate out against the skill it produced. Ordered AFTER the
  // write so a crash in between leaves the candidate promotable rather than
  // marked-but-unwritten; the retry then finds the skill on disk and lands as
  // a canonical update, which is why a lost mark can never mint a sibling or
  // repeat the card.
  if (promotedCandidateId) {
    const finalize = deps.finalizePromotion ?? finalizePromotion;
    try {
      await finalize(promotedCandidateId, targetId, deps.stabilizer);
    } catch (err) {
      log.warn(
        { err, candidateId: promotedCandidateId, skillId: targetId },
        "procedure candidate: finalization failed; the skill write stands and the open claim lets the same candidate resume",
      );
    }
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
            skillId: targetId,
            name: normalizedName,
            description: normalizedDescription,
            ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}),
          },
        ],
      });
      log.info(
        {
          skillId: targetId,
          sourceConversationId,
          runConversationId: retrospectiveConversationId,
        },
        "skill card: enqueued skill_card_insert for retrospective-authored skill",
      );
    } catch (err) {
      log.warn(
        { err, skillId: targetId, sourceConversationId },
        "skill card: failed to enqueue skill_card_insert; skill creation unaffected",
      );
    }
  }

  return {
    content: JSON.stringify({
      created: true,
      skill_id: targetId,
      path: result.path,
    }),
    isError: false,
  };
}
