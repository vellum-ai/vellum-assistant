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
}

/** Turn event — one per user message. */
export interface TurnTelemetryEvent extends TelemetryEventBase {
  type: "turn";
}

/** Discriminated union of all telemetry event types. */
export type TelemetryEvent = LlmUsageTelemetryEvent | TurnTelemetryEvent;
