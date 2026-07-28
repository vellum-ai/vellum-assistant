/**
 * Backwards-compat gate: subagent reconcile endpoint.
 *
 * From assistant 0.10.0, `GET /subagents/reconcile` reports the live status
 * of a parent conversation's subagents. Assistants older than that 404 the
 * route, and the reconcile triggers fire on every conversation mount and
 * SSE reopen — an unconditional call would produce a steady stream of
 * failed requests against older installations.
 *
 * Response *enrichment* (label/objective/child conversation id, added in
 * 0.10.13) is not gated here: `reconcileFromDaemon` degrades per-field, so
 * a bare `{status}` response from 0.10.0–0.10.12 still updates known
 * entries and stubs unknowns.
 */
import { assistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.0";

/**
 * Snapshot check (safe outside React — stream handlers, store actions):
 * `true` when the connected assistant serves `GET /subagents/reconcile`.
 */
export function supportsSubagentsReconcile(): boolean {
  return assistantSupports(MIN_VERSION);
}
