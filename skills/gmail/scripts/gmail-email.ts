#!/usr/bin/env bun

/**
 * Gmail email composition and sending operations.
 * Subcommands: draft, send-draft, forward, trash
 */

import {
  parseArgs,
  printError,
  ok,
  requireArg,
  optionalArg,
} from "./lib/common.js";
import {
  gmailGet,
  gmailPost,
  type GmailMessagePart,
} from "./lib/gmail-client.js";
import { toBase64Url, buildMultipartMime } from "./lib/mime-builder.js";

// ---------------------------------------------------------------------------
// UI confirmation helper
// ---------------------------------------------------------------------------

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const args = [
    "assistant",
    "ui",
    "confirm",
    "--title",
    opts.title,
    "--message",
    opts.message,
    "--confirm-label",
    opts.confirmLabel ?? "Confirm",
    "--json",
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function extractPlainTextBody(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(
      part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractPlainTextBody(child);
      if (text) return text;
    }
  }
  return "";
}

interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
}

function collectAttachmentRefs(
  parts: GmailMessagePart[] | undefined,
): AttachmentRef[] {
  if (!parts) return [];
  const result: AttachmentRef[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      result.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
      });
    }
    if (part.parts) result.push(...collectAttachmentRefs(part.parts));
  }
  return result;
}

function printUsage(): void {
  console.log(`Usage: gmail-email.ts <subcommand> [options]

Subcommands:
  draft        Create an email draft
  send-draft   Send an existing draft
  forward      Forward a message
  trash        Move a message to trash

Run with <subcommand> --help for subcommand-specific options.`);
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

async function draft(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: gmail-email.ts draft --to <emails> --subject <text> --body <text>

Options:
  --to          Recipient email address (required)
  --subject     Email subject (required)
  --body        Email body as plain text (required)
  --cc          CC email address
  --bcc         BCC email address
  --in-reply-to Gmail message ID or RFC 822 Message-ID to reply to
  --thread-id   Gmail thread ID for threading
  --account     Gmail account to use`);
    return;
  }

  const to = requireArg(args, "to");
  const subject = requireArg(args, "subject");
  const body = requireArg(args, "body");
  const inReplyTo = optionalArg(args, "in-reply-to");
  const threadId = optionalArg(args, "thread-id");
  const cc = optionalArg(args, "cc");
  const bcc = optionalArg(args, "bcc");
  const account = optionalArg(args, "account");

  // Auto-resolve: if in_reply_to looks like a Gmail message ID (not an RFC 822
  // Message-ID), fetch the real header so threading works transparently.
  let resolvedInReplyTo = inReplyTo;
  if (inReplyTo && !inReplyTo.startsWith("<")) {
    const msgResponse = await gmailGet<{
      payload?: {
        headers?: Array<{ name: string; value: string }>;
      };
    }>(
      `/messages/${inReplyTo}`,
      { format: "metadata", metadataHeaders: "Message-ID" },
      account,
    );
    if (msgResponse.ok && msgResponse.data.payload?.headers) {
      const rfc822Id = msgResponse.data.payload.headers.find(
        (h) => h.name.toLowerCase() === "message-id",
      )?.value;
      if (rfc822Id) {
        resolvedInReplyTo = rfc822Id;
      }
    }
  }

  // Build raw MIME message
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (resolvedInReplyTo) {
    headers.push(`In-Reply-To: ${resolvedInReplyTo}`);
    headers.push(`References: ${resolvedInReplyTo}`);
  }

  const raw = toBase64Url(
    Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf-8"),
  );

  const message: Record<string, unknown> = { raw };
  if (threadId) message.threadId = threadId;

  const response = await gmailPost<{ id: string }>(
    "/drafts",
    { message },
    account,
  );

  if (!response.ok) {
    printError(`Failed to create draft: status ${response.status}`);
    return;
  }

  ok({ draftId: response.data.id, subject });
}

// ---------------------------------------------------------------------------
// send-draft
// ---------------------------------------------------------------------------

async function sendDraft(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: gmail-email.ts send-draft --draft-id <id>

Options:
  --draft-id      ID of the draft to send (required)
  --account       Gmail account to use
  --skip-confirm  Skip the interactive confirmation prompt`);
    return;
  }

  const draftId = requireArg(args, "draft-id");
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  // Fetch draft details for the confirmation prompt
  const draftResponse = await gmailGet<{
    message?: {
      payload?: {
        headers?: Array<{ name: string; value: string }>;
      };
    };
  }>(`/drafts/${draftId}`, undefined, account);

  if (!draftResponse.ok) {
    printError(`Failed to fetch draft details: status ${draftResponse.status}`);
    return;
  }

  const draftHeaders = draftResponse.data.message?.payload?.headers;
  const to = extractHeader(draftHeaders, "To") || "(unknown)";
  const subject = extractHeader(draftHeaders, "Subject") || "(no subject)";

  // Gate on user confirmation unless explicitly skipped
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Send email",
      message: `Send to ${to}\nSubject: ${subject}`,
      confirmLabel: "Send",
    });

    if (!confirmed) {
      ok({ sent: false, reason: "User did not confirm" });
      return;
    }
  }

  const response = await gmailPost<{ id: string }>(
    "/drafts/send",
    { id: draftId },
    account,
  );

  if (!response.ok) {
    printError(`Failed to send draft: status ${response.status}`);
    return;
  }

  ok({ sent: true, draftId });
}

