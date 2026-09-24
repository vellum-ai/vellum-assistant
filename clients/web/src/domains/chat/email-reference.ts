/**
 * How emails staged from the assistant's inbox reach the assistant.
 *
 * The wire has no seam for structured context beyond `content` and uploaded
 * `attachmentIds` (see the module note in `channel-sidecar/channel-reference`),
 * so each staged email is encoded into the outgoing message body as a
 * delimited block, the same way a channel reference and staged quotes are.
 * The block carries the header only: the message id is what the assistant's
 * own email tooling takes (`assistant email download <id>`), so the body is
 * fetched on its side rather than pasted into the user's turn.
 */

import type {
  EmailReference,
  EmailReferenceParticipant,
} from "@/types/email-reference";

/**
 * Sentinels opening and closing the encoded block. Protocol tokens the
 * assistant matches on, so they are not translated and not reworded; the
 * field names below are the same.
 */
const REFERENCE_OPEN = "[vellum:email-reference]";
const REFERENCE_CLOSE = "[/vellum:email-reference]";

/**
 * Longest snippet a reference carries. The list row's preview is already a
 * line or so; this keeps a prefetched full body from dominating the turn.
 */
export const EMAIL_REFERENCE_SNIPPET_MAX = 280;

function participantLabel(participant: EmailReferenceParticipant): string {
  const name = participant.name?.trim();
  return name ? `${name} <${participant.address}>` : participant.address;
}

function boundedSnippet(value: string | undefined): string | undefined {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  if (collapsed.length <= EMAIL_REFERENCE_SNIPPET_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, EMAIL_REFERENCE_SNIPPET_MAX).trimEnd()}…`;
}

/**
 * Render one staged email as the delimited block that ships inside the
 * outgoing message. Every line is quoted so the block renders as one
 * blockquote in the sent bubble; absent fields are omitted rather than
 * emitted empty.
 */
export function formatEmailReference(email: EmailReference): string {
  const fields: Array<[string, string | undefined]> = [
    ["message-id", email.id],
    ["direction", email.direction === "inbound" ? "received" : "sent"],
    ["from", participantLabel(email.from)],
    ["to", email.to.map(participantLabel).join(", ")],
    ["subject", email.subject],
    ["sent-at", email.createdAt],
    ["snippet", boundedSnippet(email.snippet)],
    ["full-message", `assistant email download ${email.id}`],
  ];

  const lines: string[] = [REFERENCE_OPEN];
  for (const [key, value] of fields) {
    const trimmed = value?.trim();
    if (trimmed) {
      lines.push(`${key}: ${trimmed}`);
    }
  }
  lines.push(REFERENCE_CLOSE);

  return lines.map((line) => `> ${line}`.trimEnd()).join("\n");
}

/**
 * Fold staged emails into the message the user is about to send. The emails
 * lead, in the order they were staged: they are the thing being talked
 * about, and the freeform text is the user's remark on them. Mirrors the
 * channel reference's ordering.
 */
export function prependEmailReferences(
  content: string,
  emails: EmailReference[],
): string {
  if (emails.length === 0) {
    return content;
  }
  const blocks = emails.map(formatEmailReference).join("\n\n");
  return content ? `${blocks}\n\n${content}` : blocks;
}
