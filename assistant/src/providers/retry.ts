import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition } from './types.js';
import { ProviderError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('retry');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryableError(error: unknown): boolean {
  // Check ProviderError.statusCode for retryable HTTP status codes
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429 || error.statusCode >= 500) return true;
  }

  // Check for network errors (direct or wrapped in cause chain)
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE') {
      return true;
    }

    if (error.cause instanceof Error) {
      const causeCode = (error.cause as NodeJS.ErrnoException).code;
      if (causeCode === 'ECONNRESET' || causeCode === 'ECONNREFUSED' || causeCode === 'ETIMEDOUT' || causeCode === 'EPIPE') {
        return true;
      }
    }
  }

  return false;
}

function getRetryDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS;
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.inner.sendMessage(messages, tools, systemPrompt, options);
      } catch (error) {
        lastError = error;

        if (attempt < MAX_RETRIES && isRetryableError(error)) {
          const delay = getRetryDelay(attempt);
          log.warn({ attempt: attempt + 1, delay }, 'Retrying after transient error');
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}
