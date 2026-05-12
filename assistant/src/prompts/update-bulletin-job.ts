import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { runBackgroundJob } from "../runtime/background-job-runner.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceDirDisplay,
  getWorkspacePromptPath,
} from "../util/platform.js";

const log = getLogger("update-bulletin-job");

const HASH_CHECKPOINT_KEY = "updates:last_processed_hash";
const EMPTY_HASH = "empty";
/**
 * Hard timeout for the update-bulletin agent turn. The agent reads a small
 * markdown file and (usually) deletes it; 10 minutes is generous headroom for
 * a slow model + any tool calls (e.g. memory writes).
 */
const UPDATE_BULLETIN_TIMEOUT_MS = 10 * 60 * 1000;

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
 * If `<workspace>/UPDATES.md` has new (unprocessed) content, this drives a
 * background conversation through `runBackgroundJob` with a hint pointing at
 * the file. De-duplication uses a sha256 content hash stored in the
 * `updates:last_processed_hash` memory checkpoint — an `"empty"` sentinel
 * represents a missing/blank file so the job skips the common no-op case.
 *
 * The function never throws: any error inside `runBackgroundJob` is captured
 * in its structured result (which already emits an `activity.failed`
 * notification) and surrounding errors are logged at `warn` and swallowed,
 * so callers can safely invoke it in a non-awaited context.
 *
 * Checkpoint write rules (intentionally conservative — prefer retry over
 * poisoning the checkpoint when state is ambiguous):
 *   - File missing → checkpoint = `EMPTY_HASH`.
 *   - File present but unreadable → checkpoint UNCHANGED, warn logged.
 *   - `runBackgroundJob` returned `ok: false` → checkpoint UNCHANGED so the
 *     next startup retries. The runner has already emitted an
 *     `activity.failed` notification.
 *   - Job ran successfully + file deleted/empty → checkpoint = `EMPTY_HASH`.
 *   - Job ran successfully + file unchanged → checkpoint = current hash
 *     (agent intentionally left the file).
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

    const result = await runBackgroundJob({
      jobName: "update-bulletin",
      source: "update-bulletin",
      origin: "updates_bulletin",
      prompt: updateBulletinHint(),
      trustContext: {
        sourceChannel: "vellum",
        trustClass: "guardian",
      },
      callSite: "mainAgent",
      timeoutMs: UPDATE_BULLETIN_TIMEOUT_MS,
    });

    if (!result.ok) {
      log.warn(
        {
          conversationId: result.conversationId,
          errorKind: result.errorKind,
          err: result.error?.message,
        },
        "update-bulletin-job: runBackgroundJob returned ok=false; leaving checkpoint unchanged so next startup retries (failure notification already emitted by runner)",
      );
      return;
    }

    // Re-read after the job completed. We need to know whether the file was
    // deleted or modified to decide whether to advance the checkpoint.
    const after = readTrimmedContent(updatesPath);

    if (after.kind === "error") {
      log.warn(
        { err: after.err, path: updatesPath },
        "update-bulletin-job: failed to re-read UPDATES.md after job; leaving checkpoint unchanged so next startup retries",
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

    // Job succeeded and the file is still present — the agent intentionally
    // left it (or modified it). Record the current hash so we don't re-process
    // the same content on next startup.
    setMemoryCheckpoint(HASH_CHECKPOINT_KEY, computeHash(after.content));
  } catch (err) {
    log.warn(
      { err },
      "update-bulletin-job: outer flow threw; swallowing so callers can fire-and-forget",
    );
    return;
  }
}
