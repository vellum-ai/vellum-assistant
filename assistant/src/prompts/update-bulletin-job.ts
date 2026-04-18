import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { deleteConversation } from "../memory/conversation-crud.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceDirDisplay,
  getWorkspacePromptPath,
} from "../util/platform.js";

const log = getLogger("update-bulletin-job");

const HASH_CHECKPOINT_KEY = "updates:last_processed_hash";
const EMPTY_HASH = "empty";

function updateBulletinHint(): string {
  const workspace = getWorkspaceDirDisplay();
  return `Check ${workspace}/UPDATES.md — new release notes are present. Apply any assistant-facing behavior changes (new tools, deprecations, memory updates). If the user would benefit from knowing about a user-facing change, surface it only when the next topic makes it relevant — do not interrupt them with a proactive message. When you're done processing, delete the file by running \`cd "${workspace}" && rm UPDATES.md\` (the bare-filename \`rm UPDATES.md\` is auto-allowed; path-qualified deletes are not). A silent no-op is preferable to low-signal chatter.`;
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "error"; err: unknown }
  | { kind: "ok"; content: string };

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readTrimmedContent(path: string): ReadResult {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", content: readFileSync(path, "utf-8").trim() };
  } catch (err) {
    return { kind: "error", err };
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
 *
 * Checkpoint write rules (intentionally conservative — prefer retry over
 * poisoning the checkpoint when state is ambiguous):
 *   - File missing → checkpoint = `EMPTY_HASH`.
 *   - File present but unreadable → checkpoint UNCHANGED, warn logged.
 *   - Wake not invoked (e.g. resolver not yet registered) → UNCHANGED.
 *   - Wake invoked but no tool calls AND file unchanged → UNCHANGED
 *     (indistinguishable from a silent failure; safer to retry).
 *   - Wake invoked + (produced tool calls OR file deleted) → checkpoint
 *     reflects the post-wake state.
 */
export async function runUpdateBulletinJobIfNeeded(): Promise<void> {
  if (getConfig().updates.enabled === false) {
    return;
  }

  try {
    const updatesPath = getWorkspacePromptPath("UPDATES.md");
    const initial = readTrimmedContent(updatesPath);

    if (initial.kind === "error") {
      log.warn(
        { err: initial.err, path: updatesPath },
        "update-bulletin-job: failed to read UPDATES.md; leaving checkpoint unchanged so next startup retries",
      );
      return;
    }

    if (initial.kind === "missing" || initial.content.length === 0) {
      const stored = getMemoryCheckpoint(HASH_CHECKPOINT_KEY);
      if (stored !== EMPTY_HASH) {
        setMemoryCheckpoint(HASH_CHECKPOINT_KEY, EMPTY_HASH);
      }
      return;
    }

    const currentHash = computeHash(initial.content);
    const stored = getMemoryCheckpoint(HASH_CHECKPOINT_KEY);
    if (stored === currentHash) {
      return;
    }

    const conv = bootstrapConversation({
      conversationType: "background",
      source: "updates_bulletin",
      origin: "updates_bulletin",
      systemHint: "Processing release updates",
      groupId: "system:background",
    });
    const wakeResult = await wakeAgentForOpportunity({
      conversationId: conv.id,
      hint: updateBulletinHint(),
      source: "updates_bulletin",
    });

    if (!wakeResult.invoked) {
      log.warn(
        { conversationId: conv.id, reason: wakeResult.reason },
        "Update bulletin wake silently no-op'd (invoked=false); cleaning up orphan background conversation and leaving checkpoint unchanged so next startup retries",
      );
      // Belt-and-suspenders cleanup: `wakeAgentForOpportunity()` can return
      // `{invoked: false}` for reasons unrelated to the wake-resolver
      // registration order (resolver returns null because the conversation
      // cannot be hydrated, etc.). Without this cleanup each such occurrence
      // leaks a conversation DB row.
      //
      // Wrapped in its own try/catch so a cleanup failure never propagates
      // out of this fire-and-forget task.
      //
      // TODO: the `queueGenerateConversationTitle()` call that
      // `bootstrapConversation()` fires is already in flight by the time we
      // reach here. The title service checks `isReplaceableTitle()` before
      // writing, but the LLM sidechain call itself still runs against the
      // now-deleted conversation id. Adding a cancellation/existence hook
      // in `conversation-title-service.ts` would plug this one-call waste,
      // but this code path is rare, so we accept the one-time cost.
      try {
        deleteConversation(conv.id);
      } catch (err) {
        log.warn(
          { err, conversationId: conv.id },
          "update-bulletin-job: failed to delete orphan background conversation; continuing",
        );
      }
      return;
    }

    // Re-read after the wake. We need to know whether the file was deleted
    // or modified to decide whether to advance the checkpoint.
    const after = readTrimmedContent(updatesPath);

    if (after.kind === "error") {
      log.warn(
        { err: after.err, path: updatesPath },
        "update-bulletin-job: failed to re-read UPDATES.md after wake; leaving checkpoint unchanged so next startup retries",
      );
      return;
    }

    const fileMissingOrEmpty =
      after.kind === "missing" || after.content.length === 0;

    if (fileMissingOrEmpty) {
      // The agent (or another process) emptied/removed the file. This is the
      // expected happy path — record the empty sentinel.
      setMemoryCheckpoint(HASH_CHECKPOINT_KEY, EMPTY_HASH);
      return;
    }

    if (!wakeResult.producedToolCalls) {
      // Wake returned cleanly but the agent did nothing observable AND the
      // file is still here. We can't distinguish "agent processed and chose
      // to no-op" from "silent failure", so leave the checkpoint alone and
      // let the next startup retry.
      log.warn(
        { conversationId: conv.id },
        "update-bulletin-job: wake produced no tool calls and file is unchanged; leaving checkpoint unchanged so next startup retries",
      );
      return;
    }

    // Wake produced tool calls and the file is still present — the agent
    // intentionally left it (or modified it). Record the current hash so we
    // don't re-wake on the same content.
    setMemoryCheckpoint(HASH_CHECKPOINT_KEY, computeHash(after.content));
  } catch (err) {
    log.warn(
      { err },
      "update-bulletin-job: wake flow threw; swallowing so callers can fire-and-forget",
    );
    return;
  }
}
