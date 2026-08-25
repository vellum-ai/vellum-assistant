/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { getSchedule } from "../../schedule/schedule-store.js";
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
  // Runs the turn on this schedule's pinned inference profile. Honored only for
  // a `local` caller (see handler): a remote `actor` could otherwise run turns
  // under an arbitrary schedule's profile and spend the owner's money.
  scheduleId: z.string().min(1).optional(),
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
        scheduleId,
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

      // A script-mode schedule hands off to the agent loop through this route,
      // so the schedule's pinned profile has to be applied here for the woken
      // turn to run on the model the schedule was created under.
      //
      // The pin applies per turn rather than as a durable conversation pin,
      // and it wins over the target conversation's own pin for turns the
      // schedule triggers. That matters because a script may wake any
      // conversation it names, not only the `scheduled` one it created:
      // waking an interactive chat runs that one turn on the schedule's
      // profile, while the user's own replies keep using their selection.
      // A schedule with no pin resolves as any other turn does.
      const scheduleProfile =
        isLocal && scheduleId
          ? (getSchedule(scheduleId)?.inferenceProfile ?? null)
          : null;

      const result = await wakeAgentForOpportunity({
        conversationId,
        hint,
        source,
        ...(isLocal
          ? { trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT, clientless: true }
          : {}),
        ...(isLocal && cronRunId ? { cronRunId } : {}),
        ...(scheduleProfile ? { forceOverrideProfile: scheduleProfile } : {}),
        ...(persist ? { persistTriggerAsEvent: true } : {}),
        ...(externalContent !== undefined
          ? { untrustedOutput: { content: externalContent, source: "webhook" } }
          : {}),
      });
      // Pin the wire shape to the declared responseBody: WakeResult carries
      // in-process diagnostics (exitReason) beyond this route's contract.
      return {
        invoked: result.invoked,
        producedToolCalls: result.producedToolCalls,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    },
  },
];
