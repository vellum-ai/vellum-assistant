// Host computer-use proxy events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { HostCuCancelEvent } from "../../api/events/host-cu.js";
import type { HostCuRequestEvent } from "../../api/events/host-cu.js";

export type _HostCuServerMessages = HostCuRequestEvent | HostCuCancelEvent;
