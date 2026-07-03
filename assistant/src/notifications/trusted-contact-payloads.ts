/**
 * Typed context payloads for the trusted-contact lifecycle notification signals.
 *
 * These `ingress.trusted_contact.*` signals are emitted from the canonical
 * resolver (`approvals/guardian-request-resolvers.ts`), and the decision
 * payload is read back by the notification copy-composer. A single zod schema
 * is the source of truth for both sides, so the producer cannot drift from the
 * consumer.
 *
 * Identity fields are nullable: producers populate them (using "" for an
 * unknown id), but a payload read back off persisted JSON may legitimately
 * carry a null/absent identity, and the copy-composer degrades per-field. Only
 * `sourceChannel` and `decision` are strict — they gate routing and rendering.
 *
 * Shapes are zod schemas (single source of truth for runtime validation and
 * TypeScript types), matching the `guardian.question` payload pattern.
 * https://zod.dev/?id=basic-usage
 */

import { z } from "zod";

import { NotificationSourceChannelSchema } from "./signal.js";

/** Identity fields shared by every trusted-contact lifecycle payload. */
const TrustedContactIdentitySchema = z.object({
  sourceChannel: NotificationSourceChannelSchema,
  requesterExternalUserId: z.string().nullable(),
  requesterChatId: z.string().nullable(),
  requesterDisplayName: z.string().nullable(),
  decidedByDisplayName: z.string().nullable(),
});

/**
 * Payload for `ingress.trusted_contact.guardian_decision` and
 * `ingress.trusted_contact.denied` — the guardian's verdict on an access
 * request. The deny path emits both events from one object; the approve path
 * emits `guardian_decision` with `decision: "approved"` (identical shape).
 */
export const TrustedContactDecisionPayloadSchema =
  TrustedContactIdentitySchema.extend({
    decidedByExternalUserId: z.string().nullable(),
    decision: z.enum(["approved", "denied"]),
  });
export type TrustedContactDecisionPayload = z.infer<
  typeof TrustedContactDecisionPayloadSchema
>;

/**
 * Payload for `ingress.trusted_contact.verification_sent` — the verification
 * code was minted and delivered. Carries the session id; no `decision`.
 */
export const TrustedContactVerificationSentPayloadSchema =
  TrustedContactIdentitySchema.extend({
    verificationSessionId: z.string(),
  });
export type TrustedContactVerificationSentPayload = z.infer<
  typeof TrustedContactVerificationSentPayloadSchema
>;

/**
 * Parse an unknown context payload as a trusted-contact decision payload.
 * Returns the typed payload on success, or `null` when the shape doesn't match
 * — the copy-composer falls back to generic copy in that case.
 */
export function parseTrustedContactDecisionPayload(
  payload: Record<string, unknown>,
): TrustedContactDecisionPayload | null {
  const result = TrustedContactDecisionPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}
