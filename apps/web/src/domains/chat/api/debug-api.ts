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
 *
 * The accessors here read directly from the module-state registry in
 * `stream-debug.ts`. Installation onto `window` is performed by
 * `installVellumDebugApi` in `utils/debug-api.ts`, alongside the chat
 * namespace, so both halves of the debug API mount/unmount together.
 */

import type {
  SseDebugClient,
  SseDebugEventEntry,
} from "@/domains/chat/api/stream-debug";
import {
  getSseClients,
  getSseEvents,
} from "@/domains/chat/api/stream-debug";

export interface ChatDebugEventsApi {
  /** Snapshot of currently-live SSE clients. */
  getClients: () => SseDebugClient[];
  /** Last 1 000 parsed SSE events (most-recent last). */
  getEvents: () => SseDebugEventEntry[];
}

/**
 * Singleton events surface. Stable identity across the app's lifetime
 * so the consolidated installer can identity-check on teardown.
 */
export const eventsDebugApi: ChatDebugEventsApi = {
  getClients: getSseClients,
  getEvents: getSseEvents,
};
