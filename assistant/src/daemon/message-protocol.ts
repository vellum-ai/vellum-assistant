/**
 * Message Protocol -- message types and serialization.
 *
 * Client message types are defined in domain files under ./message-types/;
 * each exports a `_<Domain>ClientMessages` alias that this file composes into
 * the aggregate `ClientMessage` union.
 *
 * The server->client union `ServerMessage` is single-sourced from the canonical
 * `AssistantEventSchema` in `../api` -- `ServerMessage` is `z.infer` of that
 * schema, so every hub-published event type appears in it automatically.
 */

// Re-export domain modules (all individual types remain importable)
export * from "./message-types/acp.js";
export * from "./message-types/apps.js";
export * from "./message-types/background-tools.js";
export * from "./message-types/bookmarks.js";
export * from "./message-types/computer-use.js";
export * from "./message-types/contacts.js";
export * from "./message-types/conversations.js";
export * from "./message-types/diagnostics.js";
export * from "./message-types/document-comments.js";
export * from "./message-types/documents.js";
export * from "./message-types/home.js";
export * from "./message-types/host-app-control.js";
export * from "./message-types/host-bash.js";
export * from "./message-types/host-browser.js";
export * from "./message-types/host-cu.js";
export * from "./message-types/host-file.js";
export * from "./message-types/host-transfer.js";
export * from "./message-types/integrations.js";
export * from "./message-types/memory.js";
export * from "./message-types/messages.js";
export * from "./message-types/notifications.js";
export * from "./message-types/schedules.js";
export * from "./message-types/settings.js";
export * from "./message-types/shared.js";
export * from "./message-types/skills.js";
export * from "./message-types/subagents.js";
export * from "./message-types/surfaces.js";
export * from "./message-types/sync.js";
export * from "./message-types/upgrades.js";
export * from "./message-types/web-activity.js";
export * from "./message-types/workflows.js";
export * from "./message-types/workspace.js";

// Canonical server->client event union.
import type { AssistantEvent } from "../api/index.js";
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

// === Server -> Client aggregate union ===

/**
 * Every message the daemon can send to a client. Single-sourced from the
 * canonical `AssistantEventSchema` (`z.infer`), so this stays in lock-step
 * with the published wire contract.
 */
export type ServerMessage = AssistantEvent;
