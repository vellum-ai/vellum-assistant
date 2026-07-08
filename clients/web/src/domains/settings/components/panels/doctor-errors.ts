/**
 * User-facing copy for Doctor-service availability failures.
 *
 * The Doctor panel proxies through Django to a separately-deployed Doctor
 * service whose replicas cycle during deploys and autoscaler scale-downs.
 * Django maps those upstream connection failures to gateway-class statuses
 * (502/503/504) with bodies like `{"detail": "Bad gateway"}`. Surfacing that
 * raw detail reads as the *assistant* being unreachable — a different failure
 * domain — so these statuses get a Doctor-specific transient message instead.
 */
export const DOCTOR_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([
  502, 503, 504,
]);

const DOCTOR_UNAVAILABLE_BASE =
  "Doctor is temporarily unavailable — this is usually brief. Your assistant itself is not affected.";

export const DOCTOR_UNAVAILABLE_MESSAGE = `${DOCTOR_UNAVAILABLE_BASE} Please try again in a moment.`;

export const DOCTOR_UNAVAILABLE_STREAM_MESSAGE = `${DOCTOR_UNAVAILABLE_BASE} Start a new session to continue.`;

/**
 * Terminal error message for the Doctor SSE stream once the reconnect
 * budget is exhausted.
 */
export function doctorStreamTerminalMessage(
  failedStatus: number | null,
): string {
  if (failedStatus === null) {
    return "Event stream disconnected. Start a new session to continue.";
  }
  if (DOCTOR_UNAVAILABLE_STATUSES.has(failedStatus)) {
    return DOCTOR_UNAVAILABLE_STREAM_MESSAGE;
  }
  return `Failed to connect to event stream (${failedStatus}). Start a new session to continue.`;
}
