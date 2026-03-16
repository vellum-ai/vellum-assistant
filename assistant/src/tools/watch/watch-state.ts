import { getLogger } from "../../util/logger.js";

const log = getLogger("watch");

export interface WatchObservationEntry {
  ocrText: string;
  appName?: string;
  windowTitle?: string;
  bundleIdentifier?: string;
  timestamp: number;
  captureIndex: number;
}

export interface WatchSession {
  watchId: string;
  conversationId: string;
  focusArea: string;
  durationSeconds: number;
  intervalSeconds: number;
  observations: WatchObservationEntry[];
  commentaryCount: number;
  status: "active" | "completing" | "completed" | "cancelled";
  startedAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Guards against concurrent generateSummary calls */
  summaryInFlight?: boolean;
}

/** Module-level map of watch sessions keyed by watchId. */
export const watchSessions = new Map<string, WatchSession>();

// ── Start notifiers ─────────────────────────────────────────────────
const startNotifiers = new Map<string, (session: WatchSession) => void>();

export function registerWatchStartNotifier(
  conversationId: string,
  callback: (session: WatchSession) => void,
): void {
  startNotifiers.set(conversationId, callback);
}

export function unregisterWatchStartNotifier(conversationId: string): void {
  startNotifiers.delete(conversationId);
}

export function fireWatchStartNotifier(
  conversationId: string,
  session: WatchSession,
): void {
  startNotifiers.get(conversationId)?.(session);
}

// ── Commentary notifiers ────────────────────────────────────────────
const commentaryNotifiers = new Map<string, (session: WatchSession) => void>();

export function registerWatchCommentaryNotifier(
  conversationId: string,
  callback: (session: WatchSession) => void,
): void {
  commentaryNotifiers.set(conversationId, callback);
}

export function unregisterWatchCommentaryNotifier(
  conversationId: string,
): void {
  commentaryNotifiers.delete(conversationId);
}

export function fireWatchCommentaryNotifier(
  conversationId: string,
  session: WatchSession,
): void {
  commentaryNotifiers.get(conversationId)?.(session);
}

// ── Completion notifiers ────────────────────────────────────────────
const completionNotifiers = new Map<string, (session: WatchSession) => void>();

export function registerWatchCompletionNotifier(
  conversationId: string,
  callback: (session: WatchSession) => void,
): void {
  completionNotifiers.set(conversationId, callback);
}

export function unregisterWatchCompletionNotifier(
  conversationId: string,
): void {
  completionNotifiers.delete(conversationId);
}

export function fireWatchCompletionNotifier(
  conversationId: string,
  session: WatchSession,
): void {
  completionNotifiers.get(conversationId)?.(session);
}

// ── Conversation helpers ─────────────────────────────────────────────────

/** Find the first active watch session for a given conversationId. */
export function getActiveWatchSession(
  conversationId: string,
): WatchSession | undefined {
  for (const session of watchSessions.values()) {
    if (
      session.conversationId === conversationId &&
      session.status === "active"
    ) {
      return session;
    }
  }
  return undefined;
}

/** Add an observation to a watch session. */
export function addObservation(
  watchId: string,
  observation: WatchObservationEntry,
): void {
  const session = watchSessions.get(watchId);
  if (!session) {
    log.warn({ watchId }, "Cannot add observation: session not found");
    return;
  }
  session.observations.push(observation);
  log.info(
    { watchId, captureIndex: observation.captureIndex },
    "Observation added",
  );
}

/** Remove completed/cancelled sessions for a given conversationId. */
export function pruneWatchSessions(conversationId: string): void {
  for (const [watchId, session] of watchSessions) {
    if (session.conversationId !== conversationId) continue;
    if (session.status === "completed" || session.status === "cancelled") {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      watchSessions.delete(watchId);
    }
  }
}
