/**
 * Skill IPC routes for the `host.memory.*` facet.
 *
 * These mirror the in-process delegates used by `DaemonSkillHost`
 * (see `assistant/src/daemon/daemon-skill-host.ts`). Every handler is a
 * thin pass-through to the underlying daemon module, with schema-validated
 * params and a serializable return shape.
 */

import { z } from "zod";

import { addMessage } from "../../memory/conversation-crud.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import type { IpcRoute } from "../assistant-server.js";

// -- Param schemas --------------------------------------------------------

/**
 * Shape mirrors the daemon's `addMessage()` positional signature:
 * `(conversationId, role, content, metadata?, opts?)`. Metadata is a
 * free-form record (validated downstream by `messageMetadataSchema` with a
 * warn-and-store fallback). Only `skipIndexing` is recognised in `opts`.
 */
const MemoryAddMessageParams = z.object({
  conversationId: z.string().min(1),
  role: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  opts: z
    .object({
      skipIndexing: z.boolean().optional(),
    })
    .optional(),
});

/** Mirrors `WakeOptions` from `runtime/agent-wake.ts`. */
const MemoryWakeOpportunityParams = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().min(1),
});

// -- Handlers -------------------------------------------------------------

async function handleAddMessage(params?: Record<string, unknown>) {
  const { conversationId, role, content, metadata, opts } =
    MemoryAddMessageParams.parse(params);
  return addMessage(conversationId, role, content, metadata, opts);
}

async function handleWakeAgentForOpportunity(
  params?: Record<string, unknown>,
): Promise<void> {
  const opts = MemoryWakeOpportunityParams.parse(params);
  // Contract exposes `void` even though the daemon returns a `WakeResult` —
  // the skill surface does not need the producedToolCalls / reason fields.
  await wakeAgentForOpportunity(opts);
}

// -- Route definitions ----------------------------------------------------

export const memoryAddMessageRoute: IpcRoute = {
  method: "host.memory.addMessage",
  handler: handleAddMessage,
};

export const memoryWakeAgentForOpportunityRoute: IpcRoute = {
  method: "host.memory.wakeAgentForOpportunity",
  handler: handleWakeAgentForOpportunity,
};

/** All `host.memory.*` IPC routes. */
export const memorySkillRoutes: IpcRoute[] = [
  memoryAddMessageRoute,
  memoryWakeAgentForOpportunityRoute,
];
