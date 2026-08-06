// Host UI-snapshot proxy types.
//
// The server→client events (`host_ui_snapshot_request` / `_cancel`) and the
// `HostUiSnapshotView` enum are single-sourced from their canonical `api/events`
// wire schema. `HostUiSnapshotResultPayload` is the HTTP body the client POSTs
// to /v1/host-ui-snapshot-result — a route contract, not an event.

export type { HostUiSnapshotView } from "../../api/events/host-ui-snapshot.js";

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
