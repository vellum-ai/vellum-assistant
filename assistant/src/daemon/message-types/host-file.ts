// Host file proxy events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { HostFileCancelEvent } from "../../api/events/host-file.js";
import type { HostFileRequestEvent } from "../../api/events/host-file.js";

export type _HostFileServerMessages =
  | HostFileRequestEvent
  | HostFileCancelEvent;
