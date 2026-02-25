import type { Message, ModelIntent,Provider } from '../providers/types.js';
import type { SwarmTaskResult } from './types.js';

/**
 * Synthesize a final answer from all worker results using an LLM.
 * Falls back to a deterministic markdown summary if the LLM call fails.
 */
export async function synthesizeResults(opts: {
  objective: string;
  results: SwarmTaskResult[];
  provider: Provider;
  modelIntent?: ModelIntent;
}): Promise<string> {
  const { objective, results, provider, modelIntent } = opts;

  // Cap individual summaries and total input to avoid blowing up context on large plans
  const MAX_SUMMARY_CHARS = 500;
  const MAX_TOTAL_CHARS = 12_000;

  let taskSummaries = results.map((r) => {
    const status = r.status === 'completed' ? 'completed' : 'FAILED';
    const summary = r.summary.length > MAX_SUMMARY_CHARS
      ? r.summary.slice(0, MAX_SUMMARY_CHARS) + '...'
      : r.summary;
    return `[${r.taskId}] (${status}): ${summary}`;
  }).join('\n');

  if (taskSummaries.length > MAX_TOTAL_CHARS) {
    taskSummaries = taskSummaries.slice(0, MAX_TOTAL_CHARS) + '\n... (truncated)';
  }

  const systemPrompt = 'You are a synthesis assistant. Combine the outputs from multiple specialist workers into a coherent, concise final answer. Focus on the user\'s original objective.';

  const userMessage = `Original objective: ${objective}

Worker results:
${taskSummaries}

Synthesize these results into a clear, complete answer for the user.`;

  try {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: userMessage }] },
    ];

    const response = await provider.sendMessage(
      messages,
      undefined,
      systemPrompt,
      { config: { max_tokens: 4096, modelIntent } },
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      return textBlock.text;
    }

    return buildFallbackSynthesis(objective, results);
  } catch {
    return buildFallbackSynthesis(objective, results);
  }
}

function buildFallbackSynthesis(objective: string, results: SwarmTaskResult[]): string {
  const lines: string[] = [`## Results: ${objective}`, ''];

  for (const r of results) {
    const icon = r.status === 'completed' ? 'OK' : 'FAIL';
    lines.push(`- [${icon}] **${r.taskId}**: ${r.summary}`);
  }

  return lines.join('\n');
}
