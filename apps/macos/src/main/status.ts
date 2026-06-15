import { BrowserWindow } from "electron";
import { z } from "zod";

import {
  ASSISTANT_STATUSES,
  type AssistantStatus,
  CONNECTIVITY_STATES,
  type ConnectivityState,
  assistantStatusSchema,
} from "@vellumai/ipc-contract";

import { handle, on } from "./ipc";
import log from "./logger";

/**
 * Assistant connection status driving the menu-bar (Tray) indicator.
 *
 * Mirrors the Swift app's `AssistantStatus` enum
 * (`clients/macos/vellum-assistant/App/AppDelegateTypes.swift`): the same
 * five states, the same colors, the same "thinking pulses" behavior, so a
 * user switching from the native app to the Electron build sees the same
 * menu-bar language.
 *
 * The renderer is the source of truth — it holds the live gateway/auth
 * connection and publishes transitions over the `vellum:status:connection`
 * IPC channel. Main owns only the presentation (icon composition, pulse
 * timer, menu header), so this module never reaches into connection code.
 */
export { ASSISTANT_STATUSES, type AssistantStatus };

/**
 * Tooltip / menu-header text per status, matching the Swift app's
 * `AssistantStatus.menuTitle(assistantName:)`. `assistantName` falls back to
 * "Assistant" so the line reads naturally before the renderer has published
 * an identity.
 */
export const statusMenuTitle = (
  status: AssistantStatus,
  assistantName?: string,
): string => {
  const name = assistantName ?? "Assistant";
  switch (status) {
    case "idle":
      return `${name} is idle`;
    case "thinking":
      return `${name} is thinking…`;
    case "error":
      return `${name} encountered an error`;
    case "disconnected":
      return `Disconnected from ${name}`;
    case "authFailed":
      return "Authentication failed — reconnect to continue";
  }
};

/**
 * Only `thinking` pulses, matching the Swift app's
 * `AssistantStatus.shouldPulse`. Extracted so the tray's pulse-timer
 * lifecycle and the icon cache agree on the single source of truth.
 */
export const shouldPulse = (status: AssistantStatus): boolean =>
  status === "thinking";

// ---------------------------------------------------------------------------
// Pulse animation
// ---------------------------------------------------------------------------

/**
 * The Swift app pulses the dot with a `CABasicAnimation` on `opacity`
 * (1.0 → 0.3, 0.7s, autoreverse, infinite). Electron's `Tray` has no
 * sublayer/animation API, so the pulse is approximated by swapping
 * pre-rendered frames on a timer — the same frame-swap technique
 * podman-desktop uses for its animated tray
 * (https://github.com/containers/podman-desktop). Keeping the frame set
 * small and pre-rendered means the pulse costs one `setImage` per tick and
 * zero per-tick allocation.
 */
export const PULSE_FRAME_COUNT = 16;
export const PULSE_FRAME_INTERVAL_MS = 80;
export const PULSE_MIN_OPACITY = 0.3;
export const PULSE_MAX_OPACITY = 1;

/**
 * Opacity for each pulse frame: a raised cosine from `PULSE_MAX_OPACITY`
 * down to `PULSE_MIN_OPACITY` and back over `PULSE_FRAME_COUNT` frames. The
 * cosine bakes the autoreverse into a single forward cycle, so the timer can
 * advance frames monotonically (`(i + 1) % count`) and never has to track
 * direction. Frame 0 is fully opaque so a freshly-started pulse begins from
 * the solid dot.
 */
