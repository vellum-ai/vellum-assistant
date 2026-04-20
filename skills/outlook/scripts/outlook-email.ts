#!/usr/bin/env bun

/**
 * Outlook email composition and sending operations.
 * Subcommands: draft, send-draft, forward, trash
 */

import {
  parseArgs,
  printError,
  ok,
  requireArg,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import {
  graphRequest,
  graphGet,
  graphPost,
  graphPatch,
} from "./lib/graph-client.js";

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

function getCommand(): string | undefined {
  return process.argv[2];
}

interface Recipient {
  emailAddress: { address: string };
}

function toRecipients(emails: string[]): Recipient[] {
  return emails.map((email) => ({
    emailAddress: { address: email.trim() },
  }));
}

function printUsage(): void {
  console.log(`Usage: outlook-email.ts <subcommand> [options]

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

interface DraftMessageResponse {
  id: string;
  subject?: string;
  webLink?: string;
}

async function draft(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-email.ts draft --to <emails> --subject <text> --body <html>

Options:
  --to          Comma-separated recipient emails (required)
  --subject     Email subject (required)
  --body        Email body as HTML (required)
  --cc          Comma-separated CC emails
  --bcc         Comma-separated BCC emails
  --in-reply-to Message ID to reply to
  --account     Outlook account to use`);
    return;
  }

  const to = requireArg(args, "to");
  const subject = requireArg(args, "subject");
  const body = requireArg(args, "body");
  const cc = optionalArg(args, "cc");
  const bcc = optionalArg(args, "bcc");
  const inReplyTo = optionalArg(args, "in-reply-to");
  const account = optionalArg(args, "account");

  const toRecipientsList = toRecipients(parseCsv(to));
  const ccRecipientsList = cc ? toRecipients(parseCsv(cc)) : undefined;
  const bccRecipientsList = bcc ? toRecipients(parseCsv(bcc)) : undefined;

  if (inReplyTo) {
    // Create a reply draft from an existing message
    const replyResponse = await graphPost<DraftMessageResponse>(
      `/v1.0/me/messages/${encodeURIComponent(inReplyTo)}/createReply`,
      { comment: body },
      account,
    );

    if (!replyResponse.ok) {
      printError(
        `Failed to create reply draft: status ${replyResponse.status}`,
      );
      return;
    }

    const draftId = replyResponse.data.id;

    // Patch the draft to update recipients (do NOT patch subject —
    // the Graph API auto-generates "Re: ..." and we should preserve it)
    const patchBody: Record<string, unknown> = {};
    patchBody.toRecipients = toRecipientsList;
    if (ccRecipientsList) patchBody.ccRecipients = ccRecipientsList;
    if (bccRecipientsList) patchBody.bccRecipients = bccRecipientsList;

    const patchResponse = await graphPatch<DraftMessageResponse>(
      `/v1.0/me/messages/${encodeURIComponent(draftId)}`,
      patchBody,
      account,
    );

    if (!patchResponse.ok) {
      printError(
        `Failed to update reply draft: status ${patchResponse.status}`,
      );
      return;
    }

    ok({
      draftId,
      subject: patchResponse.data.subject ?? subject,
      webLink: patchResponse.data.webLink,
    });
  } else {
    // Create a new draft message
    const messageBody: Record<string, unknown> = {
      subject,
      body: { contentType: "HTML", content: body },
      toRecipients: toRecipientsList,
      isDraft: true,
    };
    if (ccRecipientsList) messageBody.ccRecipients = ccRecipientsList;
    if (bccRecipientsList) messageBody.bccRecipients = bccRecipientsList;

    const response = await graphPost<DraftMessageResponse>(
      "/v1.0/me/messages",
      messageBody,
      account,
    );

    if (!response.ok) {
      printError(`Failed to create draft: status ${response.status}`);
      return;
    }

    ok({
      draftId: response.data.id,
      subject,
      webLink: response.data.webLink,
    });
  }
}

// ---------------------------------------------------------------------------
// send-draft
// ---------------------------------------------------------------------------

async function sendDraft(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-email.ts send-draft --draft-id <id>

Options:
  --draft-id    ID of the draft to send (required)
  --account     Outlook account to use
  --skip-confirm  Skip the interactive confirmation prompt`);
    return;
  }

  const draftId = requireArg(args, "draft-id");
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  // Fetch draft details for the confirmation prompt
  const draft = await graphGet<{
    subject?: string;
    toRecipients?: Array<{ emailAddress: { address: string } }>;
  }>(
    `/v1.0/me/messages/${encodeURIComponent(draftId)}`,
    { $select: "subject,toRecipients" },
    account,
  );

  if (!draft.ok) {
    printError(`Failed to fetch draft details: status ${draft.status}`);
    return;
  }

  const to =
    draft.data.toRecipients?.map((r) => r.emailAddress.address).join(", ") ??
    "(unknown)";
  const subject = draft.data.subject ?? "(no subject)";

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

  const response = await graphRequest({
    method: "POST",
    path: `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
    account,
  });

  if (!response.ok) {
    printError(`Failed to send draft: status ${response.status}`);
    return;
  }

  ok({ sent: true, draftId });
}

// ---------------------------------------------------------------------------
// forward
// ---------------------------------------------------------------------------

interface ForwardResponse {
  id: string;
}

async function forward(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-email.ts forward --message-id <id> --to <emails>

Options:
  --message-id  ID of the message to forward (required)
  --to          Comma-separated recipient emails (required)
  --comment     Optional comment to include
  --account     Outlook account to use`);
    return;
  }

  const messageId = requireArg(args, "message-id");
  const to = requireArg(args, "to");
  const comment = optionalArg(args, "comment");
  const account = optionalArg(args, "account");

  const recipients = toRecipients(parseCsv(to));

  // Create a forward draft with recipients included
  const forwardBody: Record<string, unknown> = {
    toRecipients: recipients,
  };
  if (comment) forwardBody.comment = comment;

  const response = await graphPost<ForwardResponse>(
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/createForward`,
    forwardBody,
    account,
  );

  if (!response.ok) {
    printError(`Failed to create forward draft: status ${response.status}`);
    return;
  }

  const draftId = response.data.id;

  ok({ draftId });
}

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------

async function trash(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-email.ts trash --message-id <id>

Options:
  --message-id  ID of the message to trash (required)
  --account     Outlook account to use`);
    return;
  }

  const messageId = requireArg(args, "message-id");
  const account = optionalArg(args, "account");

  const response = await graphPost(
    `/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
    { destinationId: "deleteditems" },
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
  const command = getCommand();

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
