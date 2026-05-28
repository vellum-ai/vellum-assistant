/**
 * SSE event type definitions for the assistant chat stream.
 *
 * Contains all event interfaces, the discriminated `AssistantEvent` union,
 * and supporting types (tool calls, messages, confirmation decisions, etc.)
 * consumed by event-parser.ts and the stream handler domain modules.
 */

import type { AssistantEvent as APIAssistantEvent } from "@vellumai/assistant-api";
import type { DiskPressureStatus } from "@/assistant/types";
import type { Surface } from "@/domains/chat/types/types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import type { SyncChangedEvent } from "@/lib/sync/types";
export type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  ScopeOption,
  SubagentInnerEvent,
  SubagentStatus,
} from "@/types/interaction-ui-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  ScopeOption,
  SubagentInnerEvent,
  SubagentStatus,
} from "@/types/interaction-ui-types";

/** Data needed to render an inline permission prompt inside a ToolCallChip. */
export interface PendingToolConfirmation {
  requestId: string;
  title?: string;
  description?: string;
  toolName?: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  persistentDecisionsAllowed?: boolean;
}

export interface ChatMessageToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  isError?: boolean;
  riskLevel?: string;
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the approval decision was reached: "prompted" | "auto" | "blocked" | "unknown". */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  pendingConfirmation?: PendingToolConfirmation | null;
  workingDir?: string;
  /** ms since epoch, set locally when tool_use_start SSE event arrives */
  startedAt?: number;
  /** ms since epoch, set locally when tool_result SSE event arrives */
  completedAt?: number;
  /** Explicit decision made during the confirmation flow ("approved" | "denied" | "timed_out"). */
  confirmationDecision?: "approved" | "denied" | "timed_out";
  /**
   * Structured tool activity metadata (e.g. web_search, web_fetch) persisted
   * alongside the tool call so the new `WebSearchProgressCard` can keep
   * rendering after the active turn ends and the live `liveWebActivity`
   * map is cleared. Set by `applyToolResult` when the `tool_result` event
   * carries `activityMetadata`. Absent on historical reopens that arrive
   * via reconcile (the server snapshot doesn't carry this field). See
   * `web-activity-types.ts`.
   */
  activityMetadata?: ToolActivityMetadata;
  /** Seconds elapsed since tool started, updated by tool_progress events. */
  progressElapsedSec?: number;
  /** Configured timeout in seconds, updated by tool_progress events (0 if unknown). */
  progressTimeoutSec?: number;
  /** ms since epoch of the last tool_progress event for this tool call. */
  lastProgressAt?: number;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  surfaces?: Surface[];
  textSegments?: Array<{
    type: string;
    content: string;
    [key: string]: unknown;
  }>;
  contentOrder?: Array<{ type: string; id: string }>;
  metadata?: Record<string, unknown>;
  toolCalls?: ChatMessageToolCall[];
  /** Server-provided timestamp in milliseconds since epoch. */
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Runtime event types
// ---------------------------------------------------------------------------

export interface StreamErrorEvent {
  type: "error";
  code?: string;
  errorCategory?: string;
  message: string;
  conversationId?: string;
}

export interface SecretRequestEvent {
  type: "secret_request";
  requestId: string;
  service?: string;
  field?: string;
  label?: string;
  description?: string;
  placeholder?: string;
  allowOneTimeSend?: boolean;
  allowedTools?: string[];
  allowedDomains?: string[];
  purpose?: string;
  conversationId?: string;
}

/** Valid decisions accepted by the assistant runtime's POST /v1/confirm endpoint. */
export type ConfirmationDecision = "allow" | "deny";

export interface ConfirmationRequestEvent {
  type: "confirmation_request";
  requestId: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  denyLabel?: string;
  conversationId?: string;
  toolName?: string;
  executionTarget?: string;
  riskLevel?: string;
  riskReason?: string;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  persistentDecisionsAllowed?: boolean;
  input?: Record<string, unknown>;
  toolUseId?: string;
}

export interface ContactRequestEvent {
  type: "contact_request";
  requestId: string;
  /** Suggested channel type hint (e.g. "phone", "email", "telegram"). */
  channel?: string;
  placeholder?: string;
  label?: string;
  description?: string;
  /** Suggested role for the new contact. */
  role?: string;
  conversationId?: string;
}

export interface QuestionRequestEvent {
  type: "question_request";
  requestId: string;
  /** New shape — present when the daemon ships the batched-questions PR. */
  questions?: QuestionEntry[];
  /** Legacy flat fields — still emitted by older daemons. */
  question?: string;
  description?: string;
  options?: QuestionOption[];
  freeTextPlaceholder?: string;
  conversationId?: string;
  toolUseId?: string;
}

export type QuestionResponseEntry =
  | { questionId: string; kind: "option"; optionId: string }
  | { questionId: string; kind: "free_text"; text: string }
  | { questionId: string; kind: "skip" };

export type QuestionSubmission =
  | { kind: "submit"; responses: QuestionResponseEntry[] }
  | { kind: "close" };

