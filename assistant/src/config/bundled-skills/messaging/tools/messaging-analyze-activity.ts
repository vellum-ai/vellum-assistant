import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { classifyActivity } from '../../../../messaging/activity-analyzer.js';
import { resolveProvider, withProviderToken, ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const conversations = await provider.listConversations(token);
      const summary = classifyActivity(conversations, provider.id);
      return ok(JSON.stringify(summary, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
