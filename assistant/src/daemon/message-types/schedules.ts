// Heartbeat events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`. Schedule / heartbeat / filing management (list,
// config, run-now, checklist) is served by the HTTP heartbeat and filing
// routes, not by client messages.

import type { HeartbeatAlertEvent } from "../../api/events/heartbeat-alert.js";
import type { HeartbeatConversationCreatedEvent } from "../../api/events/heartbeat-conversation-created.js";

export type _SchedulesServerMessages =
  | HeartbeatAlertEvent
  | HeartbeatConversationCreatedEvent;
