import { z } from "zod";

import { AssistantActivityStateEventSchema } from "./events/assistant-activity-state.js";
import { AssistantTextDeltaEventSchema } from "./events/assistant-text-delta.js";
import { AssistantThinkingDeltaEventSchema } from "./events/assistant-thinking-delta.js";
import { AssistantTurnStartEventSchema } from "./events/assistant-turn-start.js";
import { AvatarUpdatedEventSchema } from "./events/avatar-updated.js";
import { CompactionCircuitClosedEventSchema } from "./events/compaction-circuit-closed.js";
import { CompactionCircuitOpenEventSchema } from "./events/compaction-circuit-open.js";
import { ConfirmationRequestEventSchema } from "./events/confirmation-request.js";
import { ContactRequestEventSchema } from "./events/contact-request.js";
import { ConversationErrorEventSchema } from "./events/conversation-error.js";
import { ConversationListInvalidatedEventSchema } from "./events/conversation-list-invalidated.js";
import { ConversationTitleUpdatedEventSchema } from "./events/conversation-title-updated.js";
import { DiskPressureStatusChangedEventSchema } from "./events/disk-pressure-status-changed.js";
import { DocumentCommentCreatedEventSchema } from "./events/document-comment-created.js";
import { DocumentCommentDeletedEventSchema } from "./events/document-comment-deleted.js";
import { DocumentCommentReopenedEventSchema } from "./events/document-comment-reopened.js";
import { DocumentCommentResolvedEventSchema } from "./events/document-comment-resolved.js";
import { DocumentEditorUpdateEventSchema } from "./events/document-editor-update.js";
import { ErrorEventSchema } from "./events/error.js";
import { GenerationCancelledEventSchema } from "./events/generation-cancelled.js";
import { GenerationHandoffEventSchema } from "./events/generation-handoff.js";
import { HomeFeedUpdatedEventSchema } from "./events/home-feed-updated.js";
import { IdentityChangedEventSchema } from "./events/identity-changed.js";
import { InteractionResolvedEventSchema } from "./events/interaction-resolved.js";
import { MessageCompleteEventSchema } from "./events/message-complete.js";
import { MessageDequeuedEventSchema } from "./events/message-dequeued.js";
import { MessageQueuedEventSchema } from "./events/message-queued.js";
import { MessageQueuedDeletedEventSchema } from "./events/message-queued-deleted.js";
import { MessageRequestCompleteEventSchema } from "./events/message-request-complete.js";
import { NavigateSettingsEventSchema } from "./events/navigate-settings.js";
import { NotificationIntentEventSchema } from "./events/notification-intent.js";
import { OpenUrlEventSchema } from "./events/open-url.js";
import { QuestionRequestEventSchema } from "./events/question-request.js";
import { RelationshipStateUpdatedEventSchema } from "./events/relationship-state-updated.js";
import { SecretRequestEventSchema } from "./events/secret-request.js";
import { SubagentEventEventSchema } from "./events/subagent-event.js";
import { SubagentSpawnedEventSchema } from "./events/subagent-spawned.js";
import { SubagentStatusChangedEventSchema } from "./events/subagent-status-changed.js";
import { SyncChangedEventSchema } from "./events/sync-changed.js";
import { ToolOutputChunkEventSchema } from "./events/tool-output-chunk.js";
import { ToolResultEventSchema } from "./events/tool-result.js";
import { ToolUsePreviewStartEventSchema } from "./events/tool-use-preview-start.js";
import { ToolUseStartEventSchema } from "./events/tool-use-start.js";
import { TraceEventSchema } from "./events/trace-event.js";
import { TurnProfileAutoRoutedEventSchema } from "./events/turn-profile-auto-routed.js";
import { UISurfaceCompleteEventSchema } from "./events/ui-surface-complete.js";
import { UISurfaceDismissEventSchema } from "./events/ui-surface-dismiss.js";
import { UISurfaceShowEventSchema } from "./events/ui-surface-show.js";
import { UISurfaceUpdateEventSchema } from "./events/ui-surface-update.js";
import { UsageProgressEventSchema } from "./events/usage-progress.js";
import { UsageUpdateEventSchema } from "./events/usage-update.js";
import { UserMessageEchoEventSchema } from "./events/user-message-echo.js";

export { CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE } from "./constants/call-sites.js";
export { DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC } from "./constants/tool-execution.js";
export {
  type AssistantActivityAnchor,
  AssistantActivityAnchorSchema,
  type AssistantActivityPhase,
  AssistantActivityPhaseSchema,
  type AssistantActivityReason,
  AssistantActivityReasonSchema,
  type AssistantActivityStateEvent,
  AssistantActivityStateEventSchema,
} from "./events/assistant-activity-state.js";
export {
  type AssistantOutboundAttachment,
  AssistantOutboundAttachmentSchema,
} from "./events/assistant-outbound-attachment.js";
export {
  type AssistantTextDeltaEvent,
  AssistantTextDeltaEventSchema,
} from "./events/assistant-text-delta.js";
export {
  type AssistantThinkingDeltaEvent,
  AssistantThinkingDeltaEventSchema,
} from "./events/assistant-thinking-delta.js";
export {
  type AssistantTurnStartEvent,
  AssistantTurnStartEventSchema,
} from "./events/assistant-turn-start.js";
export {
  type AvatarUpdatedEvent,
  AvatarUpdatedEventSchema,
} from "./events/avatar-updated.js";
export {
  type CompactionCircuitClosedEvent,
  CompactionCircuitClosedEventSchema,
} from "./events/compaction-circuit-closed.js";
export {
  type CompactionCircuitOpenEvent,
  CompactionCircuitOpenEventSchema,
} from "./events/compaction-circuit-open.js";
export {
  type ACPOption,
  type ACPOptionKind,
  ACPOptionKindSchema,
  ACPOptionSchema,
  type AllowlistOption,
  AllowlistOptionSchema,
  type ConfirmationDiff,
  ConfirmationDiffSchema,
  type ConfirmationExecutionTarget,
  ConfirmationExecutionTargetSchema,
  type ConfirmationRequestEvent,
  ConfirmationRequestEventSchema,
  type DirectoryScopeOption,
  DirectoryScopeOptionSchema,
  type ScopeOption,
  ScopeOptionSchema,
} from "./events/confirmation-request.js";
export {
  type ContactRequestEvent,
  ContactRequestEventSchema,
} from "./events/contact-request.js";
export {
  type ConversationErrorCode,
  ConversationErrorCodeSchema,
  type ConversationErrorEvent,
  ConversationErrorEventSchema,
} from "./events/conversation-error.js";
export {
  type ConversationListInvalidatedEvent,
  ConversationListInvalidatedEventSchema,
  type ConversationListInvalidatedReason,
  ConversationListInvalidatedReasonSchema,
} from "./events/conversation-list-invalidated.js";
export {
  type ConversationTitleUpdatedEvent,
  ConversationTitleUpdatedEventSchema,
} from "./events/conversation-title-updated.js";
export {
  type DiskPressureBlockedCapability,
  DiskPressureBlockedCapabilitySchema,
  type DiskPressureState,
  DiskPressureStateSchema,
  type DiskPressureStatus,
  type DiskPressureStatusChangedEvent,
  DiskPressureStatusChangedEventSchema,
  DiskPressureStatusSchema,
} from "./events/disk-pressure-status-changed.js";
export {
  type DocumentCommentCreatedEvent,
  DocumentCommentCreatedEventSchema,
} from "./events/document-comment-created.js";
export {
  type DocumentCommentDeletedEvent,
  DocumentCommentDeletedEventSchema,
} from "./events/document-comment-deleted.js";
export {
  type DocumentCommentReopenedEvent,
  DocumentCommentReopenedEventSchema,
} from "./events/document-comment-reopened.js";
export {
  type DocumentCommentResolvedEvent,
  DocumentCommentResolvedEventSchema,
} from "./events/document-comment-resolved.js";
export {
  type DocumentEditorUpdateEvent,
  DocumentEditorUpdateEventSchema,
} from "./events/document-editor-update.js";
export { type ErrorEvent, ErrorEventSchema } from "./events/error.js";
export {
  type GenerationCancelledEvent,
  GenerationCancelledEventSchema,
} from "./events/generation-cancelled.js";
export {
  type GenerationHandoffEvent,
  GenerationHandoffEventSchema,
} from "./events/generation-handoff.js";
export {
  type HomeFeedUpdatedEvent,
  HomeFeedUpdatedEventSchema,
} from "./events/home-feed-updated.js";
export {
  type IdentityChangedEvent,
  IdentityChangedEventSchema,
} from "./events/identity-changed.js";
export {
  type InteractionResolutionState,
  InteractionResolutionStateSchema,
  type InteractionResolvedEvent,
  InteractionResolvedEventSchema,
} from "./events/interaction-resolved.js";
export {
  type MessageCompleteEvent,
  MessageCompleteEventSchema,
} from "./events/message-complete.js";
export {
  type MessageDequeuedEvent,
  MessageDequeuedEventSchema,
} from "./events/message-dequeued.js";
export {
  type MessageQueuedEvent,
  MessageQueuedEventSchema,
} from "./events/message-queued.js";
export {
  type MessageQueuedDeletedEvent,
  MessageQueuedDeletedEventSchema,
} from "./events/message-queued-deleted.js";
export {
  type MessageRequestCompleteEvent,
  MessageRequestCompleteEventSchema,
} from "./events/message-request-complete.js";
export {
  type NavigateSettingsEvent,
  NavigateSettingsEventSchema,
} from "./events/navigate-settings.js";
export {
  type NotificationIntentEvent,
  NotificationIntentEventSchema,
} from "./events/notification-intent.js";
export { type OpenUrlEvent, OpenUrlEventSchema } from "./events/open-url.js";
export {
  type QuestionEntry,
  QuestionEntrySchema,
  type QuestionOption,
  QuestionOptionSchema,
  type QuestionRequestEvent,
  QuestionRequestEventSchema,
} from "./events/question-request.js";
export {
  type RelationshipStateUpdatedEvent,
  RelationshipStateUpdatedEventSchema,
} from "./events/relationship-state-updated.js";
export {
  type SecretRequestEvent,
  SecretRequestEventSchema,
} from "./events/secret-request.js";
export {
  type SubagentEventEvent,
  SubagentEventEventSchema,
  type SubagentInnerEvent,
  SubagentInnerEventSchema,
} from "./events/subagent-event.js";
export {
  type SubagentSpawnedEvent,
  SubagentSpawnedEventSchema,
} from "./events/subagent-spawned.js";
export {
  type SubagentStatus,
  type SubagentStatusChangedEvent,
  SubagentStatusChangedEventSchema,
  SubagentStatusSchema,
  type SubagentUsageStats,
  SubagentUsageStatsSchema,
} from "./events/subagent-status-changed.js";
export {
  type SyncChangedEvent,
  SyncChangedEventSchema,
} from "./events/sync-changed.js";
export {
  type ToolOutputChunkEvent,
  ToolOutputChunkEventSchema,
  type ToolOutputChunkSubType,
  ToolOutputChunkSubTypeSchema,
} from "./events/tool-output-chunk.js";
export {
  type RiskScopeOption,
  RiskScopeOptionSchema,
  type ToolActivityMetadata,
  ToolActivityMetadataSchema,
  type ToolResultEvent,
  ToolResultEventSchema,
  type WebFetchMetadata,
  WebFetchMetadataSchema,
  type WebSearchMetadata,
  WebSearchMetadataSchema,
  type WebSearchProviderId,
  WebSearchProviderIdSchema,
  type WebSearchResultItem,
  WebSearchResultItemSchema,
} from "./events/tool-result.js";
export {
  type ToolUsePreviewStartEvent,
  ToolUsePreviewStartEventSchema,
} from "./events/tool-use-preview-start.js";
export {
  type ToolUseStartEvent,
  ToolUseStartEventSchema,
} from "./events/tool-use-start.js";
export {
  type TraceEvent,
  type TraceEventKind,
  TraceEventKindSchema,
  TraceEventSchema,
  type TraceEventStatus,
  TraceEventStatusSchema,
} from "./events/trace-event.js";
export {
  type TurnProfileAutoRoutedEvent,
  TurnProfileAutoRoutedEventSchema,
} from "./events/turn-profile-auto-routed.js";
export {
  type UISurfaceCompleteEvent,
  UISurfaceCompleteEventSchema,
} from "./events/ui-surface-complete.js";
export {
  type UISurfaceDismissEvent,
  UISurfaceDismissEventSchema,
} from "./events/ui-surface-dismiss.js";
export {
  type SurfaceAction,
  SurfaceActionSchema,
  type UISurfaceShowEvent,
  UISurfaceShowEventSchema,
} from "./events/ui-surface-show.js";
export {
  type UISurfaceUpdateEvent,
  UISurfaceUpdateEventSchema,
} from "./events/ui-surface-update.js";
export {
  type UsageProgressEvent,
  UsageProgressEventSchema,
} from "./events/usage-progress.js";
export {
  type UsageUpdateEvent,
  UsageUpdateEventSchema,
} from "./events/usage-update.js";
export {
  type UserMessageEchoEvent,
  UserMessageEchoEventSchema,
} from "./events/user-message-echo.js";
export {
  type DictationContext,
  DictationContextSchema,
  type DictationRequest,
  DictationRequestSchema,
} from "./requests/dictation.js";
export {
  type ConversationAttachmentBlock,
  ConversationAttachmentBlockSchema,
  type ConversationContentBlock,
  ConversationContentBlockSchema,
  type ConversationMessage,
  type ConversationMessageAttachment,
  ConversationMessageAttachmentSchema,
  ConversationMessageSchema,
  type ConversationMessageSurface,
  ConversationMessageSurfaceSchema,
  type ConversationMessageToolCall,
  ConversationMessageToolCallSchema,
  type ConversationSlackMessage,
  ConversationSlackMessageSchema,
  type ConversationSubagentNotification,
  ConversationSubagentNotificationSchema,
  type ConversationSurfaceBlock,
  ConversationSurfaceBlockSchema,
  type ConversationTextBlock,
  ConversationTextBlockSchema,
  type ConversationThinkingBlock,
  ConversationThinkingBlockSchema,
  type ConversationToolUseBlock,
  ConversationToolUseBlockSchema,
  type PendingToolConfirmation,
  PendingToolConfirmationSchema,
} from "./responses/conversation-message.js";
export {
  type DiskPressureStatusResponse,
  DiskPressureStatusResponseSchema,
} from "./responses/disk-pressure-status.js";
export {
  type Capability,
  CapabilitySchema,
  type CapabilityTier,
  type ContextBanner,
  ContextBannerSchema,
  type Fact,
  type FactCategory,
  type FactConfidence,
  FactSchema,
  type FactSource,
  type FeedAction,
  FeedActionSchema,
  type FeedItem,
  type FeedItemCategory,
  FeedItemCategorySchema,
  type FeedItemDetailPanel,
  type FeedItemDetailPanelKind,
  FeedItemDetailPanelKindSchema,
  FeedItemDetailPanelSchema,
  FeedItemSchema,
  type FeedItemStatus,
  FeedItemStatusSchema,
  type FeedItemType,
  FeedItemTypeSchema,
  type FeedItemUrgency,
  FeedItemUrgencySchema,
  type HomeFeedResponse,
  HomeFeedResponseSchema,
  type RelationshipState,
  RelationshipStateSchema,
  type RelationshipTier,
  type SuggestedPrompt,
  SuggestedPromptSchema,
  type SuggestedPromptSource,
  SuggestedPromptSourceSchema,
} from "./responses/home.js";
export {
  type LlmContextResponse,
  LlmContextResponseSchema,
} from "./responses/llm-context-response.js";
export {
  type LLMCallSummary,
  LLMCallSummarySchema,
  type LLMContextSection,
  LLMContextSectionSchema,
  type LLMRequestLogEntry,
  LLMRequestLogEntrySchema,
} from "./responses/llm-request-log-entry.js";
export {
  type MemoryCandidate,
  MemoryCandidateSchema,
  type MemoryDegradation,
  MemoryDegradationSchema,
  type MemoryRecallLog,
  MemoryRecallLogSchema,
} from "./responses/memory-recall-log.js";
export {
  type MemoryV2ActivationLog,
  MemoryV2ActivationLogSchema,
  type MemoryV2ConceptRow,
  MemoryV2ConceptRowSchema,
  type MemoryV2ConfigSnapshot,
  MemoryV2ConfigSnapshotSchema,
} from "./responses/memory-v2-activation-log.js";
export {
  type MemoryV3SelectionLog,
  MemoryV3SelectionLogSchema,
  type MemoryV3SelectionRow,
  MemoryV3SelectionRowSchema,
} from "./responses/memory-v3-selection-log.js";
export {
  type SubagentDetailEvent,
  SubagentDetailEventSchema,
  type SubagentDetailResponse,
  SubagentDetailResponseSchema,
} from "./responses/subagent-detail.js";

