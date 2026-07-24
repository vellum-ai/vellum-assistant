/**
 * Message Protocol -- message types and serialization.
 *
 * Client message types are defined in domain files under ./message-types/;
 * each exports a `_<Domain>ClientMessages` alias that this file composes into
 * the aggregate `ClientMessage` union.
 *
 * The server->client union `AssistantEvent` is single-sourced from the canonical
 * `AssistantEventSchema` in `../api` -- `AssistantEvent` is `z.infer` of that
 * schema, so every hub-published event type appears in it automatically.
 */

// Re-export domain modules (all individual types remain importable)
export * from "./message-types/computer-use.js";
export * from "./message-types/conversations.js";
export * from "./message-types/diagnostics.js";
export * from "./message-types/host-app-control.js";
export * from "./message-types/host-browser.js";
export * from "./message-types/messages.js";
export * from "./message-types/notifications.js";
export * from "./message-types/shared.js";
export * from "./message-types/skills.js";
export * from "./message-types/surfaces.js";
export * from "./message-types/sync.js";
export * from "./message-types/web-activity.js";

// Canonical server->client event union: every message the daemon can send to a
// client, single-sourced from `AssistantEventSchema` (`z.infer`). Re-exported
// here so daemon code can import it alongside the ClientMessage union.
export type { AssistantEvent } from "../api/index.js";

// Client-message domain aliases for the ClientMessage union.
import type { _ComputerUseClientMessages } from "./message-types/computer-use.js";
import type { _DiagnosticsClientMessages } from "./message-types/diagnostics.js";
import type { _HostBrowserClientMessages } from "./message-types/host-browser.js";
import type { _MessagesClientMessages } from "./message-types/messages.js";
import type { _NotificationsClientMessages } from "./message-types/notifications.js";

// === Client -> Server aggregate union ===

export type ClientMessage =
  | _MessagesClientMessages
  | _ComputerUseClientMessages
  | _HostBrowserClientMessages
  | _DiagnosticsClientMessages
  | _NotificationsClientMessages;