export function normalizeQuestionRequest(
  event: QuestionRequestEvent,
): QuestionEntry[] {
  if (event.questions && event.questions.length > 0) {
    return event.questions.map((entry, i) => ({
      id:
        typeof entry.id === "string" && entry.id.trim() !== ""
          ? entry.id
          : `q${i + 1}`,
      question: entry.question ?? "",
      description: entry.description,
      options: Array.isArray(entry.options) ? entry.options : [],
      freeTextPlaceholder: entry.freeTextPlaceholder,
    }));
  }
  const hasLegacyFields =
    event.question !== undefined ||
    event.options !== undefined ||
    event.description !== undefined ||
    event.freeTextPlaceholder !== undefined;
  if (hasLegacyFields) {
    return [
      {
        id: "q1",
        question: event.question ?? "",
        description: event.description,
        options: Array.isArray(event.options) ? event.options : [],
        freeTextPlaceholder: event.freeTextPlaceholder,
      },
    ];
  }
  return [];
}

export interface UISurfaceShowEvent {
  type: "ui_surface_show";
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{
    id: string;
    label: string;
    style?: string;
    data?: Record<string, unknown>;
  }>;
  display?: "inline" | "panel";
  messageId?: string;
  conversationId?: string;
}

export interface UISurfaceUpdateEvent {
  type: "ui_surface_update";
  surfaceId: string;
  data: Record<string, unknown>;
  conversationId?: string;
}

export interface UISurfaceDismissEvent {
  type: "ui_surface_dismiss";
  surfaceId: string;
  conversationId?: string;
}

export interface UISurfaceCompleteEvent {
  type: "ui_surface_complete";
  surfaceId: string;
  summary: string;
  submittedData?: Record<string, unknown>;
  conversationId?: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolName: string;
  result: string;
  isError?: boolean;
  toolUseId?: string;
  conversationId?: string;
  /** Database ID of the assistant message that owns the parent tool_use
   *  block. Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
  riskLevel?: string;
  riskReason?: string;
  matchedTrustRuleId?: string;
  approvalMode?: string;
  approvalReason?: string;
  riskThreshold?: string;
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  /**
   * Structured metadata describing tool activity (e.g. web_search,
   * web_fetch). Optional — present only for tools that emit it (currently
   * Anthropic-native web_search). See web-activity-types.ts.
   */
  activityMetadata?: ToolActivityMetadata;
}

/**
 * Periodic progress heartbeat emitted by the daemon while a tool is executing.
 * Fires every ~10s so the client can show a live "Still working..." indicator
 * even when no other SSE events are flowing.
 */
export interface ToolProgressEvent {
  type: "tool_progress";
  toolName: string;
  elapsedSec: number;
  timeoutSec: number;
  toolUseId?: string;
  conversationId?: string;
}

/**
 * Periodic usage update emitted by the daemon with token counts for the
 * current conversation. `contextWindowTokens` / `contextWindowMaxTokens`
 * reflect the size of the most recent model request (input + cached tokens)
 * and the model's max input window. Either may be absent if unknown.
 */
export interface UsageUpdateEvent {
  type: "usage_update";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindowTokens?: number;
  contextWindowMaxTokens?: number;
  conversationId?: string;
}

/**
 * Server-side assistant activity lifecycle for thinking-indicator placement
 * and turn-state recovery.
 *
 * The daemon emits one of these whenever the conversation transitions
 * between activity phases (`thinking`, `streaming`, `tool_running`,
 * `awaiting_confirmation`, `idle`). The `idle` phase is always terminal
 * for the active turn — daemon emit sites use it only with reason
 * `message_complete`, `generation_cancelled`, or `error_terminal`.
 *
 * `activityVersion` is monotonically increasing per conversation. Clients
 * must ignore events with a version older than the highest already
 * observed for that conversation.
 *
 * Mirrors `AssistantActivityState` in the daemon's
 * `assistant/src/daemon/message-types/messages.ts`.
 */
export type AssistantActivityPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool_running"
  | "awaiting_confirmation";

export type AssistantActivityReason =
  | "message_dequeued"
  | "thinking_delta"
  | "first_text_delta"
  | "tool_use_start"
  | "preview_start"
  | "tool_result_received"
  | "confirmation_requested"
  | "confirmation_resolved"
  | "context_compacting"
  | "message_complete"
  | "generation_cancelled"
  | "error_terminal";

export interface AssistantActivityStateEvent {
  type: "assistant_activity_state";
  activityVersion: number;
  phase: AssistantActivityPhase;
  anchor: "assistant_turn" | "user_turn" | "global";
  reason: AssistantActivityReason;
  requestId?: string;
  statusText?: string;
  conversationId?: string;
}

export interface NavigateSettingsEvent {
  type: "navigate_settings";
  tab: string;
  conversationId?: string;
}

