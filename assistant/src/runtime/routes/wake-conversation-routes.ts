/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { wakeAgentForOpportunity } from "../agent-wake.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const WakeConversationBody = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
  // Honored only for a `local` caller (see handler) — a remote `actor` could
  // otherwise attribute its wake's cost to an arbitrary firing.
  cronRunId: z.string().min(1).optional(),
  // Persist the trigger as a background event rather than an ephemeral hint, so
  // repeated wakes stay prompt-cache-friendly.
  persist: z.boolean().optional(),
  // Untrusted third-party data, fenced so the model treats it as data rather
  // than instructions. Only meaningful alongside `persist`.
  externalContent: z.string().optional(),
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
    handler: async ({ body, headers }) => {
      const {
        conversationId,
        hint,
        source,
        cronRunId,
        persist,
        externalContent,
      } = WakeConversationBody.parse(body);

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(`Conversation not found: ${conversationId}`);
      }

      // A local IPC caller is already guardian-capable, so its wake runs as a
      // non-interactive guardian: `clientless` makes the turn derive
      // `isInteractive: false` (mapped to the `background` policy context), so
      // read-only/reasoning tools stay available while side-effecting tools are
      // denied at the default threshold rather than stalling on an absent
      // client. A remote `actor` (reachable via the gateway) stays
      // `unknown`/interactive. The body's `cronRunId` is trusted only from a
      // local caller.
      const isLocal = headers?.["x-vellum-principal-type"] === "local";

      return wakeAgentForOpportunity({
        conversationId,
        hint,
        source,
        ...(isLocal
          ? { trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT, clientless: true }
          : {}),
        ...(isLocal && cronRunId ? { cronRunId } : {}),
        ...(persist ? { persistTriggerAsEvent: true } : {}),
        ...(externalContent !== undefined
          ? { untrustedOutput: { content: externalContent, source: "webhook" } }
          : {}),
      });
    },
  },
];
