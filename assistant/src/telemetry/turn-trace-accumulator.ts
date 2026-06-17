/**
 * Per-turn execution-trace accumulator.
 *
 * Subscribes (observation-only) to the {@link AgentEvent} stream of a single
 * agent turn and assembles a {@link TraceTelemetryEvent["trace"]} body —
 * prompts/completions, tool calls/results, and token usage. On the turn's
 * terminal `agent_loop_exit` it buffers one trace row via
 * {@link recordTraceEvent}, which is consent-gated and DARK by default.
 *
 * This never changes agent behavior: callers feed each event here *in addition
 * to* the real dispatch, and every method swallows its own errors so a trace
 * failure can never surface to the turn.
 *
 * Secrets (OAuth/API tokens, `Authorization` headers, credential material) are
 * scrubbed via {@link redactSensitiveFields} before anything is buffered.
 * Ordinary conversation/PII content is preserved — that is the consented
 * debugging/eval value.
 */

import type { AgentEvent } from "../agent/loop.js";
import { recordTraceEvent } from "../memory/trace-events-store.js";
import { redactSensitiveFields } from "../security/redaction.js";
import type {
  TraceLlmCall,
  TraceTelemetryEvent,
  TraceToolCall,
} from "../telemetry/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("turn-trace");

/** Recursively scrub secrets from an arbitrary value (object/array/scalar). */
function scrubValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object") {
    return redactSensitiveFields(value as Record<string, unknown>);
  }
  return value;
}

/** Scrub secrets from a list of content blocks, preserving their shape. */
function scrubContentBlocks(content: ReadonlyArray<unknown>): unknown[] {
  return content.map(scrubValue);
}

export class TurnTraceAccumulator {
  private readonly conversationId: string;
  private readonly requestId: string | null;
  private readonly startedAt = Date.now();

  private readonly llmCalls: TraceLlmCall[] = [];
  private readonly toolCalls: TraceToolCall[] = [];
  /** tool_use_id → index into `toolCalls`, for attaching results. */
  private readonly toolCallIndexById = new Map<string, number>();
  private persisted = false;

  constructor(conversationId: string, requestId: string | null) {
    this.conversationId = conversationId;
    this.requestId = requestId;
  }

  /** The currently-open LLM call (the last one started), or null. */
  private currentCall(): TraceLlmCall | null {
    return this.llmCalls.length > 0
      ? this.llmCalls[this.llmCalls.length - 1]
      : null;
  }

  /**
   * Feed one agent-loop event into the accumulator. Observation-only and
   * fully self-isolating: any error is logged and swallowed so trace
   * assembly can never affect the turn.
   */
  observe(event: AgentEvent): void {
    try {
      switch (event.type) {
        case "llm_call_started":
          this.llmCalls.push({
            index: this.llmCalls.length,
            call_site: event.callSite ?? null,
            model: null,
            provider: null,
            completion: null,
            usage: null,
          });
          break;
        case "message_complete": {
          const call = this.currentCall();
          if (call) {
            call.completion = {
              role: event.message.role,
              content: scrubContentBlocks(event.message.content),
            };
          }
          break;
        }
        case "usage": {
          const call = this.currentCall();
          if (call) {
            call.model = event.model;
            call.provider = event.actualProvider ?? null;
            call.usage = {
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
              cache_creation_input_tokens:
                event.cacheCreationInputTokens ?? null,
              cache_read_input_tokens: event.cacheReadInputTokens ?? null,
            };
          }
          break;
        }
        case "tool_use": {
          this.toolCallIndexById.set(event.id, this.toolCalls.length);
          this.toolCalls.push({
            tool_use_id: event.id,
            tool_name: event.name,
            input: redactSensitiveFields(event.input),
            result: null,
            is_error: null,
          });
          break;
        }
        case "tool_result": {
          const idx = this.toolCallIndexById.get(event.toolUseId);
          if (idx !== undefined) {
            const tool = this.toolCalls[idx];
            // `content` is the model-facing string result; scrub any
            // token-shaped material a tool may have echoed into it.
            const scrubbed = scrubValue(event.content);
            tool.result =
              typeof scrubbed === "string"
                ? scrubbed
                : JSON.stringify(scrubbed);
            tool.is_error = event.isError;
          }
          break;
        }
        case "agent_loop_exit":
          this.finalize(event.reason);
          break;
        default:
          break;
      }
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId, requestId: this.requestId },
        "Turn trace accumulation error — non-fatal, trace may be incomplete",
      );
    }
  }

  /**
   * Build the trace body and buffer one row. Idempotent — a turn emits a
   * single terminal `agent_loop_exit`, but the guard defends against a
   * double-finalize if a caller re-enters. No-op when the turn produced no
   * observable activity (defensive; a real turn always has at least one call).
   */
  private finalize(exitReason: string): void {
    if (this.persisted) return;
    this.persisted = true;
    if (this.llmCalls.length === 0 && this.toolCalls.length === 0) return;
    const trace: TraceTelemetryEvent["trace"] = {
      exit_reason: exitReason,
      started_at: this.startedAt,
      ended_at: Date.now(),
      llm_calls: this.llmCalls,
      tool_calls: this.toolCalls,
    };
    try {
      recordTraceEvent({
        conversationId: this.conversationId,
        requestId: this.requestId,
        trace,
      });
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId, requestId: this.requestId },
        "Failed to buffer turn trace — non-fatal",
      );
    }
  }
}
