// ---------------------------------------------------------------------------
// Memory Tool handlers
//
// remember: save facts to the PKB (buffer.md + daily archive) under the v1
// path, or to memory/buffer.md + memory/archive/<today>.md when memory v2 is
// active.
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { enqueuePkbIndexJob } from "../jobs/embed-pkb-file.js";
import { PKB_WORKSPACE_SCOPE } from "../pkb/types.js";
import { deleteNode, queryNodes, recordNodeEdit, updateNode } from "./store.js";

const log = getLogger("graph-tool-handlers");

// ---------------------------------------------------------------------------
// remember handler — writes to PKB (v1) or memory/ (v2) buffer + daily archive
// ---------------------------------------------------------------------------

export interface RememberInput {
  content: string;
  finish_turn?: boolean;
}

export interface RememberResult {
  success: boolean;
  message: string;
}

export function handleRemember(
  input: RememberInput,
  _conversationId: string,
  _scopeId: string,
  config: AssistantConfig,
): RememberResult {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, message: "content is required" };
  }

  const workspaceDir = getWorkspaceDir();
  const now = new Date();
  const entry = formatRememberEntry(input.content.trim(), now);

  if (config.memory.v2.enabled) {
    appendBufferAndArchive({
      rootDir: join(workspaceDir, "memory"),
      entry,
      now,
    });
    // v2 path skips the PKB re-index queue — embedding for memory v2 happens
    // via the dedicated `embed_concept_page` job after consolidation, not on
    // every remember() write.
    return { success: true, message: "Saved to knowledge base." };
  }

  const pkbDir = join(workspaceDir, "pkb");
  const { bufferPath, archivePath } = appendBufferAndArchive({
    rootDir: pkbDir,
    entry,
    now,
  });
  enqueuePkbReindex(pkbDir, bufferPath);
  enqueuePkbReindex(pkbDir, archivePath);

  return { success: true, message: "Saved to knowledge base." };
}

/**
 * Format `now` as a buffer-entry timestamp (`Mon D, h:mm AM/PM`). Exported so
 * the memory v2 consolidation job can present its cutoff in the same shape
 * the buffer entries use, making the agent's "timestamp ≥ cutoff" comparison
 * unambiguous at minute precision.
 */
export function formatBufferTimestamp(now: Date): string {
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${month} ${day}, ${displayHour}:${minutes} ${ampm}`;
}

/**
 * Build a timestamped bullet entry for `buffer.md` / `archive/<date>.md`.
 *
 * Format mirrors the long-standing v1 PKB layout so v2 buffers stay
 * human-readable and downstream consumers (sweep, consolidation) can parse
 * the same shape regardless of which path produced the entry.
 *
 * Exported so memory v2 sweep / extractor jobs format their auto-remembered
 * entries identically to user-facing `remember()` calls.
 */
export function formatRememberEntry(content: string, now: Date): string {
  return `- [${formatBufferTimestamp(now)}] ${content}\n`;
}

/**
 * Append `entry` to `<rootDir>/buffer.md` and `<rootDir>/archive/<today>.md`,
 * creating the archive directory and seeding the archive header if missing.
 *
 * Returns the absolute paths of both files so callers can fan out follow-up
 * work (e.g. PKB re-indexing in the v1 path).
 *
 * Exported so memory v2 background jobs (`sweep`, future LLM-driven
 * extractors) can append to `memory/buffer.md` + `memory/archive/<today>.md`
 * with exactly the same format `remember()` produces, keeping the two write
 * paths byte-compatible for downstream consumers (consolidation, search).
 */
export function appendBufferAndArchive(args: {
  rootDir: string;
  entry: string;
  now: Date;
}): { bufferPath: string; archivePath: string } {
  const { rootDir, entry, now } = args;
  const archiveDir = join(rootDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const bufferPath = join(rootDir, "buffer.md");
  appendFileSync(bufferPath, entry, "utf-8");

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const archivePath = join(archiveDir, `${yyyy}-${mm}-${dd}.md`);
  if (!existsSync(archivePath)) {
    const month = now.toLocaleString("en-US", { month: "short" });
    appendFileSync(
      archivePath,
      `# ${month} ${now.getDate()}, ${yyyy}\n\n`,
      "utf-8",
    );
  }
  appendFileSync(archivePath, entry, "utf-8");

  return { bufferPath, archivePath };
}

/**
 * Fire-and-forget enqueue of a PKB re-index job for a file we just wrote.
 *
 * Always indexes under {@link PKB_WORKSPACE_SCOPE}. See the comment on that
 * constant for why PKB points are not per-conversation-scoped.
 *
 * Wrapped in try/catch so an enqueue failure (e.g. DB hiccup) cannot break
 * the remember call — the write has already succeeded and the user's fact
 * is safe on disk.
 */
