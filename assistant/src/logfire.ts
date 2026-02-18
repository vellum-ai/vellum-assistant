import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition, ContentBlock } from './providers/types.js';
import type { AnyValueMap } from '@opentelemetry/api-logs';
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
    .map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }));
}

// gen_ai event names (same constants used by @opentelemetry/instrumentation-openai)
const EVENT_GEN_AI_SYSTEM_MESSAGE = 'gen_ai.system.message';
const EVENT_GEN_AI_USER_MESSAGE = 'gen_ai.user.message';
const EVENT_GEN_AI_ASSISTANT_MESSAGE = 'gen_ai.assistant.message';
const EVENT_GEN_AI_TOOL_MESSAGE = 'gen_ai.tool.message';
const EVENT_GEN_AI_CHOICE = 'gen_ai.choice';

/**
 * Wrapper provider that instruments each sendMessage call with OTEL spans
 * and log events, matching the exact pattern used by
 * @opentelemetry/instrumentation-openai so Logfire renders the rich
 * chat conversation view.
 *
 * The key insight: Logfire's AI observability UI recognizes OTEL *log events*
 * (not child spans) with event.name matching gen_ai.* patterns. The OpenAI
 * auto-instrumentation emits these via Logger.emit(); we do the same here
 * for non-OpenAI providers (Anthropic, Gemini, etc.).
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

    // Dynamically import OTEL APIs (available as transitive deps of logfire)
    const { trace, context, SpanKind } = await import('@opentelemetry/api');
    const { logs, SeverityNumber } = await import('@opentelemetry/api-logs');

    const tracer = trace.getTracer('vellum-assistant');
    const logger = logs.getLogger('vellum-assistant');

    const operationName = 'chat';
    const model = this.name;

    // Create parent span matching the gen_ai semantic conventions
    const span = tracer.startSpan(`${operationName} ${model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': operationName,
        'gen_ai.request.model': model,
        'gen_ai.system': this.name,
      },
    });

    const ctx = trace.setSpan(context.active(), span);
    const timestamp = Date.now();

    // Emit input messages as OTEL log events (same pattern as OpenAI instrumentation)
    if (systemPrompt) {
      logger.emit({
        timestamp,
        context: ctx,
        severityNumber: SeverityNumber.INFO,
        attributes: { 'event.name': EVENT_GEN_AI_SYSTEM_MESSAGE, 'gen_ai.system': this.name },
        body: { content: systemPrompt },
      });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            if (tr.type === 'tool_result') {
              logger.emit({
                timestamp,
                context: ctx,
                severityNumber: SeverityNumber.INFO,
                attributes: { 'event.name': EVENT_GEN_AI_TOOL_MESSAGE, 'gen_ai.system': this.name },
                body: { id: tr.tool_use_id, content: tr.content },
              });
            }
          }
        } else {
          const text = extractTextContent(msg.content);
          if (text) {
            logger.emit({
              timestamp,
              context: ctx,
              severityNumber: SeverityNumber.INFO,
              attributes: { 'event.name': EVENT_GEN_AI_USER_MESSAGE, 'gen_ai.system': this.name },
              body: { content: text },
            });
          }
        }
      } else if (msg.role === 'assistant') {
        const text = extractTextContent(msg.content);
        const toolCalls = extractToolCalls(msg.content);
        const body: AnyValueMap = {};
        if (text) body.content = text;
        if (toolCalls.length > 0) body.tool_calls = toolCalls as unknown as AnyValueMap;
        logger.emit({
          timestamp,
          context: ctx,
          severityNumber: SeverityNumber.INFO,
          attributes: { 'event.name': EVENT_GEN_AI_ASSISTANT_MESSAGE, 'gen_ai.system': this.name },
          body,
        });
      }
    }

    // Execute the actual LLM call within the span context
    try {
      const response = await context.with(ctx, () =>
        this.inner.sendMessage(messages, tools, systemPrompt, options),
      );

      // Set response attributes on the span
      span.setAttribute('gen_ai.response.model', response.model);
      span.setAttribute('gen_ai.response.finish_reasons', [response.stopReason]);
      span.setAttribute('gen_ai.usage.input_tokens', response.usage.inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', response.usage.outputTokens);

      // Emit response as a gen_ai.choice log event
      const responseText = extractTextContent(response.content);
      const responseToolCalls = extractToolCalls(response.content);
      const message: AnyValueMap = {};
      if (responseText) message.content = responseText;
      if (responseToolCalls.length > 0) message.tool_calls = responseToolCalls as unknown as AnyValueMap;
      const choiceBody: AnyValueMap = {
        finish_reason: response.stopReason,
        index: 0,
        message,
      };

      logger.emit({
        timestamp: Date.now(),
        context: ctx,
        severityNumber: SeverityNumber.INFO,
        attributes: { 'event.name': EVENT_GEN_AI_CHOICE, 'gen_ai.system': this.name },
        body: choiceBody,
      });

      span.end();
      return response;
    } catch (error) {
      span.setAttribute('error.type', error instanceof Error ? error.constructor.name : 'Unknown');
      span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: error instanceof Error ? error.message : String(error) });
      span.end();
      throw error;
    }
  }
}
