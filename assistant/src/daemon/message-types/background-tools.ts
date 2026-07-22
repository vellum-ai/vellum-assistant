// Background bash/host_bash command lifecycle types.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { BackgroundToolCompletedEvent } from "../../api/events/background-tool-completed.js";
import type { BackgroundToolStartedEvent } from "../../api/events/background-tool-started.js";

// --- Domain-level union alias (consumed by message-protocol.ts) ---

export type _BackgroundToolsServerMessages =
  | BackgroundToolStartedEvent
  | BackgroundToolCompletedEvent;