function enqueuePkbReindex(pkbRoot: string, absPath: string): void {
  try {
    enqueuePkbIndexJob({
      pkbRoot,
      absPath,
      memoryScopeId: PKB_WORKSPACE_SCOPE,
    });
  } catch (err) {
    log.warn({ err, absPath }, "Failed to enqueue PKB re-index job");
  }
}

// ---------------------------------------------------------------------------
// delete_memory handler
// ---------------------------------------------------------------------------

const MEMORY_SCOPE_DEFAULT = "default";
const SNIPPET_LENGTH = 80;

export interface DeleteMemoryInput {
  content: string;
  finish_turn?: boolean;
}

export interface DeleteMemoryResult {
  success: boolean;
  message: string;
}

/**
 * Soft-delete a memory graph node whose content matches the supplied text.
 *
 * Matching strategy (v2 only — the graph has addressable nodes):
 * 1. Exact match (case-insensitive, trimmed).
 * 2. Substring match — input is contained within a node's content.
 * If exactly one candidate is found it is soft-deleted (fidelity → "gone")
 * and its Qdrant vectors are queued for removal. If zero or multiple
 * candidates are found the tool returns an error so the caller can refine.
 *
 * For v1 (file-based PKB), editing markdown files in-place is too risky and
 * error-prone; callers should append a correction instead.
 */
export function handleDeleteMemory(
  input: DeleteMemoryInput,
  config: AssistantConfig,
): DeleteMemoryResult {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, message: "content is required" };
  }

  if (!config.memory.v2.enabled) {
    return {
      success: false,
      message:
        "delete_memory requires memory v2. Use remember() to record a correction instead.",
    };
  }

  const search = input.content.trim().toLowerCase();
  const nodes = queryNodes({
    scopeId: MEMORY_SCOPE_DEFAULT,
    fidelityNot: ["gone"],
  });

  const exactMatches = nodes.filter(
    (n) => n.content.trim().toLowerCase() === search,
  );

  const candidates =
    exactMatches.length > 0
      ? exactMatches
      : nodes.filter((n) => n.content.toLowerCase().includes(search));

  if (candidates.length === 0) {
    return {
      success: false,
      message:
        "No memory found matching that content. Use recall() to find the exact text first.",
    };
  }

  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 5)
      .map((n) => `- ${n.content.slice(0, SNIPPET_LENGTH)}`)
      .join("\n");
    return {
      success: false,
      message: `Multiple memories match — be more specific:\n${list}`,
    };
  }

  const target = candidates[0]!;
  deleteNode(target.id);
  return {
    success: true,
    message: `Deleted: "${target.content.slice(0, SNIPPET_LENGTH)}"`,
  };
}

// ---------------------------------------------------------------------------
// update_memory handler
// ---------------------------------------------------------------------------

export interface UpdateMemoryInput {
  old_content: string;
  new_content: string;
  finish_turn?: boolean;
}

export interface UpdateMemoryResult {
  success: boolean;
  message: string;
}

/**
 * Correct an existing memory graph node in place.
 *
 * Finds the node whose content matches `old_content` (same strategy as
 * handleDeleteMemory), updates it to `new_content`, and records the change in
 * the edit history table so the correction is auditable. Earned trust scores
 * (stability, significance, reinforcementCount) are preserved.
 *
 * v2 only — same rationale as handleDeleteMemory.
 */
export function handleUpdateMemory(
  input: UpdateMemoryInput,
  conversationId: string,
  config: AssistantConfig,
): UpdateMemoryResult {
  if (!input.old_content?.trim() || !input.new_content?.trim()) {
    return {
      success: false,
      message: "old_content and new_content are both required",
    };
  }

  if (!config.memory.v2.enabled) {
    return {
      success: false,
      message:
        "update_memory requires memory v2. Use remember() to record a correction instead.",
    };
  }

  const search = input.old_content.trim().toLowerCase();
  const newContent = input.new_content.trim();

  const nodes = queryNodes({
    scopeId: MEMORY_SCOPE_DEFAULT,
    fidelityNot: ["gone"],
  });

  const exactMatches = nodes.filter(
    (n) => n.content.trim().toLowerCase() === search,
  );

  const candidates =
    exactMatches.length > 0
      ? exactMatches
      : nodes.filter((n) => n.content.toLowerCase().includes(search));

  if (candidates.length === 0) {
    return {
      success: false,
      message:
        "No memory found matching old_content. Use recall() to find the exact text first.",
    };
  }

  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 5)
      .map((n) => `- ${n.content.slice(0, SNIPPET_LENGTH)}`)
      .join("\n");
    return {
      success: false,
      message: `Multiple memories match old_content — be more specific:\n${list}`,
    };
  }

  const target = candidates[0]!;
  recordNodeEdit({
    nodeId: target.id,
    previousContent: target.content,
    newContent,
    source: "manual",
    conversationId,
  });
  updateNode(target.id, { content: newContent });

  return {
    success: true,
    message: `Updated: "${target.content.slice(0, SNIPPET_LENGTH)}" → "${newContent.slice(0, SNIPPET_LENGTH)}"`,
  };
}
