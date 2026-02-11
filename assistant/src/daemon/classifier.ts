import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('classifier');

export type InteractionType = 'computer_use' | 'text_qa';

/**
 * Classify a user task as computer_use or text_qa using a Haiku tool-use call,
 * falling back to a heuristic if the API call fails or no API key is available.
 */
export async function classifyInteraction(task: string): Promise<InteractionType> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.warn('No API key available, falling back to heuristic classification');
    return classifyHeuristic(task);
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 128,
        system: 'You are a classifier. Determine whether the user\'s request requires computer use (controlling the mouse/keyboard/apps) or is a text Q&A (answerable with text only).',
        tools: [{
          name: 'classify_interaction',
          description: 'Classify the user interaction type',
          input_schema: {
            type: 'object' as const,
            properties: {
              interaction_type: {
                type: 'string',
                enum: ['computer_use', 'text_qa'],
                description: 'The type of interaction',
              },
              reasoning: {
                type: 'string',
                description: 'Brief reasoning for the classification',
              },
            },
            required: ['interaction_type', 'reasoning'],
          },
        }],
        tool_choice: { type: 'tool' as const, name: 'classify_interaction' },
        messages: [{ role: 'user' as const, content: task }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Classification timeout')), 5000),
      ),
    ]);

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolBlock && toolBlock.type === 'tool_use') {
      const input = toolBlock.input as { interaction_type?: string; reasoning?: string };
      const result = input.interaction_type === 'text_qa' ? 'text_qa' : 'computer_use';
      log.info({ result, reasoning: input.reasoning }, 'Haiku classification');
      return result;
    }

    log.warn('No tool_use block in classification response, falling back to heuristic');
    return classifyHeuristic(task);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Haiku classification failed, falling back to heuristic');
    return classifyHeuristic(task);
  }
}

/**
 * Heuristic classifier — direct port of the Swift client's logic.
 * Used as fallback when the Haiku API call is unavailable or fails.
 */
export function classifyHeuristic(task: string): InteractionType {
  const lower = task.toLowerCase().trim();

  if (lower.includes('?')) return 'text_qa';

  const qaStarters = [
    'what', 'when', 'where', 'how', 'why', 'who', 'which',
    'is it', 'is there', 'is this', 'are there', 'are these',
    'can you tell', 'can you explain', 'can you describe',
    'tell me', 'explain', 'describe', 'summarize', 'list',
  ];
  for (const starter of qaStarters) {
    if (lower.startsWith(starter)) return 'text_qa';
  }

  const cuStarters = [
    'open', 'click', 'type', 'navigate', 'switch', 'drag', 'scroll',
    'close', 'send', 'fill', 'submit', 'go to', 'move', 'select',
    'copy', 'paste', 'delete', 'create', 'write', 'edit', 'save',
    'download', 'upload', 'install', 'run', 'launch', 'start',
    'stop', 'press', 'tap', 'find', 'search', 'show me',
  ];
  for (const starter of cuStarters) {
    if (lower.startsWith(starter)) return 'computer_use';
  }

  return 'computer_use';
}
