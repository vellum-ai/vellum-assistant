import { createKeyedSingleFlight } from "../util/single-flight.js";

export const runWakeSingleFlight = createKeyedSingleFlight();
const scheduledWakes = new Map<string, Map<string, Set<symbol>>>();

/** Tracks ownership while a wake is queued, hydrating, or executing. */
export function trackScheduledWake(
  conversationId: string,
  cronRunId?: string,
): () => void {
  if (cronRunId === undefined) {
    return () => {};
  }
  const runs =
    scheduledWakes.get(conversationId) ?? new Map<string, Set<symbol>>();
  const wakes = runs.get(cronRunId) ?? new Set<symbol>();
  const token = Symbol();
  wakes.add(token);
  runs.set(cronRunId, wakes);
  scheduledWakes.set(conversationId, runs);
  return () => {
    wakes.delete(token);
    if (wakes.size === 0) {
      runs.delete(cronRunId);
    }
    if (runs.size === 0) {
      scheduledWakes.delete(conversationId);
    }
  };
}

export function hasPendingAgentWake(
  conversationId: string,
  cronRunId?: string,
): boolean {
  return cronRunId === undefined
    ? runWakeSingleFlight.isPending(conversationId)
    : scheduledWakes.get(conversationId)?.has(cronRunId) === true;
}
