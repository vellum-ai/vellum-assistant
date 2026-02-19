import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { createWatcher } from '../../watcher/watcher-store.js';
import { getWatcherProvider, listWatcherProviders } from '../../watcher/provider-registry.js';

class WatcherCreateTool implements Tool {
  name = 'watcher_create';
  description = 'Create a new watcher that polls an external service for events and processes them with an action prompt';
  category = 'watcher';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A human-readable name for this watcher (e.g. "My Gmail")',
          },
          provider: {
            type: 'string',
            description: 'The provider to poll (e.g. "gmail")',
          },
          action_prompt: {
            type: 'string',
            description: 'Instructions for the LLM on how to handle detected events. This prompt is sent along with event data to a background conversation.',
          },
          poll_interval_ms: {
            type: 'number',
            description: 'How often to poll in milliseconds. Defaults to 60000 (1 minute). Minimum 15000.',
          },
          credential_service: {
            type: 'string',
            description: 'Override the credential service to use. Defaults to the provider\'s required service.',
          },
          config: {
            type: 'object',
            description: 'Provider-specific configuration (e.g. filter criteria)',
          },
        },
        required: ['name', 'provider', 'action_prompt'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeWatcherCreate(input, _context);
  }
}

export async function executeWatcherCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name as string;
  const providerId = input.provider as string;
  const actionPrompt = input.action_prompt as string;
  const pollIntervalMs = (input.poll_interval_ms as number) ?? undefined;
  const config = input.config as Record<string, unknown> | undefined;

  if (!name || typeof name !== 'string') {
    return { content: 'Error: name is required and must be a string', isError: true };
  }
  if (!providerId || typeof providerId !== 'string') {
    return { content: 'Error: provider is required and must be a string', isError: true };
  }
  if (!actionPrompt || typeof actionPrompt !== 'string') {
    return { content: 'Error: action_prompt is required and must be a string', isError: true };
  }

  const provider = getWatcherProvider(providerId);
  if (!provider) {
    const available = listWatcherProviders().map((p) => p.id).join(', ') || 'none';
    return { content: `Error: Unknown provider "${providerId}". Available: ${available}`, isError: true };
  }

  if (pollIntervalMs !== undefined && pollIntervalMs < 15000) {
    return { content: 'Error: poll_interval_ms must be at least 15000 (15 seconds)', isError: true };
  }

  const credentialService = (input.credential_service as string) ?? provider.requiredCredentialService;

  try {
    const watcher = createWatcher({
      name,
      providerId,
      actionPrompt,
      credentialService,
      pollIntervalMs,
      configJson: config ? JSON.stringify(config) : null,
    });

    const intervalSec = Math.round(watcher.pollIntervalMs / 1000);
    return {
      content: [
        'Watcher created successfully.',
        `  Name: ${watcher.name}`,
        `  Provider: ${provider.displayName}`,
        `  Poll interval: ${intervalSec}s`,
        `  Credential: ${watcher.credentialService}`,
        `  Status: ${watcher.status}`,
        `  ID: ${watcher.id}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating watcher: ${msg}`, isError: true };
  }
}

registerTool(new WatcherCreateTool());
