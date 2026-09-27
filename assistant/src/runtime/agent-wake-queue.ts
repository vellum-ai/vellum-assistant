import { createKeyedSingleFlight } from "../util/single-flight.js";

export const runWakeSingleFlight = createKeyedSingleFlight();
interface WakeOrigin {
  cronRunId?: string;
  startedAt?: number;
}
const pendingWakes = new Map<string, Map<symbol, WakeOrigin>>();

/** Tracks ownership while a wake is queued, hydrating, or executing. */
export function trackAgentWake(
  conversationId: string,
  origin: WakeOrigin,
): () => void {
  const wakes =
    pendingWakes.get(conversationId) ?? new Map<symbol, WakeOrigin>();
  const token = Symbol();
  wakes.set(token, origin);
  pendingWakes.set(conversationId, wakes);
  return () => {
    wakes.delete(token);
    if (wakes.size === 0) {
      pendingWakes.delete(conversationId);
    }
  };
}

export function hasPendingAgentWake(
  conversationId: string,
  cronRunId?: string,
  options?: { startedAfter?: number },
): boolean {
  if (cronRunId === undefined && options?.startedAfter === undefined) {
    return (
      runWakeSingleFlight.isPending(conversationId) ||
      pendingWakes.has(conversationId)
    );
  }
  return [...(pendingWakes.get(conversationId)?.values() ?? [])].some(
    (origin) =>
      (cronRunId === undefined || origin.cronRunId === cronRunId) &&
      (options?.startedAfter === undefined ||
        (origin.startedAt !== undefined &&
          origin.startedAt >= options.startedAfter)),
  );
}

/** @internal */
export function resetAgentWakeQueueForTests(): void {
  runWakeSingleFlight.reset();
  pendingWakes.clear();
}
