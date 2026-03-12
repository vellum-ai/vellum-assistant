import { getLogfireToken } from "./config/env.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./providers/types.js";
import { getLogger } from "./util/logger.js";
import { APP_VERSION } from "./version.js";

const log = getLogger("logfire");

type LogfireModule = typeof import("@pydantic/logfire-node");

const LOGFIRE_ENABLED: boolean = !!getLogfireToken();

let logfireInstance: LogfireModule | null = null;

/**
 * Initialize Logfire for LLM observability.
 * Dynamically imports @pydantic/logfire-node only when enabled.
 * Non-fatal on failure (logs warning and continues).
 */
export async function initLogfire(): Promise<void> {
  if (!LOGFIRE_ENABLED) return;

  try {
    const logfire = await import("@pydantic/logfire-node");
    logfire.configure({
      token: getLogfireToken(),
      serviceName: "vellum-assistant",
      serviceVersion: APP_VERSION,
    });
    logfireInstance = logfire;
    log.info("Logfire initialized");
  } catch (err) {
    log.warn(
      { err },
      "Failed to initialize Logfire — LLM observability disabled",
    );
  }
}

/**
 * Wraps a provider with Logfire tracing spans.
 * When LOGFIRE_ENABLED is false, returns the provider as-is (no wrapper allocated).
 */
export function wrapWithLogfire(provider: Provider): Provider {
  if (!LOGFIRE_ENABLED) return provider;
  return new LogfireProvider(provider);
}

/**
 * Wrapper provider that instruments each sendMessage call with a Logfire span.
 * When Logfire is not initialized, acts as a pure pass-through with zero overhead.
 */
class LogfireProvider implements Provider {
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
    if (!logfireInstance) {
      return this.inner.sendMessage(messages, tools, systemPrompt, options);
    }

    const start = Date.now();

    return logfireInstance.span(
      `llm.${this.name}`,
      {
        "llm.provider": this.name,
        "llm.message_count": messages.length,
        "llm.tool_count": tools?.length ?? 0,
      },
      {},
      async (span) => {
        try {
          const response = await this.inner.sendMessage(
            messages,
            tools,
            systemPrompt,
            options,
          );
          const durationMs = Date.now() - start;

          span.setAttributes({
            "llm.model": response.model,
            "llm.stop_reason": response.stopReason,
            "llm.usage.input_tokens": response.usage.inputTokens,
            "llm.usage.output_tokens": response.usage.outputTokens,
            "llm.usage.cache_creation_input_tokens":
              response.usage.cacheCreationInputTokens ?? 0,
            "llm.usage.cache_read_input_tokens":
              response.usage.cacheReadInputTokens ?? 0,
            "llm.duration_ms": durationMs,
            "llm.success": true,
          });

          return response;
        } catch (error) {
          const durationMs = Date.now() - start;
          span.setAttributes({
            "llm.duration_ms": durationMs,
            "llm.success": false,
            "llm.error.type":
              error instanceof Error ? error.constructor.name : "Unknown",
            "llm.error.message":
              error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );
  }
}