export const pulseOpacityFrames = (
  count: number = PULSE_FRAME_COUNT,
): number[] => {
  const mid = (PULSE_MAX_OPACITY + PULSE_MIN_OPACITY) / 2;
  const amplitude = (PULSE_MAX_OPACITY - PULSE_MIN_OPACITY) / 2;
  return Array.from(
    { length: count },
    (_unused, i) => mid + amplitude * Math.cos((2 * Math.PI * i) / count),
  );
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type StatusListener = (status: AssistantStatus) => void;

let currentStatus: AssistantStatus = "idle";
const listeners = new Set<StatusListener>();

export const getStatus = (): AssistantStatus => currentStatus;

/**
 * Subscribe to status transitions. Returns an unsubscribe function. The
 * listener is invoked only on an actual change (the setter de-dupes), so
 * subscribers never rebuild the icon or restart the pulse for a no-op
 * republish.
 */
export const onStatusChange = (listener: StatusListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Update the status and notify subscribers. No-op when the status is
 * unchanged so a renderer that republishes the same state on every render
 * doesn't thrash the tray.
 */
export const setStatus = (status: AssistantStatus): void => {
  if (status === currentStatus) return;
  currentStatus = status;
  for (const listener of listeners) listener(status);
};

const connectionPayloadSchema = z.tuple([assistantStatusSchema]);

/**
 * Register the `vellum:status:connection` renderer→main channel. Fire-and-
 * forget (`ipcRenderer.send`): a status republish has no return value, and a
 * rejected sender or malformed payload should drop silently rather than
 * surface an error in the renderer. Call once from `whenReady`.
 */
let installed = false;
export const installStatusIpc = (): void => {
  if (installed) return;
  installed = true;

  on("vellum:status:connection", connectionPayloadSchema, ([status]) => {
    setStatus(status);
  });
};

// ---------------------------------------------------------------------------
// Connectivity state machine
// ---------------------------------------------------------------------------
// Orthogonal to AssistantStatus — you can be "thinking" AND "device-offline".
// Assistant status drives the tray icon (renderer is source of truth);
// connectivity drives in-app banners (main is source of truth).

export { CONNECTIVITY_STATES, type ConnectivityState };

type ConnectivityListener = (state: ConnectivityState) => void;

let currentConnectivity: ConnectivityState = "online";
let deviceOnline = true;
let backendReachable = true;
const connectivityListeners = new Set<ConnectivityListener>();

export const getConnectivity = (): ConnectivityState => currentConnectivity;

const broadcastConnectivity = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vellum:connectivity:state", currentConnectivity);
  }
};

export const setConnectivity = (state: ConnectivityState): void => {
  if (state === currentConnectivity) return;
  log.info(`[connectivity] ${currentConnectivity} → ${state}`);
  currentConnectivity = state;
  broadcastConnectivity();
  for (const listener of connectivityListeners) listener(state);
};

const recomputeConnectivity = (): void => {
  if (!deviceOnline) {
    setConnectivity("device-offline");
  } else if (!backendReachable) {
    setConnectivity("backend-unreachable");
  } else {
    setConnectivity("online");
  }
};

export const setDeviceOnline = (online: boolean): void => {
  deviceOnline = online;
  recomputeConnectivity();
};

export const setBackendReachable = (reachable: boolean): void => {
  backendReachable = reachable;
  recomputeConnectivity();
};

export const onConnectivityChange = (
  listener: ConnectivityListener,
): (() => void) => {
  connectivityListeners.add(listener);
  return () => {
    connectivityListeners.delete(listener);
  };
};

let connectivityInstalled = false;
export const installConnectivityIpc = (
  onRetry?: () => void | Promise<void>,
): void => {
  if (connectivityInstalled) return;
  connectivityInstalled = true;

  handle("vellum:connectivity:get", z.tuple([]), () => currentConnectivity);

  on(
    "vellum:connectivity:device",
    z.tuple([z.boolean()]),
    ([online]) => {
      setDeviceOnline(online);
    },
  );

  // A manual retry must be able to recover a renderer whose banner has
  // desynced from main: a single missed `:state` broadcast leaves main
  // "online" and the renderer degraded, and the change-gated broadcast in
  // `setConnectivity` would then never resend. Run the probe to completion,
  // rebroadcast unconditionally, and return the fresh state so the renderer
  // can apply it without depending on broadcast delivery at all.
  handle("vellum:connectivity:retry", z.tuple([]), async () => {
    await onRetry?.();
    broadcastConnectivity();
    return currentConnectivity;
  });
};

// Test seam — exported only for unit-test setup so each test starts from a
// known state. Production code never calls this.
export const __resetForTesting = (): void => {
  installed = false;
  currentStatus = "idle";
  listeners.clear();
  connectivityInstalled = false;
  currentConnectivity = "online";
  deviceOnline = true;
  backendReachable = true;
  connectivityListeners.clear();
};
