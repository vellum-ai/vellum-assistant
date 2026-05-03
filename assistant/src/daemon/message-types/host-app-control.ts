// Host app-control proxy types.
// Enables proxying app-control actions (start, observe, press, combo, type,
// click, drag, stop) to the desktop client (host machine) when running as a
// managed assistant. Targets a specific application by bundle ID or process
// name — distinct from the system-wide computer-use proxy in host-cu.ts.

// === Tool input discriminated union ===

/** Inputs accepted by the nine app-control tool variants. */
export type HostAppControlInput =
  | HostAppControlStartInput
  | HostAppControlObserveInput
  | HostAppControlPressInput
  | HostAppControlComboInput
  | HostAppControlSequenceInput
  | HostAppControlTypeInput
  | HostAppControlClickInput
  | HostAppControlDragInput
  | HostAppControlStopInput;

export interface HostAppControlStartInput {
  tool: "start";
  /** Bundle ID (preferred) or process name. */
  app: string;
  /** Optional command-line arguments to launch the app with. */
  args?: string[];
}

export interface HostAppControlObserveInput {
  tool: "observe";
  app: string;
  /**
   * Milliseconds to wait between receiving the request and capturing the
   * window. Lets the target app process pending input and the WindowServer
   * composite a fresh frame. When omitted, the client uses its default
   * (~200ms, sized for emulator-class apps at 60fps). Pass `0` for static
   * UIs to make `observe` snappier; raise it for slow-feedback apps.
   */
  settle_ms?: number;
}

export interface HostAppControlPressInput {
  tool: "press";
  app: string;
  /** Single key identifier, e.g. "return", "a", "f12". */
  key: string;
  /** Modifier list, e.g. ["cmd", "shift"]. */
  modifiers?: string[];
  /** Hold duration in milliseconds. */
  duration_ms?: number;
}

export interface HostAppControlComboInput {
  tool: "combo";
  app: string;
  /** Sequence of keys pressed simultaneously, e.g. ["cmd", "shift", "4"]. */
  keys: string[];
  /** Hold duration in milliseconds. */
  duration_ms?: number;
}

/** A single step inside a sequence: one key press with optional modifiers, hold duration, and post-press gap. */
export interface HostAppControlSequenceStep {
  /** Single key identifier, e.g. "right", "a", "return". */
  key: string;
  /** Modifier list, e.g. ["cmd", "shift"]. Omit for no modifiers. */
  modifiers?: string[];
  /** Hold duration for this key in milliseconds. */
  duration_ms?: number;
  /** Pause after this step before starting the next, in milliseconds. */
  gap_ms?: number;
}

export interface HostAppControlSequenceInput {
  tool: "sequence";
  app: string;
  /** Ordered list of single-key presses to execute serially. */
  steps: HostAppControlSequenceStep[];
}

export interface HostAppControlTypeInput {
  tool: "type";
  app: string;
  text: string;
}

export interface HostAppControlClickInput {
  tool: "click";
  app: string;
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  double?: boolean;
}

export interface HostAppControlDragInput {
  tool: "drag";
  app: string;
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  button?: "left" | "right" | "middle";
}

export interface HostAppControlStopInput {
  tool: "stop";
  /** Optional — when omitted the proxy stops whichever app currently holds the session. */
  app?: string;
  /** Free-form reason, surfaced for logging. */
  reason?: string;
}

// === Server → Client ===

export interface HostAppControlRequest {
  type: "host_app_control_request";
  requestId: string;
  conversationId: string;
  toolName: string; // "app_control_start", "app_control_observe", etc.
  input: HostAppControlInput;
}

export interface HostAppControlCancel {
  type: "host_app_control_cancel";
  requestId: string;
  conversationId: string;
}

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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostAppControlServerMessages =
  | HostAppControlRequest
  | HostAppControlCancel;
