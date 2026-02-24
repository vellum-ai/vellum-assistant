import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { resolveProvider, withProviderToken, ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const threadId = input.thread_id as string;
  const text = input.text as string;

  if (!conversationId) {
    return err('conversation_id is required.');
  }
  if (!threadId) {
    return err('thread_id is required.');
  }
  if (!text) {
    return err('text is required.');
  }

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const result = await provider.sendMessage(token, conversationId, text, {
        threadId,
        assistantId: context.assistantId,
      });

      return ok(`Reply sent (ID: ${result.id}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
