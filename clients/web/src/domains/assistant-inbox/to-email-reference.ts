import type { EmailReference } from "@/types/email-reference";

import type { InboxEmail } from "./types";

/**
 * The header of an inbox row, as the chat composer stages it. Only what the
 * chip draws and the assistant needs to find the message again; the body,
 * when the row carries one, stays behind, since the assistant reads it by id.
 */
export function toEmailReference(email: InboxEmail): EmailReference {
  const reference: EmailReference = {
    id: email.id,
    direction: email.direction,
    from: email.from,
    to: email.to,
    subject: email.subject,
    createdAt: email.createdAt,
  };
  if (email.snippet) {
    reference.snippet = email.snippet;
  }
  return reference;
}
