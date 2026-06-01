/**
 * Events surface exposed under `window._vellumDebug.events`.
 *
 * Provides live introspection of SSE stream state: active clients, abort
 * signals, and a rolling buffer of the last 1 000 parsed events.
 *
 * Usage (browser console):
 *
 *   window._vellumDebug.events.getClients()
 *   window._vellumDebug.events.getEvents()
 *   window._vellumDebug.events.getLiveness()
 *
 * The accessors here read directly from the module-state registry in
 * `stream-debug.ts`. Installation onto `window` is performed by
 * `installVellumDebugApi` in `utils/debug-api.ts`, alongside the chat
 * namespace, so both halves of the debug API mount/unmount together.
 */

import {
  type SseDebugClient,
  type SseDebugEventEntry,
  type SseLivenessSnapshot,
  getSseClients,
  getSseEvents,
  getSseLivenessSnapshot,
} from "@/lib/streaming/stream-debug";
import { getSeqCursors } from "@/lib/streaming/last-seen-seq";

export interface ChatDebugEventsApi {
  /** Snapshot of currently-live SSE clients. */
  getClients: () => SseDebugClient[];
  /** Last 1 000 parsed SSE events (most-recent last). */
  getEvents: () => SseDebugEventEntry[];
  /**
   * Point-in-time SSE liveness: traffic/data ages and frame counts so a
   * half-open socket (no bytes for minutes, never errored) is
   * distinguishable from a healthy one.
   */
  getLiveness: () => SseLivenessSnapshot;
  /** Per-conversation seq cursors tracked by gap detection. */
  getSeqCursors: () => Record<string, number>;
}

/**
 * Singleton events surface. Stable identity across the app's lifetime
 * so the consolidated installer can identity-check on teardown.
 */
export const eventsDebugApi: ChatDebugEventsApi = {
  getClients: getSseClients,
  getEvents: getSseEvents,
  getLiveness: getSseLivenessSnapshot,
  getSeqCursors,
};
