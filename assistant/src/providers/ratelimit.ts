import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition } from './types.js';
import type { RateLimitConfig } from '../config/types.js';
import { RateLimitError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('rate-limit');

export class RateLimitProvider implements Provider {
  public readonly name: string;

  private requestTimestamps: number[] = [];
  private sessionTokens = 0;

  constructor(
    private readonly inner: Provider,
    private readonly config: RateLimitConfig,
  ) {
    this.name = inner.name;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    this.enforceRequestRate();
    this.enforceTokenBudget();

    // Record the request timestamp before the await to prevent concurrent
    // calls from bypassing the rate limit during the async gap.
    this.recordRequest();

    const response = await this.inner.sendMessage(messages, tools, systemPrompt, options);

    this.recordTokens(response.usage.inputTokens + response.usage.outputTokens);

    return response;
  }

  private enforceRequestRate(): void {
    const limit = this.config.maxRequestsPerMinute;
    if (limit <= 0) return;

    const now = Date.now();
    const windowStart = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > windowStart);

    if (this.requestTimestamps.length >= limit) {
      const oldestInWindow = this.requestTimestamps[0];
      const waitSec = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
      throw new RateLimitError(
        `Rate limit exceeded: ${limit} requests/minute. Try again in ${waitSec}s.`,
      );
    }
  }

  private enforceTokenBudget(): void {
    const limit = this.config.maxTokensPerSession;
    if (limit <= 0) return;

    if (this.sessionTokens >= limit) {
      throw new RateLimitError(
        `Session token budget exhausted: ${this.sessionTokens.toLocaleString()}/${limit.toLocaleString()} tokens used. Start a new session to continue.`,
      );
    }
  }

  private recordRequest(): void {
    if (this.config.maxRequestsPerMinute <= 0) return;
    this.requestTimestamps.push(Date.now());
  }

  private recordTokens(tokens: number): void {
    if (this.config.maxTokensPerSession <= 0) return;
    this.sessionTokens += tokens;
    log.debug({ sessionTokens: this.sessionTokens, limit: this.config.maxTokensPerSession }, 'Token usage updated');
  }
}
