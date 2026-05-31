/**
 * SSE event type definitions for the assistant event stream.
 *
 * Contains all SSE event interfaces, the discriminated `AssistantEvent` union,
 * and supporting types consumed by the event bus, event parser, and stream
 * handler modules. These are cross-domain shared types — the event bus store
 * and multiple domains subscribe to these events.
 *
 * Schema-validated events are covered by `APIAssistantEvent` (the inferred
 * union from `@vellumai/assistant-api`); each new schema added there appears
 * in `AssistantEvent` automatically. The members listed individually are
 * events still on the hand-rolled legacy parser path — they migrate into
 * the canonical schema one by one.
 */

import type { AssistantEvent as APIAssistantEvent } from "@vellumai/assistant-api";
import type { DiskPressureStatus } from "@/assistant/types";
import type { SyncChangedEvent } from "@/lib/sync/types";
import type {
  SubagentEventEvent,
  SubagentSpawnedEvent,
  SubagentStatusChangedEvent,
} from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// SSE event interfaces
// ---------------------------------------------------------------------------

/** Valid decisions accepted by the assistant runtime's POST /v1/confirm endpoint. */
export type ConfirmationDecision = "allow" | "deny";

export interface DocumentEditorUpdateEvent {
  type: "document_editor_update";
  surfaceId: string;
  markdown: string;
  mode: string;
  conversationId?: string;
}

export interface UnknownEvent {
  type: "unknown";
  rawType: string;
  data: Record<string, unknown>;
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Conversation lifecycle events
// ---------------------------------------------------------------------------

/**
 * Emitted by the daemon when the inference profile is auto-routed for the
 * current turn (e.g. tool-based routing selects a different model profile).
 * The client renders a subtle inline notification so the user knows which
 * profile is handling the response.
 */
export interface TurnProfileAutoRoutedEvent {
  type: "turn_profile_auto_routed";
  conversationId: string;
  profile: string;
  profileLabel: string;
  conversationKey?: string;
}

export interface DiskPressureStatusChangedEvent {
  type: "disk_pressure_status_changed";
  status: DiskPressureStatus | null;
  conversationId?: string;
}

export interface AssistantSyncChangedEvent extends SyncChangedEvent {
  conversationId?: string;
}

/**
 * Mirrors the daemon's `PendingInteraction["kind"]` union
 * (`assistant/src/runtime/pending-interactions.ts`). Split into user-facing
 * kinds (prompts that block the conversation waiting for a person) and
 * host-proxy kinds (intermediate tool steps that resolve mid-turn).
 *
 * Keep in sync with the daemon enum — adding a kind on one side without the
 * other causes the attention-tracking allowlist to silently miss or
 * incorrectly clear processing indicators.
 */
export type UserFacingInteractionKind =
  | "confirmation"
  | "secret"
  | "question"
  | "acp_confirmation";

export type HostProxyInteractionKind =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser"
  | "host_app_control"
  | "host_transfer";

export type InteractionKind =
  | UserFacingInteractionKind
  | HostProxyInteractionKind;

/**
 * Allowlist of interaction kinds that signal the daemon has handed control
 * back to a person (vs intermediate host-proxy tool steps). Attention
 * tracking uses this to decide whether to clear processing/attention state
 * on `interaction_resolved`.
 */
export const USER_FACING_INTERACTION_KINDS: ReadonlySet<string> =
  new Set<UserFacingInteractionKind>([
    "confirmation",
    "secret",
    "question",
    "acp_confirmation",
  ]);

/**
 * Emitted when a daemon-side pending interaction (confirmation, secret,
 * question, host-proxy request) transitions to a resolved state. Drives
 * push-based attention reconciliation in the sidebar.
 */
// ---------------------------------------------------------------------------
// AssistantEvent union
// ---------------------------------------------------------------------------

/**
 * Every event the chat SSE stream might emit. Schema-validated events
 * are covered by `APIAssistantEvent` (the inferred union from
 * `@vellumai/assistant-api`); each new schema added there appears here
 * automatically. The members listed individually are events still on
 * the hand-rolled legacy parser path — they peel off this union one by
 * one as they migrate into the canonical schema.
 */
export type AssistantEvent =
  | APIAssistantEvent
  | DiskPressureStatusChangedEvent
  | AssistantSyncChangedEvent
  | SubagentSpawnedEvent
  | SubagentStatusChangedEvent
  | SubagentEventEvent
  | DocumentEditorUpdateEvent
  | TurnProfileAutoRoutedEvent
  | UnknownEvent;
