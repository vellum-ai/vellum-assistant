import { existsSync } from "node:fs";

import { touchSkillLastUsed } from "../skills/install-meta.js";
import {
  getManagedSkillDir,
  validateManagedSkillId,
} from "../skills/managed-store.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("schedule-skill-binding");

export interface ResolvedScheduleSkill {
  skillDir: string;
  versionHash: string;
}

export type ResolveScheduleSkillResult =
  | { ok: true; skill: ResolvedScheduleSkill }
  | { ok: false; error: string };

/**
 * Resolve the managed skill directory for a schedule's `skillId`.
 *
 * Every step is plain filesystem work — no daemon state — so this is safe to
 * call from the schedule worker process.
 */
export function resolveScheduleSkill(
  skillId: string,
): ResolveScheduleSkillResult {
  const idError = validateManagedSkillId(skillId);
  if (idError) {
    return { ok: false, error: `Invalid skill_id: ${idError}` };
  }

  const skillDir = getManagedSkillDir(skillId);
  if (!existsSync(skillDir)) {
    return {
      ok: false,
      error: `Managed skill "${skillId}" is not installed (expected at ${skillDir}). It may have been uninstalled or pruned.`,
    };
  }

  let versionHash: string;
  try {
    versionHash = computeSkillVersionHash(skillDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to compute the version hash for skill "${skillId}": ${message}`,
    };
  }

  return { ok: true, skill: { skillDir, versionHash } };
}

/**
 * Compare a schedule's pinned skill hash against the skill's current content.
 *
 * A schedule is approved once, at creation, and that approval binds a command
 * string — which does not change when the script the command invokes is
 * rewritten. Without this check a later edit to the skill (the memory
 * retrospective refining its own procedure, say) would keep firing unattended
 * under the original approval. Mirrors the `expectedSkillVersionHash` gate in
 * `tools/skills/skill-script-runner.ts`, which covers the tool-executor path.
 *
 * Returns an error message when the skill has changed, or `null` when the
 * schedule may run.
 */
export function checkPinnedSkillVersion(args: {
  skillId: string;
  pinnedHash: string | null;
  currentHash: string;
}): string | null {
  if (!args.pinnedHash) {
    return `Schedule is bound to skill "${args.skillId}" but carries no pinned version hash. Re-create the schedule to pin the skill's current content.`;
  }
  if (args.pinnedHash !== args.currentHash) {
    return `Skill "${args.skillId}" has been modified since this schedule was approved (pinned ${args.pinnedHash}, current ${args.currentHash}). Re-create or update the schedule to approve the new content.`;
  }
  return null;
}

/**
 * Validate the handoff/skill-binding inputs of a script-mode schedule and
 * resolve the fields to persist. Shared by the HTTP route and the
 * `schedule_create` / `schedule_update` tools so both pin the same way.
 *
 * Returns an error message instead of throwing — callers map it onto their
 * own error type.
 */
export function prepareScheduleSkillBinding(args: {
  skillId?: string | null;
  thenExecute?: boolean;
  /** The schedule's message; becomes the handoff's trusted action prompt. */
  message: string;
}):
  | {
      ok: true;
      binding: {
        thenExecute: boolean;
        skillId: string | null;
        skillVersionHash: string | null;
      };
    }
  | { ok: false; error: string } {
  const thenExecute = args.thenExecute ?? false;

  if (thenExecute && !args.message.trim()) {
    return {
      ok: false,
      error:
        "message is required when then_execute is set — it is the action prompt the agent turn receives alongside the script's output",
    };
  }

  if (args.skillId == null || args.skillId === "") {
    return {
      ok: true,
      binding: { thenExecute, skillId: null, skillVersionHash: null },
    };
  }

  const resolved = resolveScheduleSkill(args.skillId);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  return {
    ok: true,
    binding: {
      thenExecute,
      skillId: args.skillId,
      skillVersionHash: resolved.skill.versionHash,
    },
  };
}

/**
 * Stamp `lastUsedAt` on a bound skill's install metadata (day-debounced).
 *
 * Firing a schedule is real usage, but it never goes through the LLM
 * skill-activation path that normally stamps this. Without the stamp a skill
 * used only from a schedule looks stale forever and becomes eligible for the
 * memory maintenance prune, which would delete the very scripts the schedule
 * runs. Best-effort — the underlying write never throws.
 */
export function stampScheduleSkillUsage(
  skillId: string,
  skillDir: string,
): void {
  try {
    const today = new Date().toLocaleDateString("en-CA");
    touchSkillLastUsed(skillDir, today);
  } catch (err) {
    log.warn(
      { err, skillId },
      "Failed to stamp schedule-bound skill lastUsedAt (non-fatal)",
    );
  }
}
