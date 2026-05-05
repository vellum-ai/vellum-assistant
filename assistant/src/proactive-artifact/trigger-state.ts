import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { rawGet } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("proactive-artifact-trigger");

const TRIGGER_MIN = 4;
const TRIGGER_MAX = 10;

function guardPath(): string {
  return join(getDataDir(), ".proactive-artifact-completed");
}

/**
 * Count user messages in standard conversations with created_at <= beforeOrAt.
 * LIMIT caps scan cost since we only care about thresholds up to TRIGGER_MAX.
 */
export function getUserMessageCountUpTo(beforeOrAt: number): number {
  const row = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
      SELECT 1 FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.role = 'user'
        AND c.conversation_type = 'standard'
        AND m.created_at <= ?
      LIMIT ${TRIGGER_MAX + 1}
    ) sub`,
    beforeOrAt,
  );
  return row?.c ?? 0;
}

/**
 * Fast-path check to avoid the COUNT query on every turn.
 * Returns true if the proactive artifact trigger has already fired.
 */
export function hasProactiveArtifactCompleted(): boolean {
  return existsSync(guardPath());
}

/**
 * Atomic check-and-claim with count-first ordering.
 *
 * Trigger window: messages TRIGGER_MIN–TRIGGER_MAX (4–10). Returns true if
 * count is in-window and exclusive file create succeeded. The guard acts as
 * an in-flight lock — the job releases it on decision-skip so the next turn
 * can retry. Past the window, the guard is written permanently.
 */
export function tryClaimProactiveArtifactTrigger(
  userMessageCreatedAt: number,
): boolean {
  const count = getUserMessageCountUpTo(userMessageCreatedAt);

  if (count < TRIGGER_MIN) {
    return false;
  }

  if (count > TRIGGER_MAX) {
    try {
      mkdirSync(dirname(guardPath()), { recursive: true });
      writeFileSync(guardPath(), new Date().toISOString(), { flag: "wx" });
    } catch {
      // Already written or fs error — either way, window is closed
    }
    return false;
  }

  // count in [TRIGGER_MIN, TRIGGER_MAX] — attempt exclusive guard write
  try {
    mkdirSync(dirname(guardPath()), { recursive: true });
    writeFileSync(guardPath(), new Date().toISOString(), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return false;
    }
    log.warn({ err }, "Failed to write proactive artifact guard file");
    return false;
  }
}

/**
 * Release the in-flight claim so the next turn can retry.
 * Called when the decision phase skips (no build committed).
 */
export function releaseProactiveArtifactClaim(): void {
  try {
    rmSync(guardPath(), { force: true });
  } catch {
    // Best-effort — if removal fails, the next turn just won't retry
  }
}

/**
 * Called at daemon startup. If the guard file does not exist and the user
 * already has messages past the trigger window, write the guard. This
 * handles existing users who had many messages before the feature existed.
 */
export function backfillGuardIfNeeded(): void {
  if (hasProactiveArtifactCompleted()) {
    return;
  }

  const count = getUserMessageCountUpTo(Date.now());
  if (count > TRIGGER_MAX) {
    try {
      mkdirSync(dirname(guardPath()), { recursive: true });
      writeFileSync(guardPath(), new Date().toISOString(), { flag: "wx" });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "EEXIST") {
        return;
      }
      log.warn({ err }, "Failed to backfill proactive artifact guard file");
    }
  }
}
