import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./types.js";

const log = getLogger("failover");

const DEFAULT_COOLDOWN_MS = 60_000;

interface ProviderHealth {
  unhealthySince: number | null;
}

/**
 * Determine whether an error should trigger failover to the next provider.
 * Connection errors, auth errors, and 5xx server errors trigger failover.
 * 4xx client errors do NOT trigger failover (except 429 rate limit).
 */
function isFailoverError(error: unknown): boolean {
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    // 429 rate limit — try next provider
    if (error.statusCode === 429) return true;
    // 5xx server errors — try next provider
    if (error.statusCode >= 500) return true;
    // Other 4xx — don't failover (bad request, auth with wrong format, etc.)
    return false;
  }

  // Network errors — try next provider
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE"
    ) {
      return true;
    }
    if (error.cause instanceof Error) {
      const causeCode = (error.cause as NodeJS.ErrnoException).code;
      if (
        causeCode === "ECONNRESET" ||
        causeCode === "ECONNREFUSED" ||
        causeCode === "ETIMEDOUT" ||
        causeCode === "EPIPE"
      ) {
        return true;
      }
    }
  }

  // ProviderError without a status code = connection/unknown failure
  if (error instanceof ProviderError && error.statusCode === undefined) {
    return true;
  }

  return false;
}

export interface ProviderHealthStatus {
  name: string;
  healthy: boolean;
  unhealthySince: string | null;
}

export class FailoverProvider implements Provider {
  public readonly name: string;
  private readonly healthMap = new Map<string, ProviderHealth>();

  constructor(
    private readonly providers: Provider[],
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {
    if (providers.length === 0) {
      throw new Error("FailoverProvider requires at least one provider");
    }
    this.name = providers[0].name;
    for (const p of providers) {
      this.healthMap.set(p.name, { unhealthySince: null });
    }
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let lastError: unknown;

    for (const provider of this.providers) {
      const health = this.healthMap.get(provider.name)!;
      const now = Date.now();

      // Skip providers that are still in cooldown
      if (health.unhealthySince != null) {
        const elapsed = now - health.unhealthySince;
        if (elapsed < this.cooldownMs) {
          log.debug(
            {
              provider: provider.name,
              cooldownRemainingMs: this.cooldownMs - elapsed,
            },
            "Skipping unhealthy provider (in cooldown)",
          );
          continue;
        }
        // Cooldown expired — give it another chance
        log.info(
          { provider: provider.name },
          "Provider cooldown expired, retrying",
        );
      }

      try {
        const response = await provider.sendMessage(
          messages,
          tools,
          systemPrompt,
          options,
        );
        // Success — mark healthy
        if (health.unhealthySince != null) {
          log.info(
            { provider: provider.name },
            "Provider recovered, marking healthy",
          );
          health.unhealthySince = null;
        }
        return {
          ...response,
          actualProvider: response.actualProvider ?? provider.name,
        };
      } catch (error) {
        lastError = error;

        if (isFailoverError(error)) {
          health.unhealthySince = Date.now();
          log.warn(
            {
              provider: provider.name,
              error: error instanceof Error ? error.message : String(error),
              statusCode:
                error instanceof ProviderError ? error.statusCode : undefined,
            },
            "Provider failed, marked unhealthy",
          );
          continue;
        }

        // Non-failover error (e.g. 400 bad request) — don't try other providers
        throw error;
      }
    }

    // All providers exhausted
    throw (
      lastError ??
      new ProviderError(
        "All configured providers are unavailable",
        this.name,
        undefined,
      )
    );
  }

  getHealthStatus(): ProviderHealthStatus[] {
    return this.providers.map((p) => {
      const health = this.healthMap.get(p.name)!;
      return {
        name: p.name,
        healthy: health.unhealthySince == null,
        unhealthySince:
          health.unhealthySince != null
            ? new Date(health.unhealthySince).toISOString()
            : null,
      };
    });
  }
}
