import type { ToolContext, ToolExecutionResult } from '../types.js';
import { createWatcher } from '../../watcher/watcher-store.js';
import { getWatcherProvider, listWatcherProviders } from '../../watcher/provider-registry.js';

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
