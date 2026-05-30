import { z } from "zod";

import { AssistantTextDeltaEventSchema } from "./events/assistant-text-delta.js";
import { AssistantTurnStartEventSchema } from "./events/assistant-turn-start.js";
import { CompactionCircuitClosedEventSchema } from "./events/compaction-circuit-closed.js";
import { CompactionCircuitOpenEventSchema } from "./events/compaction-circuit-open.js";
import { DocumentCommentCreatedEventSchema } from "./events/document-comment-created.js";
import { DocumentCommentDeletedEventSchema } from "./events/document-comment-deleted.js";
import { DocumentCommentReopenedEventSchema } from "./events/document-comment-reopened.js";
import { DocumentCommentResolvedEventSchema } from "./events/document-comment-resolved.js";
import { GenerationCancelledEventSchema } from "./events/generation-cancelled.js";
import { GenerationHandoffEventSchema } from "./events/generation-handoff.js";
import { HomeFeedUpdatedEventSchema } from "./events/home-feed-updated.js";
import { InteractionResolvedEventSchema } from "./events/interaction-resolved.js";
import { MessageCompleteEventSchema } from "./events/message-complete.js";
import { MessageDequeuedEventSchema } from "./events/message-dequeued.js";
import { MessageQueuedEventSchema } from "./events/message-queued.js";
import { MessageQueuedDeletedEventSchema } from "./events/message-queued-deleted.js";
import { MessageRequestCompleteEventSchema } from "./events/message-request-complete.js";
import { OpenUrlEventSchema } from "./events/open-url.js";
import { RelationshipStateUpdatedEventSchema } from "./events/relationship-state-updated.js";
import { ToolUseStartEventSchema } from "./events/tool-use-start.js";

export { CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE } from "./constants/call-sites.js";
export { DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC } from "./constants/tool-execution.js";
export {
  type AssistantOutboundAttachment,
  AssistantOutboundAttachmentSchema,
} from "./events/assistant-outbound-attachment.js";
export {
  type AssistantTextDeltaEvent,
  AssistantTextDeltaEventSchema,
} from "./events/assistant-text-delta.js";
export {
  type AssistantTurnStartEvent,
  AssistantTurnStartEventSchema,
} from "./events/assistant-turn-start.js";
export {
  type CompactionCircuitClosedEvent,
  CompactionCircuitClosedEventSchema,
} from "./events/compaction-circuit-closed.js";
export {
  type CompactionCircuitOpenEvent,
  CompactionCircuitOpenEventSchema,
} from "./events/compaction-circuit-open.js";
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
export { type OpenUrlEvent, OpenUrlEventSchema } from "./events/open-url.js";
export {
  type RelationshipStateUpdatedEvent,
  RelationshipStateUpdatedEventSchema,
} from "./events/relationship-state-updated.js";
export {
  type ToolUseStartEvent,
  ToolUseStartEventSchema,
} from "./events/tool-use-start.js";
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
  AssistantTextDeltaEventSchema,
  AssistantTurnStartEventSchema,
  CompactionCircuitClosedEventSchema,
  CompactionCircuitOpenEventSchema,
  DocumentCommentCreatedEventSchema,
  DocumentCommentDeletedEventSchema,
  DocumentCommentReopenedEventSchema,
  DocumentCommentResolvedEventSchema,
  GenerationCancelledEventSchema,
  GenerationHandoffEventSchema,
  HomeFeedUpdatedEventSchema,
  InteractionResolvedEventSchema,
  MessageCompleteEventSchema,
  MessageDequeuedEventSchema,
  MessageQueuedEventSchema,
  MessageQueuedDeletedEventSchema,
  MessageRequestCompleteEventSchema,
  OpenUrlEventSchema,
  RelationshipStateUpdatedEventSchema,
  ToolUseStartEventSchema,
]);

/**
 * Inferred TypeScript union for every event currently covered by
 * `AssistantEventSchema`. Consumers should reference this single type
 * rather than re-listing the individual member types — as each new
 * event migrates into the schema, it appears here automatically.
 */
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;
