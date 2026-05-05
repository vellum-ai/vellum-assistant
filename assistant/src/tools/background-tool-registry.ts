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

/** Maximum number of concurrent background tools allowed. */
export const MAX_BACKGROUND_TOOLS = 20;

const registry = new Map<string, BackgroundTool>();

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
}
