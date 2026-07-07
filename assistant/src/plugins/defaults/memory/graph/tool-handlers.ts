// ---------------------------------------------------------------------------
// Memory Tool handlers
//
// remember: save facts to the PKB (buffer.md + daily archive) under the v1
// path, or to memory/buffer.md + memory/archive/<today>.md when memory v2 is
// active.
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AssistantConfig } from "../../../../config/types.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { getLogger } from "../../../../util/logger.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { enqueuePkbIndexJob } from "../jobs/embed-pkb-file.js";
import { PKB_WORKSPACE_SCOPE } from "../pkb/types.js";
import { deleteNode, queryNodes, recordNodeEdit, updateNode } from "./store.js";

const log = getLogger("graph-tool-handlers");

// ---------------------------------------------------------------------------
// remember handler — writes to PKB (v1) or memory/ (v2) buffer + daily archive
// ---------------------------------------------------------------------------

export interface RememberInput {
  /**
   * The fact(s) to remember. A single string records one fact; an array
   * records several independent facts in one call (each becomes its own
   * timestamped entry), so a single turn can batch unrelated facts instead of
   * calling `remember` once per fact.
   */
  content: string | string[];
  finish_turn?: boolean;
}

export interface RememberResult {
  success: boolean;
  message: string;
}

/**
 * Normalize the `remember` content input to a list of non-empty facts.
 * Accepts the single-string form or the batch array form, trims each fact, and
 * drops blanks so an empty or whitespace-only input yields no facts.
 */
function normalizeFacts(content: string | string[]): string[] {
  const raw = Array.isArray(content) ? content : [content];
  return raw
    .filter((fact): fact is string => typeof fact === "string")
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0);
}

function rememberSuccessMessage(count: number): string {
  return count === 1
    ? "Saved to knowledge base."
    : `Saved ${count} facts to knowledge base.`;
}

export function handleRemember(
  input: RememberInput,
  _conversationId: string,
  _scopeId: string,
  config: AssistantConfig,
): RememberResult {
  const facts = normalizeFacts(input.content);
  if (facts.length === 0) {
    return { success: false, message: "content is required" };
  }
  if (config.memory.enabled === false) {
    return { success: false, message: "Memory is disabled." };
  }

  const workspaceDir = getWorkspaceDir();
  const now = new Date();
  // Each fact becomes its own timestamped bullet; a batched call writes them
  // all in a single append so one turn can record several independent facts.
  const entry = facts.map((fact) => formatRememberEntry(fact, now)).join("");
  const message = rememberSuccessMessage(facts.length);

  if (config.memory.v2.enabled) {
    appendBufferAndArchive({
      rootDir: join(workspaceDir, "memory"),
      entry,
      now,
    });
    // v2 path skips the PKB re-index queue — embedding for memory v2 happens
    // via the dedicated `embed_concept_page` job after consolidation, not on
    // every remember() write.
    return { success: true, message };
  }

  const pkbDir = join(workspaceDir, "pkb");
  const { bufferPath, archivePath } = appendBufferAndArchive({
    rootDir: pkbDir,
    entry,
    now,
  });
  enqueuePkbReindex(pkbDir, bufferPath);
  enqueuePkbReindex(pkbDir, archivePath);

  return { success: true, message };
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
// Shared helpers for delete / update / list
// ---------------------------------------------------------------------------

const MEMORY_SCOPE_DEFAULT = "default";
const SNIPPET_LENGTH = 80;

// ---------------------------------------------------------------------------
// handleDeleteMemory
// ---------------------------------------------------------------------------

export interface DeleteMemoryInput {
  content: string;
}

export interface DeleteMemoryResult {
  success: boolean;
  message: string;
}

export function handleDeleteMemory(
  input: DeleteMemoryInput,
  config: AssistantConfig,
): DeleteMemoryResult {
  if (!input.content?.trim()) {
    return { success: false, message: "content is required" };
  }

  if (!config.memory.v2.enabled) {
    return {
      success: false,
      message:
        "delete requires memory v2. Use remember() to record a correction instead.",
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
        "No memory found matching that content. Use `vellum memory list` to find the exact text first.",
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
// handleUpdateMemory
// ---------------------------------------------------------------------------

export interface UpdateMemoryInput {
  old_content: string;
  new_content: string;
}

export interface UpdateMemoryResult {
  success: boolean;
  message: string;
}

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
        "update requires memory v2. Use remember() to record a correction instead.",
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
        "No memory found matching old_content. Use `vellum memory list` to find the exact text first.",
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
  enqueueMemoryJob("embed_graph_node", { nodeId: target.id });

  return {
    success: true,
    message: `Updated: "${target.content.slice(0, SNIPPET_LENGTH)}" → "${newContent.slice(0, SNIPPET_LENGTH)}"`,
  };
}

// ---------------------------------------------------------------------------
// handleListMemory
// ---------------------------------------------------------------------------

export interface ListMemoryInput {
  search?: string;
  limit?: number;
}

export interface ListMemoryItem {
  id: string;
  content: string;
  type: string;
  fidelity: string;
  created: number;
}

export interface ListMemoryResult {
  success: boolean;
  message: string;
  nodes: ListMemoryItem[];
  total: number;
}

export function handleListMemory(
  input: ListMemoryInput,
  config: AssistantConfig,
): ListMemoryResult {
  if (!config.memory.v2.enabled) {
    return {
      success: false,
      message: "list requires memory v2.",
      nodes: [],
      total: 0,
    };
  }

  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  const search = input.search?.trim().toLowerCase();

  // Fetch with a generous cap when searching (we filter after); otherwise use limit directly.
  const fetchLimit = search ? 500 : limit;
  const allNodes = queryNodes({
    scopeId: MEMORY_SCOPE_DEFAULT,
    fidelityNot: ["gone"],
    limit: fetchLimit,
  });

  const filtered = search
    ? allNodes
        .filter((n) => n.content.toLowerCase().includes(search))
        .slice(0, limit)
    : allNodes.slice(0, limit);

  return {
    success: true,
    message: `${filtered.length} memor${filtered.length === 1 ? "y" : "ies"} found.`,
    nodes: filtered.map((n) => ({
      id: n.id,
      content: n.content,
      type: n.type,
      fidelity: n.fidelity,
      created: n.created,
    })),
    total: filtered.length,
  };
}