// ---------------------------------------------------------------------------
// forward
// ---------------------------------------------------------------------------

async function forward(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: gmail-email.ts forward --message-id <id> --to <email>

Options:
  --message-id  ID of the message to forward (required)
  --to          Recipient email address (required)
  --text        Text to prepend to the forwarded message
  --account     Gmail account to use`);
    return;
  }

  const messageId = requireArg(args, "message-id");
  const forwardTo = requireArg(args, "to");
  const additionalText = optionalArg(args, "text");
  const account = optionalArg(args, "account");

  // Fetch original message
  const msgResponse = await gmailGet<{
    id: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      parts?: GmailMessagePart[];
      body?: { data?: string; attachmentId?: string; size?: number };
      mimeType?: string;
    };
  }>(`/messages/${messageId}`, { format: "full" }, account);

  if (!msgResponse.ok) {
    printError(`Failed to fetch message: status ${msgResponse.status}`);
    return;
  }

  const message = msgResponse.data;
  const headers = message.payload?.headers ?? [];
  const originalFrom = extractHeader(headers, "From");
  const originalDate = extractHeader(headers, "Date");
  const originalSubject = extractHeader(headers, "Subject");
  const originalBody = extractPlainTextBody(
    message.payload as GmailMessagePart | undefined,
  );

  const forwardHeader = [
    additionalText ? `${additionalText}\n\n` : "",
    "---------- Forwarded message ----------",
    `From: ${originalFrom}`,
    `Date: ${originalDate}`,
    `Subject: ${originalSubject}`,
    "",
    originalBody,
  ].join("\n");

  const subject = originalSubject.startsWith("Fwd:")
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  // Collect and download attachments from the original message
  const attachmentRefs = collectAttachmentRefs(message.payload?.parts);
  const attachments = await Promise.all(
    attachmentRefs.map(async (ref) => {
      const attResponse = await gmailGet<{ data: string }>(
        `/messages/${messageId}/attachments/${ref.attachmentId}`,
        undefined,
        account,
      );
      if (!attResponse.ok) {
        throw new Error(
          `Failed to fetch attachment ${ref.filename}: status ${attResponse.status}`,
        );
      }
      const data = Buffer.from(
        attResponse.data.data.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      );
      return { filename: ref.filename, mimeType: ref.mimeType, data };
    }),
  );

  // Build MIME with attachments
  const raw = buildMultipartMime({
    to: forwardTo,
    subject,
    body: forwardHeader,
    attachments,
  });

  const response = await gmailPost<{ id: string }>(
    "/drafts",
    { message: { raw } },
    account,
  );

  if (!response.ok) {
    printError(`Failed to create forward draft: status ${response.status}`);
    return;
  }

  ok({ draftId: response.data.id, attachmentCount: attachments.length });
}

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------

async function trash(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: gmail-email.ts trash --message-id <id>

Options:
  --message-id  ID of the message to trash (required)
  --account     Gmail account to use`);
    return;
  }

  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");

  const response = await gmailPost(
    `/messages/${messageId}/trash`,
    undefined,
    account,
  );

  if (!response.ok) {
    printError(`Failed to trash message: status ${response.status}`);
    return;
  }

  ok({ trashed: true, messageId });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "draft":
      await draft(process.argv.slice(3));
      break;
    case "send-draft":
      await sendDraft(process.argv.slice(3));
      break;
    case "forward":
      await forward(process.argv.slice(3));
      break;
    case "trash":
      await trash(process.argv.slice(3));
      break;
    default:
      printError(`Unknown subcommand: ${command}. Use --help for usage.`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
  });
}
