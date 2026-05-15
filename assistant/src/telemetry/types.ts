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
  /**
   * Parent conversation id. Null for LLM calls not tied to a conversation
   * (memory consolidation, background embedding work, etc.).
   */
  conversation_id: string | null;
  /**
   * Type of the parent conversation (`"standard"` / `"background"` /
   * `"scheduled"`). Null when `conversation_id` is null. Daemons predating
   * this field send no value; downstream consumers treat missing/null as
   * `"standard"` to preserve back-compat during rollout.
   */
  conversation_type: string | null;
  /**
   * 1-indexed position of the user turn this LLM call belongs to within
   * the parent conversation, counting only real user turns (tool-result
   * rows persisted with role="user" are excluded — same filter as the
   * `turn` event stream). Computed as the count of user messages with
   * `created_at <= this_event.created_at`. Null when the LLM call isn't
   * tied to a conversation, or when no user turn has occurred yet.
   */
  turn_index: number | null;
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
  /**
   * Parent conversation id. Lets analytics group turns by conversation
   * (e.g. avg turns per conversation, time-to-first-completion).
   */
  conversation_id: string;
  /**
   * Type of the parent conversation. Lets analytics distinguish
   * user-initiated turns (`"standard"`) from system-generated prompts
   * in `"background"` / `"scheduled"` conversations. Daemons predating
   * this field send no value; downstream consumers should treat a
   * missing value as `"standard"` to preserve DAU during rollout.
   */
  conversation_type: string;
  /**
   * 1-indexed position of this user turn within the parent conversation,
   * counting only real user turns (tool-result rows persisted with
   * role="user" are excluded — same filter as the turn-event eligibility
   * predicate). The first user turn in a conversation is `1`.
   */
  turn_index: number;
}

/** Lifecycle event — app_open, hatch, etc. */
export interface LifecycleTelemetryEvent extends TelemetryEventBase {
  type: "lifecycle";
  event_name: string;
}

/** Onboarding event — pre-chat selections and Google connect status. */
export interface OnboardingTelemetryEvent extends TelemetryEventBase {
  type: "onboarding";
  screen: string;
  tools?: string[];
  tasks?: string[];
  tone?: string;
  google_connected?: boolean;
  google_scopes?: string[];
  ab_variant?: string;
}

/** Discriminated union of all telemetry event types. */
export type TelemetryEvent =
  | LlmUsageTelemetryEvent
  | TurnTelemetryEvent
  | LifecycleTelemetryEvent
  | OnboardingTelemetryEvent;
