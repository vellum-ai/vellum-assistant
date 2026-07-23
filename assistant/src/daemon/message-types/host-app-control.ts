// Host app-control proxy types.
//
// The server→client events (`host_app_control_request` / `_cancel`) and the
// tool-input union (`HostAppControlInput`) are single-sourced from their
// canonical `api/events` wire schema. `HostAppControlResultPayload` is the HTTP
// body the client POSTs to /v1/host-app-control-result — a route contract, not
// an event.

import type { HostAppControlCancelEvent } from "../../api/events/host-app-control.js";
import type { HostAppControlRequestEvent } from "../../api/events/host-app-control.js";

export type {
  HostAppControlInput,
  HostAppControlSequenceStep,
} from "../../api/events/host-app-control.js";

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostAppControlServerMessages =
  | HostAppControlRequestEvent
  | HostAppControlCancelEvent;

// === Result payload (HTTP /v1/host-app-control-result body) ===

/** Lifecycle state of the targeted application as seen by the client. */
export type HostAppControlState = "running" | "missing" | "minimized";

export interface HostAppControlResultPayload {
  requestId: string;
  state: HostAppControlState;
  /** Base64-encoded PNG screenshot of the targeted app window, when available. */
  pngBase64?: string;
  /** Window bounds in screen-space points. */
  windowBounds?: { x: number; y: number; width: number; height: number };
  executionResult?: string;
  executionError?: string;
}
