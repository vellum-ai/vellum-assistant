/**
 * Chat debug API — installable under `window._vellumDebug.events`.
 *
 * Provides live introspection of SSE stream state: active clients, abort
 * signals, and a rolling buffer of the last 1 000 parsed events.
 *
 * Usage (browser console):
 *
 *   window._vellumDebug.events.getClients()
 *   window._vellumDebug.events.getEvents()
 *
 * This module is safe to import anywhere; it does **not** install itself on
 * `window` until {@link installVellumDebugApi} is called (typically once,
 * from the app root).
 */

import type {
  SseDebugClient,
  SseDebugEventEntry,
} from "@/domains/chat/api/stream-debug.js";
import {
  getSseClients,
  getSseEvents,
} from "@/domains/chat/api/stream-debug.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatDebugEventsApi {
  /** Snapshot of currently-live SSE clients. */
  getClients: () => SseDebugClient[];
  /** Last 1 000 parsed SSE events (most-recent last). */
  getEvents: () => SseDebugEventEntry[];
}

export interface VellumDebugApi {
  events: ChatDebugEventsApi;
}

declare global {
  interface Window {
    _vellumDebug?: VellumDebugApi;
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Idempotently installs `window._vellumDebug.events`.
 *
 * Safe to call multiple times (e.g. from React's strict-mode double-mount).
 */
export function installVellumDebugApi(): void {
  if (typeof window === "undefined") return;

  const existing = window._vellumDebug;
  if (existing?.events) {
    // Already installed — don't overwrite, so we don't lose refs.
    return;
  }

  window._vellumDebug = {
    ...existing,
    events: {
      getClients: getSseClients,
      getEvents: getSseEvents,
    },
  };
}
