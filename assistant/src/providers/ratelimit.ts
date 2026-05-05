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
  // Delegate name dynamically so that wrapper providers (e.g.
  // CallSiteRoutingProvider) whose name getter reflects per-call async context
  // (AsyncLocalStorage) are reached correctly during streaming — rather than
  // returning a stale snapshot captured at construction time.
  get name(): string {
    return this.inner.name;
  }

  get tokenEstimationProvider(): string | undefined {
    return this.inner.tokenEstimationProvider;
  }

  private requestTimestamps: number[];

  constructor(
    private readonly inner: Provider,
    private readonly config: RateLimitConfig,
    sharedRequestTimestamps?: number[],
  ) {
    this.requestTimestamps = sharedRequestTimestamps ?? [];
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    this.enforceRequestRate();

    // Record the request timestamp before the await to prevent concurrent
    // calls from bypassing the rate limit during the async gap.
    this.recordRequest();

    const response = await this.inner.sendMessage(
      messages,
      tools,
      systemPrompt,
      options,
    );

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

  private recordRequest(): void {
    if (this.config.maxRequestsPerMinute <= 0) return;
    this.requestTimestamps.push(Date.now());
  }
}
