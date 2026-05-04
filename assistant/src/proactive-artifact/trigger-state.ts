import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { rawGet } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("proactive-artifact-trigger");

function guardPath(): string {
  return join(getDataDir(), ".proactive-artifact-completed");
}

/**
 * Count user messages in standard conversations with created_at <= beforeOrAt.
 * LIMIT 5 caps scan cost since we only care about the threshold around 4.
 */
export function getUserMessageCountUpTo(beforeOrAt: number): number {
  const row = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
      SELECT 1 FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.role = 'user'
        AND c.conversation_type = 'standard'
        AND m.created_at <= ?
      LIMIT 5
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
 * Atomic check-and-claim with correct count-first ordering.
 *
 * Returns true if this call successfully claimed the trigger (count === 4
 * and exclusive file create succeeded). Returns false in all other cases.
 *
 * Count > 4 returns false WITHOUT writing the guard — this preserves the
 * 4th-turn trigger window when the 5th message races ahead.
 */
export function tryClaimProactiveArtifactTrigger(
  userMessageCreatedAt: number,
): boolean {
  const count = getUserMessageCountUpTo(userMessageCreatedAt);

  if (count < 4) {
    return false;
  }

  if (count > 4) {
    return false;
  }

  // count === 4 — attempt exclusive guard write
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
 * Called at daemon startup. If the guard file does not exist and the user
 * already has >= 5 messages, write the guard. This handles existing users
 * who had >4 messages before the feature existed.
 */
export function backfillGuardIfNeeded(): void {
  if (hasProactiveArtifactCompleted()) {
    return;
  }

  const count = getUserMessageCountUpTo(Date.now());
  if (count >= 5) {
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
