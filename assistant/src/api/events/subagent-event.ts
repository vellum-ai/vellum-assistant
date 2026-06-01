/**
 * `subagent_event` SSE event.
 *
 * Server → client envelope wrapping any inner `ServerMessage`
 * emitted by a subagent's conversation. The daemon's subagent
 * manager rebroadcasts the subagent's own stream through the
 * parent conversation's `sendToClient`, tagged with the subagent's
 * id and the parent's `conversationId`. Clients use this envelope
 * to route inner events to the appropriate inline subagent surface.
 *
 * The inner `event` is opaque on the wire — it is itself a fully
 * structured `ServerMessage` (any member of the canonical event
 * union) and re-validating it here would duplicate work and
 * tightly couple subagent canonicalization to every other event
 * schema. Clients re-parse `event` through the same event parser
 * they use for top-level stream events. The canonical contract
 * requires only that `event.type` exists.
 *
 * `conversationId` IS present on this event — unlike `spawned` /
 * `status_changed`, the daemon explicitly stamps it with the
 * parent conversation id at the envelope layer
 * (`subagent/manager.ts: wrappedSendToClient`).
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Inner event payload wrapped by `subagent_event`. Modeled as a
 * passthrough envelope keyed on `type` plus a curated set of
 * convenience fields that client surfaces (timeline, status badge,
 * inline cards) read directly without re-parsing the inner event
 * through the top-level event parser.
 *
 * The full canonical shape of any inner event is whatever the
 * top-level `AssistantEventSchema` says it is for that `type`;
 * extra fields pass through untouched. The fields below are not
 * required by the wire contract — they are hints for downstream
 * clients to avoid drilling into discriminated unions for common
 * read paths.
 */
export const SubagentInnerEventSchema = z
  .object({
    type: z.string(),
    content: z.string().optional(),
    /** `assistant_text_delta` events carry text in `text`, not `content`. */
    text: z.string().optional(),
    /** `tool_result` events carry output in `result`, not `content`. */
    result: z.string().optional(),
    /** `tool_use_start` events carry a JSON object with tool arguments. */
    input: z.record(z.string(), z.unknown()).optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    /**
     * Tool-use block ID for client-side correlation. Present on
     * `tool_use_start` and `tool_result` envelopes; used to pair a
     * result with its originating call when a subagent emits parallel
     * calls to the same tool (e.g. two `bash` calls) which `toolName`
     * alone cannot disambiguate.
     */
    toolUseId: z.string().optional(),
  })
  .passthrough();

export type SubagentInnerEvent = z.infer<typeof SubagentInnerEventSchema>;

export const SubagentEventEventSchema = z
  .object({
    type: z.literal("subagent_event"),
    conversationId: z.string(),
    subagentId: z.string(),
    event: SubagentInnerEventSchema,
  })
  .strict();

export type SubagentEventEvent = z.infer<typeof SubagentEventEventSchema>;
