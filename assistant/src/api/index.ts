import { z } from "zod";

import { AssistantTextDeltaEventSchema } from "./events/assistant-text-delta.js";
import { AssistantTurnStartEventSchema } from "./events/assistant-turn-start.js";
import { GenerationCancelledEventSchema } from "./events/generation-cancelled.js";
import { GenerationHandoffEventSchema } from "./events/generation-handoff.js";
import { MessageCompleteEventSchema } from "./events/message-complete.js";
import { OpenUrlEventSchema } from "./events/open-url.js";
import { RelationshipStateUpdatedEventSchema } from "./events/relationship-state-updated.js";
import { ToolUseStartEventSchema } from "./events/tool-use-start.js";

export { CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE } from "./constants/call-sites.js";
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
  type GenerationCancelledEvent,
  GenerationCancelledEventSchema,
} from "./events/generation-cancelled.js";
export {
  type GenerationHandoffEvent,
  GenerationHandoffEventSchema,
} from "./events/generation-handoff.js";
export {
  type MessageCompleteEvent,
  MessageCompleteEventSchema,
} from "./events/message-complete.js";
export { type OpenUrlEvent, OpenUrlEventSchema } from "./events/open-url.js";
export {
  type RelationshipStateUpdatedEvent,
  RelationshipStateUpdatedEventSchema,
} from "./events/relationship-state-updated.js";
export {
  type ToolUseStartEvent,
  ToolUseStartEventSchema,
} from "./events/tool-use-start.js";
export type {
  LLMCallSummary,
  LLMContextSection,
  LLMRequestLogEntry,
} from "./responses/llm-request-log-entry.js";

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
  GenerationCancelledEventSchema,
  GenerationHandoffEventSchema,
  MessageCompleteEventSchema,
  OpenUrlEventSchema,
  RelationshipStateUpdatedEventSchema,
  ToolUseStartEventSchema,
]);
