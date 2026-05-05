import type { LLMCallSite } from "../config/schemas/llm.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";

/** Base fields present on every telemetry event. */
export interface TelemetryEventBase {
  type: string;
  daemon_event_id: string;
  recorded_at: number;
}

/** LLM usage event — one per provider API call. */
export interface LlmUsageTelemetryEvent extends TelemetryEventBase {
  type: "llm_usage";
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  actor: string;
  llm_call_site: LLMCallSite | null;
  inference_profile: string | null;
  inference_profile_source: UsageAttributionProfileSource | null;
  /** Computed estimated cost in USD for this LLM call. Null when pricing data is unavailable. */
  cost: number | null;
}

/** Turn event — one per user message. */
export interface TurnTelemetryEvent extends TelemetryEventBase {
  type: "turn";
}

/** Lifecycle event — app_open, hatch, etc. */
export interface LifecycleTelemetryEvent extends TelemetryEventBase {
  type: "lifecycle";
  event_name: string;
}

/** Discriminated union of all telemetry event types. */
export type TelemetryEvent =
  | LlmUsageTelemetryEvent
  | TurnTelemetryEvent
  | LifecycleTelemetryEvent;
