import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { createDraft } from '../../../../messaging/providers/gmail/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;

  if (!to) return err('to is required.');
  if (!subject) return err('subject is required.');
  if (!body) return err('body is required.');

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      const draft = await createDraft(token, to, subject, body, inReplyTo);
      return ok(`Draft created (ID: ${draft.id}). It will appear in your Gmail Drafts.`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
