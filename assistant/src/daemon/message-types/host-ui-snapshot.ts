// Host UI-snapshot proxy types.
//
// The server→client events (`host_ui_snapshot_request` / `_cancel`) and the
// `HostUiSnapshotView` enum are single-sourced from their canonical `api/events`
// wire schema. `HostUiSnapshotResultPayload` is the HTTP body the client POSTs
// to /v1/host-ui-snapshot-result — a route contract, not an event.

import type { HostUiSnapshotCancelEvent } from "../../api/events/host-ui-snapshot.js";
import type { HostUiSnapshotRequestEvent } from "../../api/events/host-ui-snapshot.js";

export type { HostUiSnapshotView } from "../../api/events/host-ui-snapshot.js";

export type _HostUiSnapshotServerMessages =
  | HostUiSnapshotRequestEvent
  | HostUiSnapshotCancelEvent;

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