/**
 * Canonical SSE event schema for the assistant runtime.
 *
 * Discriminated union over the `type` field. Each member is the
 * canonical wire-contract schema for a single event type, defined
 * alongside the daemon code that emits it. Consumers (web client,
 * gateway, evals) parse incoming events with this single schema
 * rather than maintaining their own dispatch table.
 *
 * Add new events by exporting their schema from `./events/` and
 * appending them to the union below. See `./README.md` for the full
 * migration recipe.
 */
export const AssistantEventSchema = z.discriminatedUnion("type", [
  AssistantActivityStateEventSchema,
  AssistantTextDeltaEventSchema,
  AssistantThinkingDeltaEventSchema,
  AssistantTurnStartEventSchema,
  AvatarUpdatedEventSchema,
  CompactionCircuitClosedEventSchema,
  CompactionCircuitOpenEventSchema,
  ConfirmationRequestEventSchema,
  ContactRequestEventSchema,
  ConversationErrorEventSchema,
  ConversationListInvalidatedEventSchema,
  ConversationTitleUpdatedEventSchema,
  DiskPressureStatusChangedEventSchema,
  DocumentCommentCreatedEventSchema,
  DocumentCommentDeletedEventSchema,
  DocumentCommentReopenedEventSchema,
  DocumentCommentResolvedEventSchema,
  DocumentEditorUpdateEventSchema,
  ErrorEventSchema,
  GenerationCancelledEventSchema,
  GenerationHandoffEventSchema,
  HomeFeedUpdatedEventSchema,
  IdentityChangedEventSchema,
  InteractionResolvedEventSchema,
  MessageCompleteEventSchema,
  MessageDequeuedEventSchema,
  MessageQueuedEventSchema,
  MessageQueuedDeletedEventSchema,
  MessageRequestCompleteEventSchema,
  NavigateSettingsEventSchema,
  NotificationIntentEventSchema,
  OpenUrlEventSchema,
  QuestionRequestEventSchema,
  RelationshipStateUpdatedEventSchema,
  SecretRequestEventSchema,
  SubagentEventEventSchema,
  SubagentSpawnedEventSchema,
  SubagentStatusChangedEventSchema,
  SyncChangedEventSchema,
  ToolOutputChunkEventSchema,
  ToolResultEventSchema,
  ToolUsePreviewStartEventSchema,
  ToolUseStartEventSchema,
  TraceEventSchema,
  TurnProfileAutoRoutedEventSchema,
  UISurfaceCompleteEventSchema,
  UISurfaceDismissEventSchema,
  UISurfaceShowEventSchema,
  UISurfaceUpdateEventSchema,
  UsageProgressEventSchema,
  UsageUpdateEventSchema,
  UserMessageEchoEventSchema,
]);

/**
 * Inferred TypeScript union for every event currently covered by
 * `AssistantEventSchema`. Consumers should reference this single type
 * rather than re-listing the individual member types — as each new
 * event migrates into the schema, it appears here automatically.
 */
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

/**
 * SSE wire envelope wrapping every outbound event from the daemon.
 *
 * Transport-level metadata (`id`, `seq`, `emittedAt`, `conversationId`)
 * surrounds the semantic event payload in `message`.
 */
export const AssistantEventEnvelopeSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  seq: z.number().int().optional(),
  emittedAt: z.string(),
  message: AssistantEventSchema,
});

export type AssistantEventEnvelope = z.infer<
  typeof AssistantEventEnvelopeSchema
>;
