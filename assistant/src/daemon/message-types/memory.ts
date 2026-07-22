// Memory recall and status events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`. Memory has no client messages.

import type { MemoryRecalledEvent } from "../../api/events/memory-recalled.js";
import type { MemoryStatusEvent } from "../../api/events/memory-status.js";

export type _MemoryServerMessages = MemoryRecalledEvent | MemoryStatusEvent;
