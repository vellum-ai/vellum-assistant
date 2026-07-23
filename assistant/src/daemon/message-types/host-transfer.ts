// Host transfer proxy events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { HostTransferCancelEvent } from "../../api/events/host-transfer.js";
import type { HostTransferRequestEvent } from "../../api/events/host-transfer.js";

export type _HostTransferServerMessages =
  | HostTransferRequestEvent
  | HostTransferCancelEvent;
