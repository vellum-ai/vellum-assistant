/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { getConversation } from "../../memory/conversation-crud.js";
import { firingTokenRegistry } from "../../schedule/firing-token-registry.js";
import { getSchedule } from "../../schedule/schedule-store.js";
import { wakeAgentForOpportunity } from "../agent-wake.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const WakeConversationBody = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
  // Per-firing secret token from a script-mode schedule's subprocess env
  // (`__SCHEDULE_RUN_TOKEN`). It identifies which firing is calling so the
  // daemon can apply that schedule's trust level and attribute the woken
  // turn's cost. The run id is derived from the token, never accepted from the
  // body — any `chat.write` caller could otherwise attribute a wake to an
  // arbitrary firing.
  runToken: z.string().min(1).optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "wake_conversation",
    endpoint: "conversations/wake",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Wake a conversation",
    description:
      "Invoke the agent loop for a conversation with an opportunity hint.",
    tags: ["conversations"],
    requestBody: WakeConversationBody,
    responseBody: z.object({
      invoked: z.boolean(),
      producedToolCalls: z.boolean(),
      reason: z.string().optional(),
    }),
    handler: async ({ body }) => {
      const { conversationId, hint, source, runToken } =
        WakeConversationBody.parse(body);

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(`Conversation not found: ${conversationId}`);
      }

      // A tokened wake is a script-mode schedule escalation: a background turn
      // with no client to answer a prompt. Run it clientless (non-interactive)
      // so a side-effecting tool is denied rather than stalling, and elevate to
      // the schedule's declared trust only when the token resolves to a LIVE
      // guardian firing. Resolution can only ever make the turn more
      // restrictive (headless) or grant trust — never less safe.
      let cronRunId: string | undefined;
      let elevateToGuardian = false;
      if (runToken) {
        const firing = firingTokenRegistry.resolve(runToken);
        if (firing) {
          cronRunId = firing.runId;
          elevateToGuardian =
            getSchedule(firing.jobId)?.trustLevel === "guardian";
        }
      }

      return wakeAgentForOpportunity({
        conversationId,
        hint,
        source,
        ...(elevateToGuardian
          ? { trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT }
          : {}),
        ...(cronRunId ? { cronRunId } : {}),
        ...(runToken ? { clientless: true } : {}),
      });
    },
  },
];
