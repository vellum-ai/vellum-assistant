import type { RateLimitConfig } from "../config/types.js";
import { RateLimitError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./types.js";

const log = getLogger("rate-limit");

export class RateLimitProvider implements Provider {
  public readonly name: string;

  private requestTimestamps: number[];
  private sessionTokens = 0;

  constructor(
    private readonly inner: Provider,
    private readonly config: RateLimitConfig,
    sharedRequestTimestamps?: number[],
  ) {
    this.name = inner.name;
    this.requestTimestamps = sharedRequestTimestamps ?? [];
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

    const response = await this.inner.sendMessage(
      messages,
      tools,
      systemPrompt,
      options,
    );

    this.recordTokens(response.usage.inputTokens + response.usage.outputTokens);

    return response;
  }

  private enforceRequestRate(): void {
    const limit = this.config.maxRequestsPerMinute;
    if (limit <= 0) return;

    const now = Date.now();
    const windowStart = now - 60_000;
    // Prune expired timestamps in-place to preserve the shared array
    // reference. Single-pass compaction: copy valid entries to the front,
    // track the oldest surviving entry, and truncate — all in O(n).
    let write = 0;
    let oldestInWindow = Infinity;
    for (let read = 0; read < this.requestTimestamps.length; read++) {
      if (this.requestTimestamps[read] > windowStart) {
        if (this.requestTimestamps[read] < oldestInWindow) {
          oldestInWindow = this.requestTimestamps[read];
        }
        this.requestTimestamps[write++] = this.requestTimestamps[read];
      }
    }
    this.requestTimestamps.length = write;

    if (this.requestTimestamps.length >= limit) {
      const waitSec = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
      log.warn(
        {
          provider: this.name,
          limit,
          currentCount: this.requestTimestamps.length,
          retryAfterSec: waitSec,
        },
        `Provider rate limit exceeded: ${limit} requests/minute for ${this.name}`,
      );
      throw new RateLimitError(
        `Rate limit exceeded: ${limit} requests/minute. Try again in ${waitSec}s.`,
      );
    }
  }

  private enforceTokenBudget(): void {
    const limit = this.config.maxTokensPerSession;
    if (limit <= 0) return;

    if (this.sessionTokens >= limit) {
      log.warn(
        {
          provider: this.name,
          sessionTokens: this.sessionTokens,
          limit,
        },
        `Session token budget exhausted for ${this.name}: ${this.sessionTokens.toLocaleString()}/${limit.toLocaleString()}`,
      );
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
    log.debug(
      {
        sessionTokens: this.sessionTokens,
        limit: this.config.maxTokensPerSession,
      },
      "Token usage updated",
    );
  }
}
