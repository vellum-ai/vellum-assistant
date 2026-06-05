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
import type { SkillIpcRoute } from "../skill-ipc-types.js";

// -- Param schemas --------------------------------------------------------

/**
 * IPC params for `addMessage()`. `role` is constrained to the
 * renderable conversation roles (`user`/`assistant`): the messages store
 * is UI-facing (`ConversationMessage`), so agent-context `system` rows are
 * not accepted here. `metadata` is a free-form record (validated
 * downstream by `messageMetadataSchema` with a warn-and-store fallback).
 * `skipIndexing` and `clientMessageId` mirror `AddMessageOptions`.
 *
 * The `opts` field is a backward-compat shim: the macOS app and platform
 * do not release together, so a skill-host built against an older contract
 * may still send `{ opts: { skipIndexing } }` instead of the flat shape.
 * The handler flattens it via `skipIndexing ?? opts?.skipIndexing`.
 */
const MemoryAddMessageParams = z.object({
  conversationId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  skipIndexing: z.boolean().optional(),
  clientMessageId: z.string().optional(),
  opts: z.object({ skipIndexing: z.boolean().optional() }).optional(),
});

/** Mirrors `WakeOptions` from `runtime/agent-wake.ts`. */
const MemoryWakeOpportunityParams = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().min(1),
});

// -- Handlers -------------------------------------------------------------

async function handleAddMessage(params?: Record<string, unknown>) {
  const {
    conversationId,
    role,
    content,
    metadata,
    skipIndexing,
    clientMessageId,
    opts,
  } = MemoryAddMessageParams.parse(params);
  return addMessage(conversationId, role, content, {
    metadata,
    skipIndexing: skipIndexing ?? opts?.skipIndexing,
    clientMessageId,
  });
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

export const memoryAddMessageRoute: SkillIpcRoute = {
  method: "host.memory.addMessage",
  handler: handleAddMessage,
};

export const memoryWakeAgentForOpportunityRoute: SkillIpcRoute = {
  method: "host.memory.wakeAgentForOpportunity",
  handler: handleWakeAgentForOpportunity,
};

/** All `host.memory.*` IPC routes. */
export const memorySkillRoutes: SkillIpcRoute[] = [
  memoryAddMessageRoute,
  memoryWakeAgentForOpportunityRoute,
];
