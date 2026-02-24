import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { resolveProvider, withProviderToken, ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const text = input.text as string;
  const subject = input.subject as string | undefined;
  const inReplyTo = input.in_reply_to as string | undefined;

  if (!conversationId) {
    return err('conversation_id is required.');
  }
  if (!text) {
    return err('text is required.');
  }

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const result = await provider.sendMessage(token, conversationId, text, {
        subject,
        inReplyTo,
        assistantId: context.assistantId,
      });

      if (provider.id === 'sms') {
        return ok(`SMS accepted by Twilio (ID: ${result.id}). Note: "accepted" means Twilio received it for delivery — it has not yet been confirmed as delivered to the handset.`);
      }
      return ok(`Message sent (ID: ${result.id}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
