import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition } from './types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('retry');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    // Check cause for API status codes (e.g. Anthropic.APIError)
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'status' in cause) {
      const status = (cause as { status: number }).status;
      if (status === 429 || status >= 500) return true;
    }
  }

  // Check for network errors
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE') {
      return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const causeCode = (cause as NodeJS.ErrnoException).code;
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
