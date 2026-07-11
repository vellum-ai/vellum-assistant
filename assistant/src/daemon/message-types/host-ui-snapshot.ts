// Host UI-snapshot proxy types.
// Asks the desktop client to render a staged view of the app's own UI
// (`/assistant/theme-stage/:view`) in a hidden window with the current
// workspace-theme tokens applied, capture it, and post the PNG back. The
// stage contains only fixed generic content — never user data — so the
// assistant can check its theming work without a human screenshotting the
// app. Distinct from host-app-control's `observe` (which captures OTHER
// applications' windows via the native helper).

/** Staged compositions the web client can render for capture. */
export type HostUiSnapshotView = "sampler" | "chat";

export interface HostUiSnapshotRequestMessage {
  type: "host_ui_snapshot_request";
  requestId: string;
  view: HostUiSnapshotView;
  /**
   * Validated workspace-theme tokens to apply on the stage. The daemon reads
   * them from ui/theme.json at request time so the capture reflects the
   * current file even before connected clients refetch. Absent when no valid
   * theme exists — the stage renders the built-in base theme.
   */
  tokens?: Record<string, string>;
}

export interface HostUiSnapshotCancelMessage {
  type: "host_ui_snapshot_cancel";
  requestId: string;
}

export type _HostUiSnapshotServerMessages =
  | HostUiSnapshotRequestMessage
  | HostUiSnapshotCancelMessage;

/** Body the desktop client POSTs to /v1/host-ui-snapshot-result. */
export interface HostUiSnapshotResultPayload {
  requestId: string;
  /** Base64 PNG capture of the staged view (device-scale pixels). */
  pngBase64?: string;
  widthPx?: number;
  heightPx?: number;
  isError?: boolean;
  errorMessage?: string;
}
