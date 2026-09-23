/**
 * Wire contract for the guardian decision endpoint
 * (`POST /guardian-actions/decision`).
 *
 * Canonical wire-contract source. The daemon route sources its `requestBody`
 * from here and validates each body against it; external consumers (web
 * client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { GuardianDecisionActionIdSchema } from "@vellumai/service-contracts/guardian-requests";
import { z } from "zod";

export const GuardianActionDecisionRequestSchema = z.object({
  requestId: z.string().min(1).describe("Guardian request ID"),
  action: GuardianDecisionActionIdSchema.describe("Decision action"),
  conversationId: z.string().describe("Conversation ID").optional(),
});
export type GuardianActionDecisionRequest = z.infer<
  typeof GuardianActionDecisionRequestSchema
>;
