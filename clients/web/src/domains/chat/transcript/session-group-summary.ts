export type SessionGroupPresentationState =
  | "working"
  | "waiting"
  | "finishing"
  | "completed"
  | "interrupted"
  | "disconnected"
  | "unavailable"
  | "settledSegment";

export interface SessionGroupSummaryInput {
  state: SessionGroupPresentationState;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  endedAt?: number | null;
  now?: number | null;
}

export interface SessionGroupSummaryDescriptor {
  state: SessionGroupPresentationState;
  durationSeconds: number | null;
  lastActivityAt: number | null;
  endedAt: number | null;
}

export function isActiveSessionGroupState(
  state: SessionGroupPresentationState,
): state is "working" | "waiting" | "finishing" {
  return state === "working" || state === "waiting" || state === "finishing";
}

export function shouldPulseSessionGroupState(
  state: SessionGroupPresentationState,
): boolean {
  return state === "working";
}

export function normalizeSessionTimestamp(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

/**
 * Derives the time-only presentation facts for a session header. Runtime
 * states remain presentation details and never expand the persisted status
 * model.
 */
export function describeSessionGroupSummary(
  input: SessionGroupSummaryInput,
): SessionGroupSummaryDescriptor {
  if (input.state === "unavailable") {
    return {
      state: input.state,
      durationSeconds: null,
      lastActivityAt: null,
      endedAt: null,
    };
  }

  const startedAt = normalizeSessionTimestamp(input.startedAt);
  const endedAt = normalizeSessionTimestamp(input.endedAt);
  const lastActivityAt = normalizeSessionTimestamp(input.lastActivityAt);
  const now = normalizeSessionTimestamp(input.now);
  const durationEnd = isActiveSessionGroupState(input.state)
    ? (now ?? lastActivityAt)
    : (endedAt ?? lastActivityAt);
  const durationSeconds =
    startedAt !== null && durationEnd !== null && durationEnd >= startedAt
      ? Math.floor((durationEnd - startedAt) / 1_000)
      : null;

  return { state: input.state, durationSeconds, lastActivityAt, endedAt };
}

/**
 * Seeds visit-owned disclosure state. Callers retain this state through
 * completion and override it for explicit user or deep-link choices.
 */
export function defaultSessionGroupOpen(observedLive: boolean): boolean {
  return observedLive;
}
