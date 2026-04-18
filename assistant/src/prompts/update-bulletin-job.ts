import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";

const log = getLogger("update-bulletin-job");

const HASH_CHECKPOINT_KEY = "updates:last_processed_hash";
const EMPTY_HASH = "empty";
const UPDATE_BULLETIN_HINT =
  "Check ~/.vellum/workspace/UPDATES.md — new release notes are present. Apply any assistant-facing behavior changes (new tools, deprecations, memory updates). If the user would benefit from knowing about a user-facing change, surface it only when the next topic makes it relevant — do not interrupt them with a proactive message. When you're done processing, delete UPDATES.md with `rm ~/.vellum/workspace/UPDATES.md` (already auto-allowed). A silent no-op is preferable to low-signal chatter.";

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readTrimmedContent(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget background processor for the release-notes bulletin.
 *
 * If `~/.vellum/workspace/UPDATES.md` has new (unprocessed) content, this
 * bootstraps a background conversation and wakes the agent loop with a hint
 * pointing at the file. De-duplication uses a sha256 content hash stored in
 * the `updates:last_processed_hash` memory checkpoint — an `"empty"` sentinel
 * represents a missing/blank file so the job skips the common no-op case.
 *
 * The function never throws: any error inside the bootstrap/wake flow is
 * logged at `warn` and swallowed, so callers can safely invoke it in a
 * non-awaited context.
 */
export async function runUpdateBulletinJobIfNeeded(): Promise<void> {
  if (getConfig().updates.enabled === false) {
    return;
  }

  const updatesPath = getWorkspacePromptPath("UPDATES.md");
  const trimmed = readTrimmedContent(updatesPath);

  if (trimmed === null || trimmed.length === 0) {
    const stored = getMemoryCheckpoint(HASH_CHECKPOINT_KEY);
    if (stored !== EMPTY_HASH) {
      setMemoryCheckpoint(HASH_CHECKPOINT_KEY, EMPTY_HASH);
    }
    return;
  }

  const currentHash = computeHash(trimmed);
  const stored = getMemoryCheckpoint(HASH_CHECKPOINT_KEY);
  if (stored === currentHash) {
    return;
  }

  try {
    const conv = bootstrapConversation({
      conversationType: "background",
      source: "updates-bulletin",
      origin: "updates-bulletin",
      systemHint: "Processing release updates",
      groupId: "system:background",
    });
    await wakeAgentForOpportunity({
      conversationId: conv.id,
      hint: UPDATE_BULLETIN_HINT,
      source: "updates-bulletin",
    });

    // Self-healing: re-read after the wake. If the agent deleted the file
    // (or emptied it), store the empty sentinel. Otherwise, store the
    // fresh hash so we don't re-wake on the same content if the agent
    // chose to no-op.
    const afterTrimmed = readTrimmedContent(updatesPath);
    if (afterTrimmed === null || afterTrimmed.length === 0) {
      setMemoryCheckpoint(HASH_CHECKPOINT_KEY, EMPTY_HASH);
    } else {
      setMemoryCheckpoint(HASH_CHECKPOINT_KEY, computeHash(afterTrimmed));
    }
  } catch (err) {
    log.warn(
      { err },
      "update-bulletin-job: wake flow threw; swallowing so callers can fire-and-forget",
    );
    return;
  }
}
