import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition, ContentBlock } from './providers/types.js';
import { APP_VERSION } from './version.js';
import { getLogger } from './util/logger.js';

const log = getLogger('logfire');

type LogfireModule = typeof import('@pydantic/logfire-node');

/** Check at call time (after dotenv has loaded) whether logfire should be active. */
export function isLogfireEnabled(): boolean {
  return (
    !!process.env.LOGFIRE_TOKEN &&
    process.env.VELLUM_ENABLE_MONITORING === '1'
  );
}

let logfireInstance: LogfireModule | null = null;

/**
 * Initialize Logfire for LLM observability.
 * Dynamically imports @pydantic/logfire-node only when enabled.
 * Non-fatal on failure (logs warning and continues).
 */
export async function initLogfire(): Promise<void> {
  if (!isLogfireEnabled()) return;

  try {
    const logfire = await import('@pydantic/logfire-node');
    logfire.configure({
      token: process.env.LOGFIRE_TOKEN,
      serviceName: 'vellum-assistant',
      serviceVersion: APP_VERSION,
      nodeAutoInstrumentations: {
        '@opentelemetry/instrumentation-runtime-node': { enabled: false },
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-openai': { captureMessageContent: true },
      },
    });
    logfireInstance = logfire;
    log.info('Logfire initialized');
  } catch (err) {
    log.warn({ err }, 'Failed to initialize Logfire — LLM observability disabled');
  }
}

/**
 * Wraps a provider with Logfire tracing spans.
 * When logfire is not initialized, returns the provider as-is (no wrapper allocated).
 * OpenAI is skipped because it has OTEL auto-instrumentation.
 */
export function wrapWithLogfire(provider: Provider): Provider {
  if (!logfireInstance) return provider;
  if (provider.name === 'openai') return provider;
  return new LogfireProvider(provider);
}

// --- helpers ---

function extractTextContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function extractToolCalls(blocks: ContentBlock[]) {
  return blocks
    .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }));
}

/**
 * Wrapper provider that instruments each sendMessage call with Logfire spans.
 * Uses logfire.span() and logfire.info() — the same pattern as the Python SDK.
 * No raw OTEL API usage; logfire handles the plumbing.
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

    const lf = logfireInstance;

    return lf.span(`chat ${this.name}`, {
      'gen_ai.system': this.name,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': this.name,
      'llm.tool_count': tools?.length ?? 0,
      'llm.message_count': messages.length,
    }, {}, async (span) => {
      const start = Date.now();

      // Log input messages as child spans
      if (systemPrompt) {
        lf.info('gen_ai.system.message', {
          'gen_ai.system': this.name,
          content: systemPrompt,
        }, { parentSpan: span });
      }

      for (const msg of messages) {
        if (msg.role === 'user') {
          const toolResults = msg.content.filter(b => b.type === 'tool_result');
          if (toolResults.length > 0) {
            for (const tr of toolResults) {
              if (tr.type === 'tool_result') {
                lf.info('gen_ai.tool.message', {
                  'gen_ai.system': this.name,
                  tool_use_id: tr.tool_use_id,
                  content: tr.content,
                }, { parentSpan: span });
              }
            }
          } else {
            const text = extractTextContent(msg.content);
            if (text) {
              lf.info('gen_ai.user.message', {
                'gen_ai.system': this.name,
                content: text,
              }, { parentSpan: span });
            }
          }
        } else if (msg.role === 'assistant') {
          const text = extractTextContent(msg.content);
          const toolCalls = extractToolCalls(msg.content);
          const attrs: Record<string, unknown> = { 'gen_ai.system': this.name };
          if (text) attrs.content = text;
          if (toolCalls.length > 0) attrs.tool_calls = toolCalls;
          lf.info('gen_ai.assistant.message', attrs, { parentSpan: span });
        }
      }

      try {
        const response = await this.inner.sendMessage(messages, tools, systemPrompt, options);
        const durationMs = Date.now() - start;

        span.setAttributes({
          'gen_ai.response.model': response.model,
          'gen_ai.response.finish_reasons': [response.stopReason],
          'gen_ai.usage.input_tokens': response.usage.inputTokens,
          'gen_ai.usage.output_tokens': response.usage.outputTokens,
          'llm.usage.cache_creation_input_tokens': response.usage.cacheCreationInputTokens ?? 0,
          'llm.usage.cache_read_input_tokens': response.usage.cacheReadInputTokens ?? 0,
          'llm.duration_ms': durationMs,
        });

        // Log response
        const responseText = extractTextContent(response.content);
        const responseToolCalls = extractToolCalls(response.content);
        const choiceAttrs: Record<string, unknown> = {
          'gen_ai.system': this.name,
          finish_reason: response.stopReason,
        };
        if (responseText) choiceAttrs.content = responseText;
        if (responseToolCalls.length > 0) choiceAttrs.tool_calls = responseToolCalls;
        lf.info('gen_ai.choice', choiceAttrs, { parentSpan: span });

        return response;
      } catch (error) {
        span.setAttributes({
          'llm.duration_ms': Date.now() - start,
          'error.type': error instanceof Error ? error.constructor.name : 'Unknown',
          'error.message': error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
}
