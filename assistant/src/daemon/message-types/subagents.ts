// Subagent lifecycle events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file composes them into the domain union consumed by
// `message-protocol.ts`. Subagent detail, abort, status, message, and history
// are served by the HTTP subagent routes (the detail response is the canonical
// `api/responses/subagent-detail.ts` shape), not by client messages.

import type { SubagentSpawnedEvent } from "../../api/events/subagent-spawned.js";
import type { SubagentStatusChangedEvent } from "../../api/events/subagent-status-changed.js";

// --- Domain-level union alias (consumed by the barrel file) ---

export type _SubagentsServerMessages =
  | SubagentSpawnedEvent
  | SubagentStatusChangedEvent;
