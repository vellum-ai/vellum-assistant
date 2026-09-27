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

import { truncate } from "@/domains/chat/utils/truncate";
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

/**
 * Cut through `truncate`, which steps back off a split surrogate pair: this
 * text goes out to the model, and a lone half is invalid JSON to a strict
 * provider parser.
 */
function boundedSnippet(value: string | undefined): string | undefined {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return truncate(collapsed, EMAIL_REFERENCE_SNIPPET_MAX);
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

/** What {@link extractEmailReferences} hands back: the emails and the rest of the text. */
export interface ExtractedEmailReferences {
  emails: EmailReference[];
  /** The message with the blocks removed, trimmed. */
  rest: string;
}

function parseParticipant(value: string): EmailReferenceParticipant {
  const match = value.match(/^(.*?)\s*<([^<>]+)>$/);
  if (match) {
    const name = match[1]!.trim();
    return name
      ? { name, address: match[2]!.trim() }
      : { address: match[2]!.trim() };
  }
  return { address: value.trim() };
}

function parseBlock(lines: string[]): EmailReference | null {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(": ");
    if (separator === -1) {
      continue;
    }
    fields.set(line.slice(0, separator), line.slice(separator + 2).trim());
  }
  const id = fields.get("message-id");
  if (!id) {
    return null;
  }
  const reference: EmailReference = {
    id,
    direction: fields.get("direction") === "sent" ? "outbound" : "inbound",
    from: parseParticipant(fields.get("from") ?? ""),
    to: (fields.get("to") ?? "")
      .split(/,\s+/)
      .filter((part) => part.length > 0)
      .map(parseParticipant),
    subject: fields.get("subject") ?? "",
    createdAt: fields.get("sent-at") ?? "",
  };
  const snippet = fields.get("snippet");
  if (snippet) {
    reference.snippet = snippet;
  }
  return reference;
}

/**
 * Read the blocks {@link formatEmailReference} wrote back out of a message,
 * so the transcript can draw the emails as cards and the text the user typed
 * as text. The inverse of the formatter for the fields the card needs;
 * anything that is not a complete block is left in the text untouched.
 */
export function extractEmailReferences(
  content: string,
): ExtractedEmailReferences {
  const lines = content.split("\n");
  const emails: EmailReference[] = [];
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const unquoted = lines[index]!.replace(/^>\s?/, "").trim();
    if (unquoted !== REFERENCE_OPEN) {
      kept.push(lines[index]!);
      index += 1;
      continue;
    }
    const body: string[] = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const inner = lines[cursor]!.replace(/^>\s?/, "").trim();
      if (inner === REFERENCE_CLOSE) {
        closed = true;
        break;
      }
      body.push(inner);
      cursor += 1;
    }
    const email = closed ? parseBlock(body) : null;
    if (!email) {
      kept.push(lines[index]!);
      index += 1;
      continue;
    }
    emails.push(email);
    index = cursor + 1;
  }
  return { emails, rest: kept.join("\n").trim() };
}
