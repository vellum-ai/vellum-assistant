/**
 * An email from the assistant's inbox, as another surface hands it to the
 * chat composer.
 *
 * Shared between the inbox (which selects the mail) and the chat domain
 * (which stages it as a composer attachment and folds it into the outgoing
 * message), so it lives at the top level rather than in either domain. Only
 * the header is carried: the assistant reads the body itself with
 * `assistant email download <id>`, the same way the inbox's "Ask to reply"
 * prompt already has it do.
 */

export type EmailReferenceDirection = "inbound" | "outbound";

export interface EmailReferenceParticipant {
  /** Display name when the header carried one; the address stands in otherwise. */
  name?: string;
  address: string;
}

export interface EmailReference {
  /** The platform's message id, which the assistant's email tooling takes. */
  id: string;
  direction: EmailReferenceDirection;
  from: EmailReferenceParticipant;
  to: EmailReferenceParticipant[];
  subject: string;
  /** ISO 8601. */
  createdAt: string;
  /** The first line or so of the body, when the row carried one. */
  snippet?: string;
}
