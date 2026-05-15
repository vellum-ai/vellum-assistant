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

/**
 * Optional client metadata bag carried on `TurnTelemetryEvent.client`.
 * Sourced from `messages.metadata.client`, which is populated by HTTP
 * header middleware reading `x-vellum-browser-family`,
 * `x-vellum-browser-version`, `x-vellum-client-os`,
 * `x-vellum-interface-version`. Extensible without a schema change —
 * lives entirely in the JSON metadata column.
 */
export interface TurnTelemetryClientInfo {
  /** Browser family for `web`/`chrome-extension` interfaces: `"chrome"|"safari"|"firefox"|"edge"`. */
  browser_family?: string;
  /** Major browser version only (`"124"`, not the full UA string). */
  browser_version?: string;
  /**
   * User's operating system at message time. For `web`/`chrome-extension`
   * this comes from `navigator.userAgentData`; for `macos`/`ios` it's
   * implicit from the interface, but clients may still send it explicitly.
   */
  os?: string;
  /**
   * Version of the surface app/client (`"0.8.2"` for the macOS app,
   * web client SHA, etc.) — distinct from `assistant_version` on the
   * batch envelope, which identifies the daemon. A user can be on an
   * older surface than the daemon (or vice versa, on web).
   */
  interface_version?: string;
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
  /**
   * Canonical `InterfaceId` enum value identifying the UI surface the
   * user was interacting from when this turn was created (`"macos"`,
   * `"ios"`, `"cli"`, `"web"`, `"chrome-extension"`, `"slack"`,
   * `"telegram"`, `"whatsapp"`, `"email"`, `"phone"`). Sourced from the
   * `userMessageInterface` field already stamped on `messages.metadata`
   * by every `persistUserMessage` path that flows through
   * `TurnChannelContext`.
   *
   * Null when the metadata didn't carry the field — historical rows or
   * system-initiated turns with no inbound client context. Downstream
   * consumers should treat null as `"unknown"`.
   */
  interface_id: string | null;
  /**
   * Canonical `ChannelId` enum value identifying the messaging fabric the
   * user message arrived on (`"vellum"` for in-app from macos/ios/web/
   * cli/chrome-extension; `"slack"`/`"telegram"`/`"whatsapp"`/`"email"`/
   * `"phone"` for channel-based interfaces). The 7th `ChannelId` value
   * (`"platform"`) is APNs-push outbound-only and should never appear
   * here.
   */
  channel_id: string | null;
  /**
   * Optional client-side metadata bag. Null when no client headers were
   * attached to the request that created the user message (most
   * channel-inbound paths today, and any path the new HTTP header
   * middleware hasn't been wired to yet).
   */
  client: TurnTelemetryClientInfo | null;
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
