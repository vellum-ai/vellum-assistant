import { z } from "zod";

import { AssistantTurnStartEventSchema } from "./events/assistant-turn-start.js";
import { OpenUrlEventSchema } from "./events/open-url.js";
import { RelationshipStateUpdatedEventSchema } from "./events/relationship-state-updated.js";
import { ToolUseStartEventSchema } from "./events/tool-use-start.js";

export { CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE } from "./constants/call-sites.js";
export {
  type AssistantTurnStartEvent,
  AssistantTurnStartEventSchema,
} from "./events/assistant-turn-start.js";
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
  AssistantTurnStartEventSchema,
  OpenUrlEventSchema,
  RelationshipStateUpdatedEventSchema,
  ToolUseStartEventSchema,
]);
