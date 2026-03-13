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
  sessionId: string;
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
  sessionId: string,
  callback: (session: WatchSession) => void,
): void {
  startNotifiers.set(sessionId, callback);
}

export function unregisterWatchStartNotifier(sessionId: string): void {
  startNotifiers.delete(sessionId);
}

export function fireWatchStartNotifier(
  sessionId: string,
  session: WatchSession,
): void {
  startNotifiers.get(sessionId)?.(session);
}

// ── Commentary notifiers ────────────────────────────────────────────
const commentaryNotifiers = new Map<string, (session: WatchSession) => void>();

export function registerWatchCommentaryNotifier(
  sessionId: string,
  callback: (session: WatchSession) => void,
): void {
  commentaryNotifiers.set(sessionId, callback);
}

export function unregisterWatchCommentaryNotifier(sessionId: string): void {
  commentaryNotifiers.delete(sessionId);
}

export function fireWatchCommentaryNotifier(
  sessionId: string,
  session: WatchSession,
): void {
  commentaryNotifiers.get(sessionId)?.(session);
}

// ── Completion notifiers ────────────────────────────────────────────
const completionNotifiers = new Map<string, (session: WatchSession) => void>();

export function registerWatchCompletionNotifier(
  sessionId: string,
  callback: (session: WatchSession) => void,
): void {
  completionNotifiers.set(sessionId, callback);
}

export function unregisterWatchCompletionNotifier(sessionId: string): void {
  completionNotifiers.delete(sessionId);
}

export function fireWatchCompletionNotifier(
  sessionId: string,
  session: WatchSession,
): void {
  completionNotifiers.get(sessionId)?.(session);
}

// ── Session helpers ─────────────────────────────────────────────────

/** Find the first active watch session for a given sessionId. */
export function getActiveWatchSession(
  sessionId: string,
): WatchSession | undefined {
  for (const session of watchSessions.values()) {
    if (session.sessionId === sessionId && session.status === "active") {
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

/** Remove completed/cancelled sessions for a given sessionId. */
export function pruneWatchSessions(sessionId: string): void {
  for (const [watchId, session] of watchSessions) {
    if (session.sessionId !== sessionId) continue;
    if (session.status === "completed" || session.status === "cancelled") {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      watchSessions.delete(watchId);
    }
  }
}
