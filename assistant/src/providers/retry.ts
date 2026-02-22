import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition } from './types.js';
import { ProviderError } from '../util/errors.js';
import { getLogger, isDebug } from '../util/logger.js';
import {
  computeRetryDelay,
  isRetryableNetworkError,
  sleep,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
} from '../util/retry.js';

const log = getLogger('retry');

function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429 || error.statusCode >= 500) return true;
  }
  return isRetryableNetworkError(error);
}

export class RetryProvider implements Provider {
  public readonly name: string;

  constructor(private readonly inner: Provider) {
    this.name = inner.name;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    const debug = isDebug();

    if (debug) {
      log.debug({
        provider: this.name,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
      }, 'Provider sendMessage start');
    }

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const start = Date.now();
        const result = await this.inner.sendMessage(messages, tools, systemPrompt, options);
        if (debug) {
          log.debug({
            provider: this.name,
            durationMs: Date.now() - start,
            attempt: attempt + 1,
            model: result.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          }, 'Provider sendMessage success');
        }
        return result;
      } catch (error) {
        lastError = error;

        if (attempt < DEFAULT_MAX_RETRIES && isRetryableError(error)) {
          const delay = computeRetryDelay(attempt, DEFAULT_BASE_DELAY_MS);
          const errorType = error instanceof ProviderError && error.statusCode === 429
            ? 'rate_limit'
            : error instanceof ProviderError && error.statusCode !== undefined && error.statusCode >= 500
              ? `server_error_${error.statusCode}`
              : 'network_error';
          log.warn({ attempt: attempt + 1, maxRetries: DEFAULT_MAX_RETRIES, delay, errorType, provider: this.name }, 'Retrying after transient error');
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}
