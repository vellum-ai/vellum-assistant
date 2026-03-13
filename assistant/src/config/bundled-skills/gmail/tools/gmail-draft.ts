import { createDraft } from "../../../../messaging/providers/gmail/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;
  const cc = input.cc as string | undefined;
  const bcc = input.bcc as string | undefined;

  if (!to) return err("to is required.");
  if (!subject) return err("subject is required.");
  if (!body) return err("body is required.");

  try {
    const connection = resolveOAuthConnection("integration:gmail", account);
    const draft = await createDraft(
      connection,
      to,
      subject,
      body,
      inReplyTo,
      cc,
      bcc,
    );
    return ok(
      `Draft created (ID: ${draft.id}). It will appear in your Gmail Drafts.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