export interface HomeFeedUpdatedEvent {
  type: "home_feed_updated";
  updatedAt: string;
  newItemCount: number;
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Subagent event types
// ---------------------------------------------------------------------------

export interface SubagentSpawnedEvent {
  type: "subagent_spawned";
  subagentId: string;
  parentConversationId?: string;
  label: string;
  objective: string;
  isFork?: boolean;
  /**
   * Tool-use block ID of the spawning tool call in the parent conversation.
   * Lets the client anchor the inline subagent card to its exact spawn tool
   * call (survives optimistic→reconciled message id swaps). Optional — older
   * daemons omit it.
   */
  parentToolUseId?: string;
  conversationId?: string;
}

export interface SubagentStatusChangedEvent {
  type: "subagent_status_changed";
  subagentId: string;
  status: SubagentStatus;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  conversationId?: string;
}

export interface SubagentEventWrapperEvent {
  type: "subagent_event";
  subagentId: string;
  event: SubagentInnerEvent;
  conversationId?: string;
}

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

/**
 * Reasons the server may invalidate a client's conversation list — mirrors
 * `ConversationListInvalidatedReason` on the daemon.
 */
export type ConversationListInvalidatedReason =
  | "created"
  | "renamed"
  | "deleted"
  | "reordered"
  | "seen_changed";

/**
 * Server push notifying clients that their sidebar conversation list is
 * stale and should be refetched (e.g. after a create/rename/delete/reorder
 * from another client). Global to the assistant — not scoped to a single
 * conversationId.
 */
export interface ConversationListInvalidatedEvent {
  type: "conversation_list_invalidated";
  reason: ConversationListInvalidatedReason;
  conversationId?: string;
}

/**
 * Server push notifying clients that a single conversation's title has
 * changed. Emitted on auto-title generation (agent loop, first turn),
 * auto-title regeneration (after 3 turns), and explicit renames. Clients
 * should update the matching conversation's title in-place rather than
 * refetching the whole list.
 */
export interface ConversationTitleUpdatedEvent {
  type: "conversation_title_updated";
  conversationId: string;
  title: string;
}

/**
 * Server push asking the client to display a native notification. Mirrors
 * the daemon's `NotificationIntent` message (see
 * `assistant/src/daemon/message-types/notifications.ts`). The macOS client
 * turns these into `UNUserNotificationCenter` banners; the web / Capacitor
 * client turns them into local notifications (Capacitor iOS) or browser
 * notifications (desktop web).
 *
 * `targetGuardianPrincipalId`, when set, scopes the notification to clients
 * bound to that guardian identity. The web/Capacitor client does not yet
 * participate in guardian binding, so guardian-scoped notifications are
 * skipped to avoid leaking them to unintended devices.
 */
export interface NotificationIntentEvent {
  type: "notification_intent";
  deliveryId?: string;
  sourceEventName: string;
  title: string;
  body: string;
  deepLinkMetadata?: Record<string, unknown>;
  targetGuardianPrincipalId?: string;
  conversationId?: string;
}

/** Cache-invalidation signal: refetch identity from the canonical endpoint. */
export interface IdentityChangedEvent {
  type: "identity_changed";
  conversationId?: string;
}

/** Broadcast by the daemon when avatar files change on disk. */
export interface AvatarUpdatedEvent {
  type: "avatar_updated";
  conversationId?: string;
}

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

export interface ConversationErrorEvent {
  type: "conversation_error";
  conversationId: string;
  code: string;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
  errorCategory?: string;
}

export interface CompactionCircuitOpenEvent {
  type: "compaction_circuit_open";
  conversationId: string;
  reason: string;
  openUntil: number;
}

export interface CompactionCircuitClosedEvent {
  type: "compaction_circuit_closed";
  conversationId: string;
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
 * Lifecycle outcome reported alongside `interaction_resolved`. Mirrors the
 * daemon-side `InteractionResolutionState` union.
 */
export type InteractionResolutionState =
  | "approved"
  | "rejected"
  | "answered"
  | "cancelled"
  | "superseded";

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
export interface InteractionResolvedEvent {
  type: "interaction_resolved";
  requestId: string;
  /** Conversation id the resolved interaction was registered against. */
  conversationId: string;
  state: InteractionResolutionState;
  /** Kind of the resolved interaction (e.g. `"confirmation"`, `"secret"`). */
  kind: InteractionKind;
}

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
  | StreamErrorEvent
  | SecretRequestEvent
  | ConfirmationRequestEvent
  | ContactRequestEvent
  | QuestionRequestEvent
  | UISurfaceShowEvent
  | UISurfaceUpdateEvent
  | UISurfaceDismissEvent
  | UISurfaceCompleteEvent
  | ToolResultEvent
  | ToolProgressEvent
  | ConversationListInvalidatedEvent
  | ConversationTitleUpdatedEvent
  | NotificationIntentEvent
  | UsageUpdateEvent
  | AssistantActivityStateEvent
  | NavigateSettingsEvent
  | IdentityChangedEvent
  | AvatarUpdatedEvent
  | ConversationErrorEvent
  | CompactionCircuitOpenEvent
  | CompactionCircuitClosedEvent
  | DiskPressureStatusChangedEvent
  | AssistantSyncChangedEvent
  | HomeFeedUpdatedEvent
  | SubagentSpawnedEvent
  | SubagentStatusChangedEvent
  | SubagentEventWrapperEvent
  | DocumentEditorUpdateEvent
  | TurnProfileAutoRoutedEvent
  | InteractionResolvedEvent
  | UnknownEvent;
