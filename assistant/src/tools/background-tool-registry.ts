/**
 * In-memory registry for background tool executions.
 *
 * Background tools are long-running processes (e.g. bash, host_bash) that the
 * agent spawns and returns from immediately. When the process finishes, its
 * output is delivered back to the conversation via `wakeAgentForOpportunity`.
 *
 * The registry tracks active background tools so they can be listed, cancelled,
 * and cleaned up. The `toolName` field is intentionally generic (not limited to
 * shell tools) to support extending background execution to non-shell tools in
 * the future.
 */

export interface BackgroundTool {
  id: string;
  /** Tool type identifier (e.g. "bash", "host_bash"). */
  toolName: string;
  conversationId: string;
  command: string;
  startedAt: number;
  /** Kills the process (bash) or aborts the proxy (host_bash). */
  cancel: (reason?: string) => void;
}

/**
 * A finished background tool, retained briefly so a client that missed the live
 * `background_tool_completed` event (chat route unmounted, or opened on another
 * conversation) can recover the authoritative terminal status on rehydration
 * instead of wrongly retiring the entry as cancelled. Mirrors the ACP-run
 * snapshot route, which likewise reports recently-completed runs.
 */
export interface CompletedBackgroundTool {
  id: string;
  toolName: string;
  conversationId: string;
  command: string;
  startedAt: number;
  status: "completed" | "failed" | "cancelled";
  exitCode: number | null;
  output: string;
  completedAt: number;
}

/** Maximum number of concurrent background tools allowed. */
export const MAX_BACKGROUND_TOOLS = 20;

/** How many recently-completed tools to retain for rehydration recovery. */
export const MAX_COMPLETED_BACKGROUND_TOOLS = 50;

const registry = new Map<string, BackgroundTool>();

// FIFO ring of recently-completed tools, oldest first. Bounded by
// MAX_COMPLETED_BACKGROUND_TOOLS so a long-lived daemon can't accumulate
// unbounded captured output.
const completedRing: CompletedBackgroundTool[] = [];

/**
 * Registers a background tool in the in-memory store.
 * Throws if the registry would exceed {@link MAX_BACKGROUND_TOOLS}.
 */
export function registerBackgroundTool(tool: BackgroundTool): void {
  if (registry.size >= MAX_BACKGROUND_TOOLS) {
    throw new Error(
      `Background tool limit reached (max ${MAX_BACKGROUND_TOOLS}). Cancel an existing background tool before starting a new one.`,
    );
  }
  registry.set(tool.id, tool);
}

/** Removes a background tool entry by ID. */
export function removeBackgroundTool(id: string): void {
  registry.delete(id);
}

/**
 * Records a finished background tool in the recently-completed ring so the
 * client can recover its terminal status on rehydration. Idempotent per id —
 * a re-record (e.g. a racing close/error pair) replaces the existing entry
 * rather than duplicating it. Does not touch the active registry; callers still
 * {@link removeBackgroundTool} as before.
 */
export function recordCompletedBackgroundTool(
  completion: CompletedBackgroundTool,
): void {
  const existingIdx = completedRing.findIndex((c) => c.id === completion.id);
  if (existingIdx !== -1) {
    completedRing[existingIdx] = completion;
    return;
  }
  completedRing.push(completion);
  if (completedRing.length > MAX_COMPLETED_BACKGROUND_TOOLS) {
    completedRing.shift();
  }
}

/**
 * Returns the recently-completed tools, optionally filtered by
 * `conversationId`, oldest first.
 */
export function listCompletedBackgroundTools(
  conversationId?: string,
): CompletedBackgroundTool[] {
  const all = completedRing.slice();
  if (conversationId === undefined) return all;
  return all.filter((t) => t.conversationId === conversationId);
}

/**
 * Returns all registered background tools, optionally filtered by
 * `conversationId`.
 */
export function listBackgroundTools(conversationId?: string): BackgroundTool[] {
  const all = Array.from(registry.values());
  if (conversationId === undefined) {
    return all;
  }
  return all.filter((t) => t.conversationId === conversationId);
}

/**
 * Cancels a background tool by ID: calls `tool.cancel()`, removes the entry,
 * and returns `true`. Returns `false` if the ID is not found.
 */
export function cancelBackgroundTool(id: string, reason?: string): boolean {
  const tool = registry.get(id);
  if (!tool) {
    return false;
  }
  tool.cancel(reason);
  registry.delete(id);
  return true;
}

export function cancelBackgroundTools(
  shouldCancel: (tool: BackgroundTool) => boolean,
  reason?: string,
): BackgroundTool[] {
  const cancelled: BackgroundTool[] = [];
  for (const tool of Array.from(registry.values())) {
    if (!shouldCancel(tool)) continue;
    tool.cancel(reason);
    registry.delete(tool.id);
    cancelled.push(tool);
  }
  return cancelled;
}

/**
 * Generates a short prefixed ID for a background tool.
 * Format: `bg-<8 hex chars>` (e.g. `bg-a1b2c3d4`).
 */
export function generateBackgroundToolId(): string {
  return `bg-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Returns `true` when the registry is at or over the {@link MAX_BACKGROUND_TOOLS}
 * limit, meaning no new background tools can be registered. Callers should
 * check this **before** spawning a process to avoid leaking untracked
 * processes.
 */
export function isBackgroundToolLimitReached(): boolean {
  return registry.size >= MAX_BACKGROUND_TOOLS;
}

/**
 * Clears the entire registry. Intended for test cleanup only — production
 * code should use {@link cancelBackgroundTool} or {@link removeBackgroundTool}.
 */
export function _clearRegistryForTesting(): void {
  registry.clear();
  completedRing.length = 0;
}
