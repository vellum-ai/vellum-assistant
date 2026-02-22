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
        senderConversationId: context.conversationId,
      });

      if (result.conflict) {
        return err(JSON.stringify({
          error: 'conflict',
          ownerConversationId: result.conflict.ownerConversationId,
          message: "Another thread owns this chat. Use 'Continue in Synced Thread' or 'Move Sync Here'.",
        }));
      }

      return ok(`Message sent (ID: ${result.id}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
