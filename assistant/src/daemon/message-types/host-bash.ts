// Host bash proxy events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { HostBashCancelEvent } from "../../api/events/host-bash.js";
import type { HostBashRequestEvent } from "../../api/events/host-bash.js";

export type _HostBashServerMessages =
  | HostBashRequestEvent
  | HostBashCancelEvent;
