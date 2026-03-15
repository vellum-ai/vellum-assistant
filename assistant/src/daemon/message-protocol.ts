/**
 * Message Protocol -- message types and serialization.
 *
 * All message types are defined in domain files under ./message-types/.
 * Each domain file exports `_<Domain>ClientMessages` and/or
 * `_<Domain>ServerMessages` type aliases. This file composes those
 * into the aggregate ClientMessage and ServerMessage unions.
 *
 * To add a new message type:
 *   1. Define its interface in the appropriate domain file.
 *   2. Add it to that file's _<Domain>ClientMessages or _<Domain>ServerMessages.
 * No changes needed here unless you're adding an entirely new domain file.
 */

// Re-export domain modules (all individual types remain importable)
export * from "./message-types/apps.js";
export * from "./message-types/browser.js";
export * from "./message-types/computer-use.js";
export * from "./message-types/contacts.js";
export * from "./message-types/conversations.js";
export * from "./message-types/diagnostics.js";
export * from "./message-types/documents.js";
export * from "./message-types/guardian-actions.js";
export * from "./message-types/host-bash.js";
export * from "./message-types/host-cu.js";
export * from "./message-types/host-file.js";
export * from "./message-types/inbox.js";
export * from "./message-types/integrations.js";
export * from "./message-types/memory.js";
export * from "./message-types/messages.js";
export * from "./message-types/notifications.js";
export * from "./message-types/pairing.js";
export * from "./message-types/schedules.js";
export * from "./message-types/settings.js";
export * from "./message-types/shared.js";
export * from "./message-types/skills.js";
export * from "./message-types/subagents.js";
export * from "./message-types/surfaces.js";
export * from "./message-types/trust.js";
export * from "./message-types/work-items.js";
export * from "./message-types/workspace.js";

// Import domain-level union aliases for composition
import type {
  _AppsClientMessages,
  _AppsServerMessages,
} from "./message-types/apps.js";
import type {
  _BrowserClientMessages,
  _BrowserServerMessages,
} from "./message-types/browser.js";
import type {
  _ComputerUseClientMessages,
  _ComputerUseServerMessages,
} from "./message-types/computer-use.js";
import type {
  _ContactsClientMessages,
  _ContactsServerMessages,
} from "./message-types/contacts.js";
import type {
  _SessionsClientMessages,
  _SessionsServerMessages,
} from "./message-types/conversations.js";
import type {
  _DiagnosticsClientMessages,
  _DiagnosticsServerMessages,
} from "./message-types/diagnostics.js";
import type {
  _DocumentsClientMessages,
  _DocumentsServerMessages,
} from "./message-types/documents.js";
import type {
  _GuardianActionsClientMessages,
  _GuardianActionsServerMessages,
} from "./message-types/guardian-actions.js";
import type { _HostBashServerMessages } from "./message-types/host-bash.js";
import type { _HostCuServerMessages } from "./message-types/host-cu.js";
import type { _HostFileServerMessages } from "./message-types/host-file.js";
import type {
  _InboxClientMessages,
  _InboxServerMessages,
} from "./message-types/inbox.js";
import type {
  _IntegrationsClientMessages,
  _IntegrationsServerMessages,
} from "./message-types/integrations.js";
import type { _MemoryServerMessages } from "./message-types/memory.js";
import type {
  _MessagesClientMessages,
  _MessagesServerMessages,
} from "./message-types/messages.js";
import type {
  _NotificationsClientMessages,
  _NotificationsServerMessages,
} from "./message-types/notifications.js";
import type {
  _PairingClientMessages,
  _PairingServerMessages,
} from "./message-types/pairing.js";
import type {
  _SchedulesClientMessages,
  _SchedulesServerMessages,
} from "./message-types/schedules.js";
import type {
  _SettingsClientMessages,
  _SettingsServerMessages,
} from "./message-types/settings.js";
import type {
  _SkillsClientMessages,
  _SkillsServerMessages,
} from "./message-types/skills.js";
import type {
  _SubagentsClientMessages,
  _SubagentsServerMessages,
} from "./message-types/subagents.js";
import type {
  _SurfacesClientMessages,
  _SurfacesServerMessages,
} from "./message-types/surfaces.js";
import type {
  _TrustClientMessages,
  _TrustServerMessages,
} from "./message-types/trust.js";
import type {
  _WorkItemsClientMessages,
  _WorkItemsServerMessages,
} from "./message-types/work-items.js";
import type {
  _WorkspaceClientMessages,
  _WorkspaceServerMessages,
} from "./message-types/workspace.js";

// === SubagentEvent -- defined here because it references ServerMessage ===

/** Wraps any ServerMessage emitted by a subagent session for routing to the client. */
export interface SubagentEvent {
  type: "subagent_event";
  subagentId: string;
  event: ServerMessage;
}

// === Client -> Server aggregate union ===

export type ClientMessage =
  | _SessionsClientMessages
  | _MessagesClientMessages
  | _SurfacesClientMessages
  | _SkillsClientMessages
  | _TrustClientMessages
  | _AppsClientMessages
  | _IntegrationsClientMessages
  | _ComputerUseClientMessages
  | _ContactsClientMessages
  | _WorkItemsClientMessages
  | _BrowserClientMessages
  | _SubagentsClientMessages
  | _DocumentsClientMessages
  | _GuardianActionsClientMessages
  | _WorkspaceClientMessages
  | _SchedulesClientMessages
  | _DiagnosticsClientMessages
  | _InboxClientMessages
  | _PairingClientMessages
  | _NotificationsClientMessages
  | _SettingsClientMessages;

// === Server -> Client aggregate union ===

export type ServerMessage =
  | _SessionsServerMessages
  | _MessagesServerMessages
  | _SurfacesServerMessages
  | _SkillsServerMessages
  | _TrustServerMessages
  | _AppsServerMessages
  | _IntegrationsServerMessages
  | _ComputerUseServerMessages
  | _ContactsServerMessages
  | _WorkItemsServerMessages
  | _BrowserServerMessages
  | _SubagentsServerMessages
  | _DocumentsServerMessages
  | _GuardianActionsServerMessages
  | _HostBashServerMessages
  | _HostCuServerMessages
  | _HostFileServerMessages
  | _MemoryServerMessages
  | _WorkspaceServerMessages
  | _SchedulesServerMessages
  | _SettingsServerMessages
  | _DiagnosticsServerMessages
  | _InboxServerMessages
  | _PairingServerMessages
  | _NotificationsServerMessages
  | SubagentEvent;

// === Contract schema ===

export interface ContractSchema {
  client: ClientMessage;
  server: ServerMessage;
}
