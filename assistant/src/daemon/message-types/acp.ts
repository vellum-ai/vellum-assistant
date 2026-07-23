// ACP (Agent Client Protocol) session lifecycle and communication types.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { AcpSessionCompletedEvent } from "../../api/events/acp-session-completed.js";
import type { AcpSessionErrorEvent } from "../../api/events/acp-session-error.js";
import type { AcpSessionSpawnedEvent } from "../../api/events/acp-session-spawned.js";
import type { AcpSessionUpdateEvent } from "../../api/events/acp-session-update.js";
import type { AcpSessionUsageEvent } from "../../api/events/acp-session-usage.js";

// --- Domain-level union alias (consumed by message-protocol.ts) ---

export type _AcpServerMessages =
  | AcpSessionSpawnedEvent
  | AcpSessionUpdateEvent
  | AcpSessionCompletedEvent
  | AcpSessionErrorEvent
  | AcpSessionUsageEvent;
