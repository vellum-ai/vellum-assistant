import { randomUUID } from "node:crypto";

import {
  resolveCallSiteConfig,
  selectWinningProfile,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  resolveUsageAttribution,
  sanitizeUsageMetadataValue,
} from "../usage/attribution.js";
import { resolveSubagentAttribution } from "../usage/subagent-attribution.js";
import {
  type ProviderCredentialSource,
  ProviderError,
  type ProviderErrorReason,
} from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableNetworkError,
  sleep,
} from "../util/retry.js";
import {
  isAnthropicDelegatingGateway,
  isAnthropicModel,
} from "./anthropic-gateway-shared.js";
import {
  type BreakerObservation,
  type BreakerRoute,
  recordFallbackServed,
  recordPrimaryFailure,
  recordPrimarySuccess,
  releaseRecoveryProbe,
  shouldSkipPrimary,
  tryAcquireRecoveryProbe,
} from "./fallback-breaker.js";
import { resolveLogitBiasPreset } from "./inference/logit-bias.js";
import {
  isAdaptiveThinkingOnlyModel,
  isAdaptiveThinkingUnsupportedModel,
} from "./model-catalog.js";
import { buildOpenCodeRequestHeaders } from "./opencode/client.js";
import { dispatchProviderResolvable } from "./provider-resolvability.js";
import {
  isThinkingConfigAdaptive,
  isThinkingConfigDisabled,
  normalizeThinkingConfigForWire,
} from "./thinking-config.js";
import {
  isContextOverflowError,
  type Message,
  NATIVE_WEB_SEARCH_TOOL_NAME,
  type Provider,
  type ProviderResponse,
  type SendMessageOptions,
  type ToolDefinition,
} from "./types.js";
import { UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE } from "./unparseable-tool-args.js";

const log = getLogger("retry");

const USAGE_ATTRIBUTION_HEADER_NAMES = {
  callSite: "X-Vellum-LLM-Call-Site",
  inferenceProfile: "X-Vellum-Inference-Profile",
  inferenceProfileSource: "X-Vellum-Inference-Profile-Source",
  resolvedProvider: "X-Vellum-Resolved-Provider",
  resolvedModel: "X-Vellum-Resolved-Model",
  resolvedMixArm: "X-Vellum-Resolved-Mix-Arm",
  // Delegated-work attribution. Every subagent variety shares
  // `llm_call_site = "subagentSpawn"`, so on the authoritative billing path
  // these two orthogonal dimensions are the only way to tell an advisor
  // consult from a fork from a regular spawn.
  subagentRole: "X-Vellum-Subagent-Role",
  subagentSpawnMode: "X-Vellum-Subagent-Spawn-Mode",
} as const;

/** Providers whose transports consume `promptCacheKey` (OpenAI Responses
 *  `prompt_cache_key`); `RetryProvider` derives it from `selectionSeed` for
 *  these only. */
const PROMPT_CACHE_KEY_PROVIDERS = new Set(["openai", "openrouter"]);

/** Providers that support the `effort` config (extended thinking / reasoning). */
const EFFORT_SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "fireworks",
  "together",
  "baseten",
  "poolside",
]);

// For these providers, disabling reasoning is encoded through the same effort
// knob their transports send on the wire. Non-"none" tiers can still vary by
// model and are handled by the provider client.
const DISABLED_THINKING_USES_EFFORT_PROVIDERS = new Set([
  "openai",
  "fireworks",
  "together",
  "openrouter",
  "vercel-ai-gateway",
  "baseten",
  "poolside",
]);

// Whether a disabled `thinking` config must be encoded as `effort: "none"`
// for this provider/model. Gateway calls that delegate `anthropic/*` models
// to the Anthropic Messages API are excluded: the delegate honors a disabled
// `thinking` natively and `effort` keeps its Anthropic meaning there, so
// forcing it would diverge from the direct `anthropic` provider.
function disabledThinkingForcesEffortNone(
  providerName: string,
  model: unknown,
): boolean {
  if (!DISABLED_THINKING_USES_EFFORT_PROVIDERS.has(providerName)) {
    return false;
  }
  return !(
    isAnthropicDelegatingGateway(providerName) &&
    typeof model === "string" &&
    isAnthropicModel(model)
  );
}

/**
 * Providers that consume the `thinking` config. Anthropic uses it directly on
 * the wire; OpenRouter forwards it on its Anthropic delegate path and
 * translates it into `reasoning` for OpenAI-compat calls; the Vercel AI
 * Gateway consumes it only on its `anthropic/*` delegate path (no wire effect
 * for its other models); Gemini reads `thinking.level` to populate
 * `thinkingConfig.thinkingLevel`.
 */
const THINKING_AWARE_PROVIDERS = new Set([
  "anthropic",
  "openrouter",
  "vercel-ai-gateway",
  "gemini",
]);

/**
 * Providers that consume Gemini-only thinking extras (`level`,
 * `streamThinking`). For other thinking-aware providers, we scrub these from
 * the normalized wire payload because Anthropic's SDK rejects unknown keys
 * inside the `thinking` object with "Extra inputs are not permitted".
 */
const THINKING_EXTRA_FIELDS_AWARE_PROVIDERS = new Set(["gemini"]);

/**
 * Providers that consume the `verbosity` config. Currently OpenAI (mapped to
 * `text.verbosity` on the Responses API — a GPT-5-series parameter).
 */
const VERBOSITY_SUPPORTED_PROVIDERS = new Set(["openai"]);

/** Patterns that indicate a transient streaming corruption from the SDK. */
const RETRYABLE_STREAM_PATTERNS = [
  "Unexpected event order",
  "stream ended without producing",
  "request ended without sending any chunks",
  "stream has ended, this shouldn't happen",
  // The SDK's stream accumulator throws this when the model emits tool-call
  // arguments that don't parse as JSON (e.g. an unquoted string value). The
  // Anthropic client salvages most of these into a `_raw`-wrapped tool call
  // before they surface (see anthropic/stream-content-shadow.ts); ones that
  // still reach here retry with a corrective note
  // (`withUnparseableToolArgsHint`) because the malformation can be
  // conditioned on the request context — a byte-identical resend can
  // reproduce it indefinitely.
  UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE,
];

/**
 * One-shot note appended to the retried request after a tool-argument JSON
 * parse failure. Appended as a trailing text block on the latest user
 * message: the request tail sits after every prompt-cache anchor, so the
 * hint costs no cache reuse (a system-prompt edit would invalidate the whole
 * cached prefix).
 */
const UNPARSEABLE_TOOL_ARGS_RETRY_HINT =
  "[assistant runtime] The previous attempt at this response was discarded: " +
  "a tool call's arguments were not valid JSON (typically an unquoted string " +
  "value). Respond again, emitting tool-call arguments as strict JSON — " +
  "every string value double-quoted, including values that begin with '[' " +
  "or '{'.";

function isUnparseableToolArgsError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  if (error.statusCode !== undefined) {
    return false;
  }
  return error.message.includes(UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE);
}

/**
 * Copy of `messages` with the corrective note appended to the latest user
 * message. When the request doesn't end on a user message (assistant
 * prefill), returns `messages` unchanged — appending anything there would
 * change prefill semantics.
 */
function withUnparseableToolArgsHint(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "user") {
    return messages;
  }
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [
        ...last.content,
        { type: "text", text: UNPARSEABLE_TOOL_ARGS_RETRY_HINT },
      ],
    },
  ];
}

/**
 * Patterns that indicate a transient provider error even when no HTTP status
 * code is available (e.g. overloaded errors delivered as SSE events mid-stream
 * where the initial HTTP response was 200).
 */
const RETRYABLE_PROVIDER_MESSAGE_PATTERNS = [/overloaded/i];

/**
 * Patterns that indicate the Anthropic provider SDK reported a transport-level
 * abort (TCP close mid-stream, edge LB idle cutoff, Bun fetch deadline) rather
 * than a caller-initiated cancellation or inner-timeout deadline. The SDK
 * surfaces all three cases as ``Request was aborted`` with ``error.status ===
 * undefined``; the catch-site in ``providers/anthropic/client.ts`` separates
 * them by:
 *   - tagging caller cancellations with ``abortReason`` (short-circuits in
 *     {@link isRetryableError} before reaching this predicate)
 *   - rewriting the inner-timeout message to ``"Anthropic stream timed out
 *     after Xs (inner streamTimeoutMs)"`` (doesn't start with ``Anthropic API
 *     error:`` so it falls through to network-error classification)
 *   - leaving the transport-abort message verbatim as
 *     ``"Anthropic API error: Request was aborted."``
 *
 * Pattern is intentionally anchored to the Anthropic-specific message prefix.
 * The OpenAI / Gemini / OpenRouter catch-sites format their errors as
 * ``"<Provider> API error (undefined): Request was aborted."`` (note the
 * ``(undefined)`` parenthetical) and — crucially — do **not** rewrite
 * inner-timeout failures, so a provider-agnostic ``/request was aborted/i``
 * predicate would erroneously retry their 30-minute deadline failures three
 * additional times. Once those catch-sites grow the same
 * ``innerTimeoutFired`` distinction the Anthropic one has, the pattern set
 * here can be expanded to cover them too.
 *
 * This is the daemon-side counterpart to the vembda graceful-close behavior
 * for upstream disconnects (LUM-1536) — together they collapse the 45 s
 * silent-stall window the web client used to observe whenever Anthropic's
 * stream was cut mid-token.
 */
const RETRYABLE_TRANSPORT_ABORT_PATTERNS = [
  /^anthropic api error:\s*request was aborted/i,
];

/** Semantic provider-error reasons that are safe to retry. */
const RETRYABLE_PROVIDER_ERROR_REASONS = new Set<ProviderErrorReason>([
  "rate_limited",
  "overloaded",
  "server_error",
  // Transport failures that never reached the server (SDK connection
  // errors, Gemini proxy interception). Deadline and cancellation shapes
  // never carry this reason — they surface as reason-less aborts and
  // short-circuit in isRetryableError before the reason check — so a
  // 30-minute stream deadline failure is never retried through it.
  "network_error",
]);

function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  if (error.statusCode !== undefined) {
    return false;
  } // has a real HTTP status — not a stream error
  return RETRYABLE_STREAM_PATTERNS.some((p) => error.message.includes(p));
}

function isRetryableProviderMessage(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  if (error.statusCode !== undefined) {
    return false;
  } // has a real HTTP status — handled by status check
  return RETRYABLE_PROVIDER_MESSAGE_PATTERNS.some((p) => p.test(error.message));
}

function isRetryableTransportAbort(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  // Transport aborts surface with ``status === undefined`` (the SDK never
  // saw an HTTP response). A real HTTP status here means a server error,
  // which is handled by the status check.
  if (error.statusCode !== undefined) {
    return false;
  }
  return RETRYABLE_TRANSPORT_ABORT_PATTERNS.some((p) => p.test(error.message));
}

/**
 * A daemon or user cancellation. The provider catch-sites tag these with
 * `abortReason` exactly when `signal.aborted` was true at the time of failure,
 * which is what separates them from transport-level aborts: both surface as
 * "Request was aborted" from the SDK, and only the tag says who stopped it.
 */
function isCallerAbort(error: unknown): boolean {
  return error instanceof ProviderError && error.abortReason !== undefined;
}

function isRetryableError(error: unknown): boolean {
  // Context overflow is deterministic — retrying the same oversized prompt
  // will never succeed. Short-circuit before the generic 429/5xx check so
  // ContextOverflowError (which extends ProviderError and may carry a 429
  // statusCode on Gemini/Vertex) never triggers exponential backoff.
  if (isContextOverflowError(error)) {
    return false;
  }
  // Daemon/user-initiated aborts are never retryable. This short-circuits
  // before any message-based pattern matches, which matters because
  // transport-level aborts (retryable) and caller-cancels both surface as
  // "Request was aborted" from the SDK.
  if (isCallerAbort(error)) {
    return false;
  }
  // Prefer the provider-stamped semantic reason: a known reason decides
  // retryability outright, superseding the status/regex fallback below. Only
  // `unknown` (and a reason-less error) falls through.
  if (
    error instanceof ProviderError &&
    error.reason &&
    error.reason !== "unknown"
  ) {
    return RETRYABLE_PROVIDER_ERROR_REASONS.has(error.reason);
  }
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429 || error.statusCode >= 500) {
      return true;
    }
  }
  if (isRetryableProviderMessage(error)) {
    return true;
  }
  if (isRetryableStreamError(error)) {
    return true;
  }
  if (isRetryableTransportAbort(error)) {
    return true;
  }
  return isRetryableNetworkError(error);
}

/** Cap server-suggested delays at 60s. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * How long to wait before the next attempt, and whether the upstream named the
 * wait itself. A server-provided `Retry-After` wins over exponential backoff,
 * capped so a pathological header cannot stall a turn.
 */
function retryPlan(
  error: unknown,
  attempt: number,
): { delay: number; retryAfterHeader: boolean } {
  const retryAfter =
    error instanceof ProviderError ? error.retryAfterMs : undefined;
  return {
    delay: Math.min(
      retryAfter ?? computeRetryDelay(attempt, DEFAULT_BASE_DELAY_MS),
      MAX_RETRY_DELAY_MS,
    ),
    retryAfterHeader: retryAfter !== undefined,
  };
}

/** Structured `errorType` for the "Retrying after transient error" logs. */
function retryErrorType(error: unknown): string {
  if (error instanceof ProviderError && error.statusCode === 429) {
    return "rate_limit";
  }
  if (
    error instanceof ProviderError &&
    error.statusCode !== undefined &&
    error.statusCode >= 500
  ) {
    return `server_error_${error.statusCode}`;
  }
  if (isRetryableProviderMessage(error)) {
    return "provider_overloaded";
  }
  if (isRetryableStreamError(error)) {
    return "stream_corruption";
  }
  if (isRetryableTransportAbort(error)) {
    return "transport_abort";
  }
  return "network_error";
}

/**
 * The managed proxy's preflight guard rejects a model with no billing rate
 * card using a 400 whose body carries this phrase (django
 * `app/runtime_proxy/views.py`). It marks a model rename/retirement incident
 * (a route problem, not a request problem), so it is fallback-eligible even
 * though 400s are otherwise final.
 */
const MANAGED_PROXY_UNSUPPORTED_MODEL_PATTERN =
  /is not yet supported on the Vellum hosted service/;

/**
 * Whether the failure indicts one model rather than the upstream serving it: a
 * provider-classified `model_not_found`, a 404 with no definitive
 * classification, or the managed proxy's preflight 400 for a renamed/retired
 * model. As in `isRetryableError`, a provider-stamped semantic reason takes
 * precedence over the status fallback: a 404 whose classifier assigned a
 * definitive non-model reason (Anthropic, for example, stamps `bad_request` on
 * a 404 without a model signal) marks a deterministic request/routing failure
 * that a different model route would not fix. Only an absent or `unknown`
 * reason falls through to the raw 404 check. `model_restricted` is a
 * credential/policy denial, not a missing model, so it is deliberately absent.
 */
function isModelSpecificError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  if (error.reason === "model_not_found") {
    return true;
  }
  if (
    error.statusCode === 404 &&
    (error.reason === undefined || error.reason === "unknown")
  ) {
    return true;
  }
  return (
    error.statusCode === 400 &&
    MANAGED_PROXY_UNSUPPORTED_MODEL_PATTERN.test(error.message)
  );
}

/** Outage-shaped failures that justify switching to a backup profile. */
function isFallbackEligibleError(
  error: unknown,
  opts: {
    retriesExhausted: boolean;
    credentialSource?: ProviderCredentialSource;
  },
): boolean {
  // Deterministic request failures and caller-initiated aborts never justify
  // a different route (same short-circuits as `isRetryableError`): the same
  // oversized prompt overflows the backup too, and a cancelled request must
  // stay cancelled.
  if (isContextOverflowError(error)) {
    return false;
  }
  if (isCallerAbort(error)) {
    return false;
  }
  // (a) The retry loop burned its whole budget on a transient error
  // (429/5xx/overloaded/network/transport-abort): the primary route is down.
  if (opts.retriesExhausted && isRetryableError(error)) {
    return true;
  }
  if (!(error instanceof ProviderError)) {
    return false;
  }
  // (b) Invalid managed credential (the invalid-key incident). Applies only
  // to `vellum-managed` routes, where the platform owns the credential and a
  // broken key is a platform incident. A BYOK or OAuth-subscription route
  // with a broken personal credential must surface the auth error so the
  // user can fix it, not silently reroute to a differently billed backup.
  // Only reached after `sendMessage`'s credential-refresh path has already
  // been attempted for managed routes: same status/reason gate as
  // `shouldRefreshManagedCredential`.
  if (
    opts.credentialSource === "vellum-managed" &&
    (error.statusCode === 401 || error.statusCode === 403) &&
    (error.reason === undefined ||
      error.reason === "unknown" ||
      error.reason === "invalid_credentials")
  ) {
    return true;
  }
  // (c) The model is gone (a rename/retirement incident): a different model's
  // route is exactly what fixes it. See `isModelSpecificError` for which
  // shapes qualify and which deliberately do not.
  return isModelSpecificError(error);
}

/** Structured error class for the "Falling back to backup profile" log. */
function fallbackErrorType(error: unknown, retriesExhausted: boolean): string {
  if (retriesExhausted) {
    return "retries_exhausted";
  }
  if (error instanceof ProviderError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "invalid_credentials";
    }
    if (error.statusCode === 404 || error.statusCode === 400) {
      return "model_not_found";
    }
  }
  return "unknown";
}

/**
 * Whether a failed request can be re-routed to a backup profile. Fallback
 * re-resolves the ORIGINAL caller options with the backup profile forced,
 * which requires a `callSite`-bearing config. An explicit per-call
 * route pin (`model`, `provider`, or `provider_connection`) disqualifies the
 * request, whether it came from this call or the persisted call-site config.
 * Silently serving a different route would violate user intent: a profile
 * user asked for a tier, while a pinning user asked for an exact route. Pinned
 * calls keep retry-then-error behavior.
 */
const EXACT_ROUTE_PIN_KEYS = [
  "model",
  "provider",
  "provider_connection",
] as const;

function hasExactRoutePin(
  config: Record<string, unknown> | undefined,
): boolean {
  return EXACT_ROUTE_PIN_KEYS.some((key) => {
    const value = config?.[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function canReRouteToFallbackProfile(options?: SendMessageOptions): boolean {
  const config = options?.config;
  if (config?.callSite === undefined) {
    return false;
  }
  if (hasExactRoutePin(config)) {
    return false;
  }
  const callSiteConfig = getConfig().llm.callSites?.[config.callSite] as
    | Record<string, unknown>
    | undefined;
  return !hasExactRoutePin(callSiteConfig);
}

/**
 * The route a failure indicts, or null when it must not be remembered at all.
 * An outage marks the whole upstream; a retired or renamed model marks only
 * that model, because diverting every healthy profile on the upstream for one
 * model's 404 does more damage than the incident. A model-specific failure on
 * a request whose model cannot be named is not remembered either: naming the
 * upstream instead would be exactly that over-trip.
 */
function failureBreakerRoute(
  route: BreakerRoute,
  error: unknown,
): BreakerRoute | null {
  if (!isModelSpecificError(error)) {
    return { upstream: route.upstream };
  }
  return route.model === undefined ? null : route;
}

/**
 * Whether the request lands on Anthropic's Messages API wire: direct Anthropic
 * calls, plus OpenRouter / Vercel AI Gateway calls that delegate `anthropic/*`
 * models to it. Anthropic's thinking wire constraints (forced tool_choice,
 * temperature ≠ 1, top_p) apply exactly to these requests.
 */
function targetsAnthropicWire(providerName: string, model: string): boolean {
  if (providerName === "anthropic") {
    return true;
  }
  if (isAnthropicDelegatingGateway(providerName)) {
    return isAnthropicModel(model);
  }
  return false;
}

/**
 * Normalize per-call options before handing them to the wrapped provider.
 *
 * When `config.callSite` is set, resolves model/maxTokens/effort/speed/
 * verbosity/temperature/thinking via `resolveCallSiteConfig` and writes them
 * into `nextConfig` using the wire-format names that downstream provider
 * clients consume (`max_tokens` snake-case for the token cap; camelCase for
 * the rest, which matches the resolver's shape). Per-call explicit overrides
 * on the original `config` object win over the resolved values, so callers can
 * pin a model or other parameter for a single request. `contextWindow` and
 * `provider` are intentionally excluded from the written fields — they are
 * server-side routing/overflow concerns, not provider request parameters,
 * and forwarding them would leak unknown fields into provider request bodies
 * (strict-schema clients like Anthropic reject the request).
 *
 * Whether or not `callSite` is set, this function applies per-provider
 * stripping (`thinking`/`effort`/`speed`/`verbosity`) based on the wrapped
 * provider's name — agent-loop callers that pre-resolve provider/model still
 * need this stripping so they don't accidentally send Anthropic-only knobs to
 * OpenAI etc.
 */
function normalizeSendMessageOptions(
  providerName: string,
  options?: SendMessageOptions,
  normalizeOptions: { forwardUsageAttributionHeaders?: boolean } = {},
): SendMessageOptions | undefined {
  const config = options?.config;
  if (!config) {
    return options;
  }

  const nextConfig: Record<string, unknown> = { ...config };

  // Internal metadata must be derived here, not accepted from callers, and it
  // must never leak into provider JSON request bodies.
  delete nextConfig.usageAttributionHeaders;
  delete nextConfig.usageTracking;
  delete nextConfig.requestHeaders;

  // Preserve the per-conversation prompt-cache key before `selectionSeed` is
  // stripped below. Gated to providers whose Responses transport consumes it
  // as `prompt_cache_key` (direct OpenAI, and OpenRouter's `openai/*`
  // Responses delegate); creating it elsewhere would leak a non-wire field
  // through clients that spread config into request bodies. The Anthropic
  // client strips `promptCacheKey` from its wire config, which also covers
  // OpenRouter's `anthropic/*` delegation path. An explicit caller-set value
  // wins.
  if (
    PROMPT_CACHE_KEY_PROVIDERS.has(providerName) &&
    nextConfig.promptCacheKey === undefined &&
    typeof config.selectionSeed === "string" &&
    config.selectionSeed.length > 0
  ) {
    nextConfig.promptCacheKey = config.selectionSeed;
  }

  if (providerName === "opencode") {
    const conversationId =
      typeof config.conversationId === "string"
        ? config.conversationId
        : undefined;
    const requestHeaders = buildOpenCodeRequestHeaders({
      conversationId,
      requestId: randomUUID(),
    });
    if (Object.keys(requestHeaders).length > 0) {
      nextConfig.requestHeaders = requestHeaders;
    }
  }

  // `overrideProfile`, `forceOverrideProfile`, `selectionSeed`,
  // `conversationId`, and `nativeWebSearchSentinel` are routing/resolution-time
  // concerns (consumed by the resolver below, `CallSiteRoutingProvider`'s
  // provider selection, `UsageTrackingProvider`'s ledger attribution, and the
  // fallback tool filter); none is a wire-format field. Strip unconditionally
  // (after the `openai` promptCacheKey copy above) so they never leak into
  // provider request bodies even when callers set them without a `callSite`.
  delete nextConfig.overrideProfile;
  delete nextConfig.forceOverrideProfile;
  delete nextConfig.selectionSeed;
  delete nextConfig.conversationId;
  delete nextConfig.nativeWebSearchSentinel;

  if (config.callSite !== undefined) {
    const resolved = resolveCallSiteConfig(config.callSite, getConfig().llm, {
      overrideProfile: config.overrideProfile,
      forceOverrideProfile: config.forceOverrideProfile,
      selectionSeed: config.selectionSeed,
    });
    const attribution = resolveUsageAttribution({
      callSite: config.callSite,
      overrideProfile: config.overrideProfile,
      forceOverrideProfile: config.forceOverrideProfile,
      selectionSeed: config.selectionSeed,
    });

    const explicitModel =
      typeof config.model === "string" && config.model.trim().length > 0
        ? config.model.trim()
        : undefined;

    // Routing key is consumed by the resolver above and must not leak
    // downstream as a wire-format field.
    delete nextConfig.callSite;
    if (normalizeOptions.forwardUsageAttributionHeaders === true) {
      // Read from the conversation row rather than the live SubagentManager:
      // the row is durable and the lookup is a memoized primary-key read that
      // can never throw, so billing attribution cannot destabilize dispatch.
      const subagent = resolveSubagentAttribution(config.conversationId);
      const usageAttributionHeaders = buildUsageAttributionHeaders({
        callSite: attribution.callSite,
        appliedProfile: attribution.appliedProfile,
        profileSource: attribution.profileSource,
        resolvedProvider: attribution.resolvedProvider,
        resolvedModel: attribution.resolvedModel,
        resolvedMixArm: attribution.resolvedMixArm,
        subagentRole: subagent.subagentRole,
        subagentSpawnMode: subagent.subagentSpawnMode,
      });
      if (Object.keys(usageAttributionHeaders).length > 0) {
        nextConfig.usageAttributionHeaders = usageAttributionHeaders;
      }
    }

    // Apply resolved values, letting per-call explicit fields win where set.
    nextConfig.model = explicitModel ?? resolved.model;
    if (nextConfig.max_tokens === undefined) {
      nextConfig.max_tokens = resolved.maxTokens;
    }
    if (nextConfig.effort === undefined) {
      nextConfig.effort = resolved.effort;
    }
    if (nextConfig.speed === undefined) {
      nextConfig.speed = resolved.speed;
    }
    if (nextConfig.verbosity === undefined) {
      nextConfig.verbosity = resolved.verbosity;
    }
    // `temperature` defaults to `null` in the LLM schema (meaning "no opinion
    // — let the provider pick its own default"). Only forward when the
    // resolved value is an actual number; passing `temperature: null` to
    // provider clients would either be a wire error or silently override
    // sensible provider defaults. Mirrors the legacy non-callSite path which
    // never set `temperature` on `providerConfig`.
    if (
      nextConfig.temperature === undefined &&
      resolved.temperature !== null &&
      resolved.temperature !== undefined
    ) {
      nextConfig.temperature = resolved.temperature;
    }
    // `topP` (schema, camelCase) maps to the provider wire field `top_p`.
    // Defaults to `null` ("no opinion"); only forward an actual number so we
    // never send `top_p: null`, mirroring the `temperature` handling above.
    if (
      nextConfig.top_p === undefined &&
      resolved.topP !== null &&
      resolved.topP !== undefined
    ) {
      nextConfig.top_p = resolved.topP;
    }
    if (nextConfig.thinking === undefined && resolved.thinking !== undefined) {
      nextConfig.thinking = resolved.thinking;
    }
    // Not a wire field: consumed (and stripped) by provider clients that
    // implement prompt caching, like `cacheTtl` / `disableTurnStartCache`.
    if (
      nextConfig.disableCache === undefined &&
      resolved.disableCache !== undefined
    ) {
      nextConfig.disableCache = resolved.disableCache;
    }
    // Forward OpenRouter-only routing preferences so `OpenRouterProvider` can
    // translate `openrouter.only` into the wire-format `provider: { only: [...] }`
    // body field on both the OpenAI-compat and Anthropic-compat endpoints.
    if (
      providerName === "openrouter" &&
      nextConfig.openrouter === undefined &&
      Array.isArray(resolved.openrouter?.only) &&
      resolved.openrouter.only.length > 0
    ) {
      nextConfig.openrouter = { only: resolved.openrouter.only };
    }
    // Forward a profile's opted-in `logit_bias` preset only on the Fireworks
    // (OpenAI-compatible) path. `resolved.logitBias` is set by the resolver from
    // the single winning profile (not the deep-merge), so it can't leak from a
    // lower-precedence profile into one that didn't opt in.
    // `resolveLogitBiasPreset` additionally gates on the resolved model's
    // tokenizer. Strict-schema clients (Anthropic) reject unknown body fields,
    // hence the provider gate.
    if (
      providerName === "fireworks" &&
      nextConfig.logit_bias === undefined &&
      resolved.logitBias !== undefined &&
      typeof nextConfig.model === "string"
    ) {
      const biasMap = resolveLogitBiasPreset(
        resolved.logitBias,
        nextConfig.model,
      );
      if (biasMap !== undefined) {
        nextConfig.logit_bias = biasMap;
      }
    }
    // `contextWindow` and `provider` are server-side concerns, not provider
    // request parameters: effective context is resolved per call site/profile
    // by the agent/conversation path, while `provider` selection is handled by
    // `CallSiteRoutingProvider` upstream. Forwarding them as per-call config
    // leaks unknown fields into provider request bodies — Anthropic (and other
    // strict-schema clients) reject the request with
    // "Extra inputs are not permitted".
  }

  // Convert schema-shape `{ enabled, streamThinking }` into Anthropic's
  // discriminated wire-format (`{ type: "adaptive" | "disabled" }`).
  // `AnthropicProvider`'s SDK requires a `type` discriminator, and downstream
  // forced-tool/temperature conflict checks compare against the wire shape.
  // Applies to both the resolver path above and pass-through callers (e.g.
  // `host.providers.llm.complete`) that supply `thinking` directly without a
  // `callSite`.
  if (nextConfig.thinking !== undefined) {
    const normalized = normalizeThinkingConfigForWire(nextConfig.thinking);
    if (normalized === undefined) {
      delete nextConfig.thinking;
    } else {
      nextConfig.thinking = normalized;
    }
  }

  if (
    isThinkingConfigDisabled(nextConfig.thinking) &&
    disabledThinkingForcesEffortNone(providerName, nextConfig.model)
  ) {
    nextConfig.effort = "none";
  }

  // Claude Fable always reasons with adaptive thinking and rejects an explicit
  // `thinking: { type: "disabled" }` (Anthropic 400s the request). Drop a
  // disabled thinking config for these models so they fall back to their
  // always-on adaptive thinking; effort and other params are unaffected.
  if (
    typeof nextConfig.model === "string" &&
    isAdaptiveThinkingOnlyModel(nextConfig.model) &&
    isThinkingConfigDisabled(nextConfig.thinking)
  ) {
    delete nextConfig.thinking;
  }

  // Pre-adaptive Claude models (Haiku 4.5, Opus 4.5, Sonnet 4.5) reject
  // `thinking: { type: "adaptive" }` (Anthropic 400s the request), and Vellum
  // never sends the legacy budget_tokens form. Drop an adaptive thinking
  // config for these models so the request goes out without thinking instead
  // of failing. A pass-through `{ type: "enabled", budget_tokens }` config is
  // left intact: these models do support that shape.
  if (
    typeof nextConfig.model === "string" &&
    isAdaptiveThinkingUnsupportedModel(nextConfig.model) &&
    isThinkingConfigAdaptive(nextConfig.thinking) &&
    targetsAnthropicWire(providerName, nextConfig.model)
  ) {
    delete nextConfig.thinking;
  }

  // thinking is Anthropic-specific on the wire; OpenRouter reads it as a
  // signal for its unified reasoning parameter; Gemini reads `level` from it.
  // Strip it for other providers.
  if (
    !THINKING_AWARE_PROVIDERS.has(providerName) &&
    nextConfig.thinking !== undefined
  ) {
    delete nextConfig.thinking;
  }

  // Strip Gemini-only extras (`level`, `streamThinking`) from the wire
  // `thinking` object for providers that don't read them. Anthropic in
  // particular rejects unknown keys inside `thinking` with "Extra inputs are
  // not permitted"; the OpenRouter Anthropic-compat path hits the same SDK.
  if (
    nextConfig.thinking !== undefined &&
    !THINKING_EXTRA_FIELDS_AWARE_PROVIDERS.has(providerName) &&
    typeof nextConfig.thinking === "object" &&
    nextConfig.thinking !== null
  ) {
    const wire = nextConfig.thinking as Record<string, unknown>;
    if (wire.level !== undefined || wire.streamThinking !== undefined) {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(wire)) {
        if (key === "level" || key === "streamThinking") {
          continue;
        }
        scrubbed[key] = value;
      }
      nextConfig.thinking = scrubbed;
    }
  }

  // Anthropic (and the gateways fronting Anthropic) rejects requests that
  // combine extended thinking with forced tool use (`tool_choice.type` of
  // `"tool"` or `"any"`).  Strip thinking when both are present so the
  // request doesn't fail with a 400 "Thinking may not be enabled when
  // tool_choice forces tool use."  `tool_choice: { type: "auto" }` is
  // compatible with thinking and left untouched.
  //
  // For OpenRouter and the Vercel AI Gateway, only strip when routing to an
  // `anthropic/*` model — non-Anthropic reasoning models don't share this
  // wire constraint (e.g. OpenRouter translates `thinking` into its
  // `reasoning` parameter via `buildExtraCreateParams` and may support
  // reasoning with forced tool_choice).
  const isThinkingForcedToolConflict = (() => {
    if (nextConfig.thinking == null) {
      return false;
    }
    if (isThinkingConfigDisabled(nextConfig.thinking)) {
      return false;
    }
    const tc = nextConfig.tool_choice as Record<string, unknown> | undefined;
    if (tc == null || (tc.type !== "tool" && tc.type !== "any")) {
      return false;
    }
    const model = typeof nextConfig.model === "string" ? nextConfig.model : "";
    return targetsAnthropicWire(providerName, model);
  })();
  if (isThinkingForcedToolConflict) {
    delete nextConfig.thinking;
  }

  // Anthropic (and the gateways fronting Anthropic) rejects requests that
  // combine extended thinking with `temperature` ≠ 1. From the API:
  //   "`temperature` may only be set to 1 when thinking is enabled or in
  //   adaptive mode."
  //
  // Defense-in-depth: callers that hardcode a non-default temperature in
  // their per-call config are easy to miss when reviewing — we already had
  // this bug ship in three places (reply suggestions, recall agent
  // round, recall fallback finalize). Drop the offending temperature with
  // a warn log so the request goes through with Anthropic's default
  // (which is 1 in thinking mode anyway). We keep `thinking` rather than
  // `temperature` because thinking is the more deliberate, profile-level
  // choice — silently downgrading reasoning capacity for an unrelated
  // per-call hint would be the worse failure mode.
  //
  // Scope:
  // - Anthropic: always.
  // - OpenRouter / Vercel AI Gateway fronting `anthropic/*`: same wire
  //   constraint applies.
  // - Other providers: not our problem here (e.g. OpenAI reasoning models
  //   strip `temperature` upstream; non-Anthropic gateway reasoning
  //   models don't have this exact constraint).
  //
  // Anthropic applies the same constraint family to `top_p` (see the `top_p`
  // guard below), so the "thinking is enabled on the Anthropic wire" predicate
  // is shared between the two guards.
  const isThinkingEnabledOnAnthropicWire = (() => {
    const model = typeof nextConfig.model === "string" ? nextConfig.model : "";
    // Claude Fable always reasons in adaptive mode, so the constraint applies
    // even when no explicit `thinking` config is present (a disabled config was
    // already dropped above). For every other model the constraint only applies
    // when thinking is actually enabled.
    if (!isAdaptiveThinkingOnlyModel(model)) {
      if (nextConfig.thinking == null) {
        return false;
      }
      if (isThinkingConfigDisabled(nextConfig.thinking)) {
        return false;
      }
    }
    return targetsAnthropicWire(providerName, model);
  })();
  const isThinkingTemperatureConflict = (() => {
    if (!isThinkingEnabledOnAnthropicWire) {
      return false;
    }
    const temp = nextConfig.temperature;
    if (typeof temp !== "number") {
      return false;
    }
    // Unlike `top_p`, `temperature: 1` is explicitly accepted alongside
    // thinking, so it's the one value that doesn't conflict.
    return temp !== 1;
  })();
  if (isThinkingTemperatureConflict) {
    log.warn(
      {
        providerName,
        callSite: config.callSite,
        droppedTemperature: nextConfig.temperature,
      },
      "Dropping `temperature` because thinking is enabled — Anthropic only " +
        "accepts `temperature: 1` (or unset) when thinking/adaptive mode is " +
        "on. Set `thinking: { type: 'disabled' }` on the call site if you " +
        "need a specific temperature.",
    );
    delete nextConfig.temperature;
  }

  // Anthropic (and the gateways fronting Anthropic) also rejects requests that
  // combine extended thinking with *any* `top_p` modification. Unlike
  // `temperature` there is no "=== 1 is fine" exception — when thinking is
  // enabled the request must not set `top_p` at all. Drop it with a warn log
  // so the request goes through with Anthropic's default, keeping `thinking`
  // (the more deliberate, profile-level choice) for the same reasons as the
  // temperature guard above.
  if (isThinkingEnabledOnAnthropicWire && nextConfig.top_p !== undefined) {
    log.warn(
      {
        providerName,
        callSite: config.callSite,
        droppedTopP: nextConfig.top_p,
      },
      "Dropping `top_p` because thinking is enabled — Anthropic does not " +
        "accept `top_p` modifications when thinking/adaptive mode is on. Set " +
        "`thinking: { type: 'disabled' }` on the call site if you need a " +
        "specific top_p.",
    );
    delete nextConfig.top_p;
  }

  // effort is supported by Anthropic, OpenAI, and OpenAI-compatible providers; strip for others
  if (
    !EFFORT_SUPPORTED_PROVIDERS.has(providerName) &&
    nextConfig.effort !== undefined
  ) {
    delete nextConfig.effort;
  }

  // speed (fast mode) is Anthropic-specific; strip for other providers
  if (providerName !== "anthropic" && nextConfig.speed !== undefined) {
    delete nextConfig.speed;
  }

  // verbosity maps to OpenAI's `text.verbosity` (Responses API); strip for
  // providers that don't accept it to avoid leaking unknown fields on the wire.
  if (
    !VERBOSITY_SUPPORTED_PROVIDERS.has(providerName) &&
    nextConfig.verbosity !== undefined
  ) {
    delete nextConfig.verbosity;
  }

  // `openrouter.only` is OpenRouter-specific routing; strip for other
  // providers so strict-schema clients don't see an unknown field.
  if (providerName !== "openrouter" && nextConfig.openrouter !== undefined) {
    delete nextConfig.openrouter;
  }

  return {
    ...options,
    config: nextConfig,
  };
}

function buildUsageAttributionHeaders(input: {
  callSite: string | null;
  appliedProfile: string | null;
  profileSource: string;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedMixArm: string | null;
  subagentRole: string | null;
  subagentSpawnMode: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.callSite,
    input.callSite,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.inferenceProfile,
    input.appliedProfile,
  );
  if (input.appliedProfile) {
    addSanitizedHeader(
      headers,
      USAGE_ATTRIBUTION_HEADER_NAMES.inferenceProfileSource,
      input.profileSource,
    );
  }
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.resolvedProvider,
    input.resolvedProvider,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.resolvedModel,
    input.resolvedModel,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.resolvedMixArm,
    input.resolvedMixArm,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.subagentRole,
    input.subagentRole,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.subagentSpawnMode,
    input.subagentSpawnMode,
  );
  return headers;
}

function addSanitizedHeader(
  headers: Record<string, string>,
  name: string,
  value: unknown,
): void {
  const sanitized = sanitizeUsageMetadataValue(value);
  if (sanitized != null) {
    headers[name] = sanitized;
  }
}

/**
 * `RetryProvider` sets `retriesExhausted = true` on the final thrown error
 * when the retry loop burned through all attempts against a retryable error
 * (transient network, 5xx, provider-overloaded, mid-stream corruption).
 * Consumers can read it via `(err as { retriesExhausted?: boolean })` to
 * suppress Sentry captures for user-network-flap noise — the retry loop
 * already did its job, and no engineering action would change the outcome.
 */
export class RetryProvider implements Provider {
  public readonly name: string;

  private inner: Provider;

  get tokenEstimationProvider(): string | undefined {
    return this.inner.tokenEstimationProvider;
  }

  get supportsNativeWebSearch(): boolean | undefined {
    return this.inner.supportsNativeWebSearch;
  }

  supportsNativeWebSearchFor(options?: SendMessageOptions): boolean {
    return this.inner.supportsNativeWebSearchFor
      ? this.inner.supportsNativeWebSearchFor(options)
      : this.inner.supportsNativeWebSearch === true;
  }

  // Forward the optional token-counting endpoint so the capability survives
  // the wrapper chain (callers gate on its presence). Bound straight to the
  // inner provider — count_tokens is a cheap separate endpoint and its caller
  // already falls back on error, so it needs no retry wrapping.
  // Deliberately not re-bound when a credential refresh swaps `inner`: every
  // outer wrapper snapshots this the same way at construction, so a re-bind
  // here would never reach callers. count_tokens on the pre-refresh credential
  // fails soft — its caller falls back to estimation.
  public readonly countInputTokens?: NonNullable<Provider["countInputTokens"]>;

  constructor(
    inner: Provider,
    private readonly options: {
      forwardUsageAttributionHeaders?: boolean;
      credentialSource?: ProviderCredentialSource;
      connectionName?: string;
      refreshCredentialProvider?: () => Promise<Provider | null>;
      /**
       * Escalation hook: resolve a backup route (a ready adapter, the backup
       * profile key, and the backup route's usage-attribution forwarding
       * policy) for a request whose primary route failed with an
       * outage-shaped error (see {@link isFallbackEligibleError}). The
       * callback owns all profile knowledge: it inspects the failed call's
       * winning profile and returns null when that profile declares no
       * `fallbackProfile`, mirroring how `refreshCredentialProvider` keeps
       * this wrapper ignorant of credential storage.
       * `forwardUsageAttributionHeaders` must describe the BACKUP route, not
       * the primary: managed-proxy routes pass true, BYOK and other
       * third-party routes pass false. The fallback send normalizes with the
       * returned policy so `X-Vellum-*` billing metadata never leaks to a
       * third party and is never omitted from the managed proxy. One hop max:
       * the returned adapter must be RAW, so the backup can never escalate
       * again whatever happens to it. Whether the backup send gets a retry
       * budget depends on which entry point escalated; see
       * `sendOnFallbackRoute`.
       */
      resolveFallbackRoute?: (
        failedOptions: SendMessageOptions | undefined,
      ) => Promise<{
        provider: Provider;
        overrideProfile: string;
        forwardUsageAttributionHeaders: boolean;
      } | null>;
    } = {},
  ) {
    this.inner = inner;
    this.name = inner.name;
    if (inner.countInputTokens) {
      this.countInputTokens = inner.countInputTokens.bind(inner);
    }
  }

  private shouldRefreshManagedCredential(error: unknown): boolean {
    return (
      this.options.credentialSource === "vellum-managed" &&
      this.options.refreshCredentialProvider !== undefined &&
      error instanceof ProviderError &&
      (error.statusCode === 401 || error.statusCode === 403) &&
      (error.reason === undefined ||
        error.reason === "unknown" ||
        error.reason === "invalid_credentials")
    );
  }

  /**
   * Reload the managed credential after an auth rejection and swap the inner
   * provider for one built around it, so a key rotated out of band is picked
   * up without a restart. Returns true when a refreshed adapter took over and
   * the request is worth attempting again. Never throws: a failed reload
   * leaves the original error to surface.
   */
  private async refreshManagedCredential(): Promise<boolean> {
    try {
      const refreshed = await this.options.refreshCredentialProvider?.();
      if (refreshed) {
        this.inner = refreshed;
        log.info(
          {
            provider: this.name,
            connectionName: this.options.connectionName,
          },
          "Retrying managed inference with refreshed assistant credentials",
        );
        return true;
      }
    } catch (refreshError) {
      log.warn(
        {
          provider: this.name,
          connectionName: this.options.connectionName,
          refreshError,
        },
        "Failed to reload managed assistant credentials",
      );
    }
    return false;
  }

  private attributeCredential(error: unknown): void {
    const { credentialSource, connectionName } = this.options;
    if (
      !(error instanceof ProviderError) ||
      (!credentialSource && !connectionName)
    ) {
      return;
    }
    // Merges under whatever a closer layer already stamped, so a route
    // resolved at dispatch keeps precedence over this adapter's own view.
    error.attachRouteAttribution({
      ...(credentialSource ? { credentialSource } : {}),
      ...(connectionName ? { connectionName } : {}),
    });
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let retryAttempt = 0;
    let credentialRefreshAttempted = false;
    let correctiveResendAttempted = false;
    let fallbackAttempted = false;
    let messagesForAttempt = messages;

    const normalizedOptions = normalizeSendMessageOptions(this.name, options, {
      forwardUsageAttributionHeaders:
        this.options.forwardUsageAttributionHeaders === true,
    });

    // Only a request that can actually take the backup consults the circuit
    // breaker: it needs a wired escalation hook (BYOK, oauth-subscription, and
    // no-auth routes have none, so they keep today's behavior exactly) and it
    // must be re-routable. One gate for reads and writes alike, so a request
    // that bypasses the breaker can neither be skipped by it nor close a trip
    // that re-routable traffic still needs.
    //
    // The model comes from the resolved options, since a retired model is
    // remembered per model rather than per upstream.
    const breakerRoute: BreakerRoute | null =
      this.options.resolveFallbackRoute !== undefined &&
      canReRouteToFallbackProfile(options)
        ? {
            upstream: this.name,
            ...(typeof normalizedOptions?.config?.model === "string"
              ? { model: normalizedOptions.config.model }
              : {}),
          }
        : null;

    if (breakerRoute !== null) {
      if (shouldSkipPrimary(breakerRoute)) {
        // The primary is known to be down, so its retry budget would only add
        // latency to an answer the backup was always going to give.
        log.info(
          {
            provider: this.name,
            connectionName: this.options.connectionName,
          },
          "Skipping the primary route while its fallback breaker is open",
        );
        fallbackAttempted = true;
        const served = await this.sendOnFallbackRoute(
          messages,
          options,
          undefined,
          false,
          // The rule this argument encodes: a request gets a retry budget on
          // the backup only when it has not already spent one. This request
          // skips the primary outright, so it has spent nothing, and on a
          // single attempt a lone 429 or mid-stream cut would fail the turn.
          { backupRetryBudget: true },
        );
        if (served !== null) {
          return served;
        }
        // No backup route applies after all (the config changed under the
        // remembered outage), so the primary is the only route left. The
        // escalation path below stays disabled: it would resolve the same
        // options against the same config and get the same nothing.
      } else if (tryAcquireRecoveryProbe(breakerRoute)) {
        log.info(
          {
            provider: this.name,
            connectionName: this.options.connectionName,
            model: breakerRoute.model,
          },
          "Probing the primary route for recovery",
        );
        // One probe, one attempt: no retry loop. Two one-shot repairs are the
        // exception, both because the probe would otherwise misread its own
        // failure as the route still being down. A managed credential that
        // expired during the outage is refreshed, or the route could never come
        // back. Malformed tool-argument JSON gets the same corrective note the
        // retry loop appends, because that failure is conditioned on the
        // request rather than the route.
        //
        // The probe ends the moment it reports a verdict. What happens to the
        // request that carried it then depends on that verdict: an outage sends
        // it to the backup, and a recovery hands it back to the ordinary retry
        // loop below, which is now the right place for it because the route it
        // just cleared is the one that loop sends to.
        //
        // Every send the probe makes is counted, repairs included. A repair is
        // still a send against the primary, so it is what the seed below has to
        // be built from: a constant would only be right on the path where no
        // repair ran.
        let probeSends = 0;
        while (true) {
          try {
            probeSends += 1;
            const response = await this.inner.sendMessage(
              messagesForAttempt,
              normalizedOptions,
            );
            releaseRecoveryProbe(breakerRoute, { verdict: "recovered" });
            return response;
          } catch (error) {
            // A cancelled request asked the route nothing, so the probe has no
            // verdict to report. Hand the claim back and leave the breaker as
            // it was: reporting recovery here would delete an entry nothing
            // retested and send the next request through the full retry budget
            // of a route still known to be down.
            if (isCallerAbort(error)) {
              releaseRecoveryProbe(breakerRoute, { verdict: "abandoned" });
              this.attributeCredential(error);
              throw error;
            }
            if (
              !credentialRefreshAttempted &&
              this.shouldRefreshManagedCredential(error)
            ) {
              credentialRefreshAttempted = true;
              if (await this.refreshManagedCredential()) {
                continue;
              }
            }
            // The same one-shot corrective resend the retry loop performs. A
            // byte-identical resend can reproduce malformed tool-argument JSON
            // indefinitely, so without the note the probe would report an
            // outage the route had nothing to do with. Skipped when the hint
            // has nowhere to go (an assistant prefill tail), since an
            // unchanged resend would only cost another round trip.
            if (
              !correctiveResendAttempted &&
              isUnparseableToolArgsError(error)
            ) {
              correctiveResendAttempted = true;
              const repaired = withUnparseableToolArgsHint(messages);
              if (repaired !== messages) {
                messagesForAttempt = repaired;
                continue;
              }
            }
            // The probe stands in for the whole retry budget while the breaker
            // is open, so a failure the retry loop would have exhausted itself
            // against means the outage continues. Any other failure means the
            // route answered the request, which is all the probe asked.
            //
            // A mid-stream corruption is such an answer: every pattern in
            // `RETRYABLE_STREAM_PATTERNS` requires an absent HTTP status, which
            // means the upstream accepted the request, returned 200, and
            // streamed content. The failure is in the bytes it produced, not in
            // its ability to serve, so it is evidence the primary is HEALTHY
            // and must not extend a remembered outage that can reach ten
            // minutes. A 429 is deliberately NOT treated the same way: the
            // route refused to do the work, no resend repairs it (only waiting
            // does, which is exactly what the cooldown provides), and reading a
            // rate limit as recovery would send the whole fleet back to a
            // primary that rejects every request. Provider-declared
            // `overloaded` and transport aborts stay outages for the same
            // reason: neither produced a usable answer.
            const outage =
              !isRetryableStreamError(error) &&
              isFallbackEligibleError(error, {
                retriesExhausted: true,
                credentialSource: this.options.credentialSource,
              });
            // The probe's own error decides what stays remembered, not the
            // scope of the entry it was acquired under: an upstream that
            // answers with a retired-model 404 has stopped being an outage,
            // and a model outage that turns into a 503 has stopped being about
            // the model.
            releaseRecoveryProbe(
              breakerRoute,
              outage
                ? {
                    verdict: "failing",
                    failedRoute: failureBreakerRoute(breakerRoute, error),
                  }
                : { verdict: "recovered" },
            );
            this.attributeCredential(error);
            if (!outage) {
              // The route answered, the breaker is closed, and this request is
              // an ordinary request again. A deterministic rejection (a plain
              // 400, a classified 404, a context overflow) is the route's real
              // answer and no resend changes it, so it surfaces as itself.
              if (!isRetryableError(error)) {
                throw error;
              }
              // Anything still standing here is the stream-corruption family
              // the exclusion above lets through: exactly the failure the main
              // loop repairs by resending, against a route that was just
              // cleared. Throwing it would sacrifice the request that carried
              // the probe to establish a verdict every LATER request gets to
              // use, so it falls through into the ordinary loop instead. That
              // loop also keeps the backup as its last resort, so a primary
              // that streams corruption all the way through still finishes the
              // turn somewhere.
              //
              // Every send the probe made WAS this request spending its own
              // attempts, so the loop starts that many attempts in. The loop
              // retries while `retryAttempt < DEFAULT_MAX_RETRIES`, so seeding
              // it with `probeSends` leaves `1 + (DEFAULT_MAX_RETRIES -
              // probeSends)` sends below and `DEFAULT_MAX_RETRIES + 1` in
              // total, for any number of probe sends: the same budget a request
              // that never probes gets. Counting sends rather than entries into
              // this branch is what holds that equality for a probe whose
              // repairs (a credential refresh, a corrective resend) each cost a
              // send of their own.
              retryAttempt = probeSends;
              break;
            }
            fallbackAttempted = true;
            const served = await this.sendOnFallbackRoute(
              messages,
              options,
              error,
              true,
              // The probe is one attempt on the primary, not a retry loop, so
              // this request has spent no retry budget either. Same reasoning
              // as the breaker-open skip above.
              { backupRetryBudget: true },
            );
            if (served !== null) {
              // No trip needed: the failed probe already re-tripped the breaker
              // with the longer cooldown a repeat outage earns.
              return served;
            }
            // The probe confirmed this route is still down. If the backup
            // cannot serve, surface that primary failure directly instead of
            // spending a fresh retry budget on the route the probe just
            // re-tripped.
            throw error;
          }
        }
      }
    }

    while (true) {
      try {
        const result = await this.inner.sendMessage(
          messagesForAttempt,
          normalizedOptions,
        );
        if (breakerRoute !== null) {
          recordPrimarySuccess(breakerRoute);
        }
        return result;
      } catch (error) {
        if (
          !credentialRefreshAttempted &&
          this.shouldRefreshManagedCredential(error)
        ) {
          credentialRefreshAttempted = true;
          if (await this.refreshManagedCredential()) {
            continue;
          }
        }

        if (retryAttempt < DEFAULT_MAX_RETRIES && isRetryableError(error)) {
          // Malformed tool-argument JSON is conditioned on the request, so
          // resend with the corrective note. Built from the original
          // `messages` each time — the note appears exactly once no matter
          // how many attempts fail this way.
          if (isUnparseableToolArgsError(error)) {
            messagesForAttempt = withUnparseableToolArgsHint(messages);
          }
          // Prefer server-provided Retry-After; fall back to exponential backoff.
          const { delay, retryAfterHeader } = retryPlan(error, retryAttempt);
          log.warn(
            {
              attempt: retryAttempt + 1,
              maxRetries: DEFAULT_MAX_RETRIES,
              delay,
              retryAfterHeader,
              errorType: retryErrorType(error),
              correctiveHint: messagesForAttempt !== messages,
              provider: this.name,
              message: error instanceof Error ? error.message : String(error),
            },
            "Retrying after transient error",
          );
          retryAttempt++;
          await sleep(delay);
          continue;
        }

        // If we exhausted retries on a retryable error, tag the error so
        // downstream consumers (Sentry capture, escalation eligibility) can
        // recognize that the retry loop already tried its best. Control
        // reaches here for two reasons only, and the retryable predicate is
        // what separates them: either the budget is gone, or the error was
        // never retryable in the first place.
        //
        // Exhaustion is read off the same counter the retry guard above reads,
        // never off whether this loop happened to perform a retry itself. A
        // request can arrive here with its budget already consumed elsewhere:
        // a recovery probe seeds `retryAttempt` with the sends it made, so a
        // probe that spent the budget on its own repairs leaves the loop below
        // no retry to perform and would otherwise look like a request that had
        // never tried at all. Reading the counter keeps the two definitions
        // from drifting apart however the seed changes.
        const retriesExhausted =
          retryAttempt >= DEFAULT_MAX_RETRIES && isRetryableError(error);
        if (retriesExhausted && error instanceof Error) {
          (error as Error & { retriesExhausted?: boolean }).retriesExhausted =
            true;
        }

        this.attributeCredential(error);

        // Last resort before rethrowing: escalate an outage-shaped failure to
        // the backup profile's route when the construction site wired one in.
        // One hop max; a request pinned to an explicit model never re-routes.
        if (
          !fallbackAttempted &&
          this.options.resolveFallbackRoute !== undefined &&
          canReRouteToFallbackProfile(options) &&
          isFallbackEligibleError(error, {
            retriesExhausted,
            credentialSource: this.options.credentialSource,
          })
        ) {
          fallbackAttempted = true;
          // What the failure indicts: the whole upstream for an outage, only
          // this model for a retirement or rename.
          const failedRoute =
            breakerRoute === null
              ? null
              : failureBreakerRoute(breakerRoute, error);
          let failureObservation: BreakerObservation | undefined;
          if (failedRoute !== null) {
            failureObservation = recordPrimaryFailure(failedRoute);
          }
          const fallbackResult = await this.sendOnFallbackRoute(
            messages,
            options,
            error,
            retriesExhausted,
            // No budget here: the primary loop above runs to a definitive
            // verdict before reaching this point, either exhausting its whole
            // budget against a transient failure or receiving an error no
            // resend changes. The user has waited through all of that, so the
            // backup answers once or the turn fails.
            { backupRetryBudget: false },
          );
          if (fallbackResult !== null) {
            // A completed backup serve is proof the primary is down and the
            // backup can carry the traffic, so later requests skip the retry
            // budget until a probe says the primary is back.
            if (failedRoute !== null) {
              recordFallbackServed(failedRoute, Date.now(), failureObservation);
            }
            return fallbackResult;
          }
        }

        throw error;
      }
    }
  }

  /**
   * The `tools` override for the fallback send, or nothing when the original
   * list carries over unchanged.
   *
   * The caller decided whether to append the native web search sentinel from
   * the PRIMARY route's capability (see `AgentLoop`), so a backup that runs
   * no server-side search would receive a tool it cannot execute and answer
   * with a tool call nothing can service. The sentinel is dropped for those
   * routes: degraded mode loses native search rather than the whole turn.
   *
   * Gated on `config.nativeWebSearchSentinel`, never on the name alone: with a
   * search backend like Brave or the platform search proxy configured, a tool
   * of the same name is app-executed and works on every route, so filtering it
   * would take away a capability the backup can still serve.
   *
   * `dropToolChoice` reports that filtering emptied the list. `AgentLoop` sets
   * `tool_choice: { type: "auto" }` under the same condition that appends the
   * sentinel, so a tool-less call site with native search enabled carries the
   * sentinel as its ONLY tool. Filtering it and leaving the paired
   * `tool_choice` behind would put a choice with nothing to choose from on the
   * wire. The Anthropic Messages API rejects that (its client spreads
   * `tool_choice` out of the request config whether or not any `tools`
   * survived), and the OpenAI Responses API would too if its client did not
   * happen to gate the field on a non-empty tool list. A recoverable outage
   * would become a hard 400 on the backup.
   *
   * Deliberately narrow: the flag is raised only for an EMPTY filtered list,
   * the one case that is invalid on the wire. A non-empty list keeps whatever
   * `tool_choice` the caller set. A conversation-level `toolChoice` takes
   * precedence over the sentinel's `auto` in `AgentLoop`, so it is caller
   * intent that a route change must not quietly discard, and the request it
   * produces is still valid.
   */
  private fallbackTools(
    options: SendMessageOptions | undefined,
    route: { provider: Provider },
  ): { tools?: ToolDefinition[]; dropToolChoice: boolean } {
    const tools = options?.tools;
    if (
      options?.config?.nativeWebSearchSentinel !== true ||
      tools === undefined ||
      !tools.some((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME)
    ) {
      return { dropToolChoice: false };
    }
    const backupServesNativeSearch = route.provider.supportsNativeWebSearchFor
      ? route.provider.supportsNativeWebSearchFor(options)
      : route.provider.supportsNativeWebSearch === true;
    if (backupServesNativeSearch) {
      return { dropToolChoice: false };
    }
    const filtered = tools.filter(
      (tool) => tool.name !== NATIVE_WEB_SEARCH_TOOL_NAME,
    );
    return { tools: filtered, dropToolChoice: filtered.length === 0 };
  }

  /**
   * Send on the backup adapter, optionally with a retry budget of its own.
   *
   * The one-hop rule is structural rather than conditional here: `route
   * .provider` is the RAW adapter the route callback built, with no
   * `RetryProvider` of its own and therefore no `resolveFallbackRoute`, so
   * nothing this loop calls can escalate to a second backup no matter how many
   * times it retries.
   *
   * `fallbackOptions` is sent verbatim on every attempt, never re-normalized.
   * `normalizeSendMessageOptions` has already consumed the `callSite` and
   * stamped the backup route's `usageAttributionHeaders`; running it again over
   * that now callSite-less config would delete the headers and have no way to
   * rebuild them, leaving degraded traffic unattributed on the platform's
   * billing events. This is the same reason the route callback hands back a raw
   * adapter instead of a wrapped one.
   */
  private async sendOnBackupAdapter(
    route: { provider: Provider },
    messages: Message[],
    fallbackOptions: SendMessageOptions | undefined,
    retryBudget: boolean,
  ): Promise<ProviderResponse> {
    let attempt = 0;
    let didRetry = false;
    let messagesForAttempt = messages;
    while (true) {
      try {
        return await route.provider.sendMessage(
          messagesForAttempt,
          fallbackOptions,
        );
      } catch (error) {
        if (
          !retryBudget ||
          attempt >= DEFAULT_MAX_RETRIES ||
          !isRetryableError(error)
        ) {
          // Same tagging contract as the primary loop, so a backup that flapped
          // its way through the whole budget is recognizable to Sentry capture
          // as noise no engineering action would change.
          if (didRetry && isRetryableError(error) && error instanceof Error) {
            (error as Error & { retriesExhausted?: boolean }).retriesExhausted =
              true;
          }
          throw error;
        }
        // Built from the original `messages` each time, so the corrective note
        // appears exactly once however many attempts fail this way.
        if (isUnparseableToolArgsError(error)) {
          messagesForAttempt = withUnparseableToolArgsHint(messages);
        }
        const { delay, retryAfterHeader } = retryPlan(error, attempt);
        log.warn(
          {
            attempt: attempt + 1,
            maxRetries: DEFAULT_MAX_RETRIES,
            delay,
            retryAfterHeader,
            errorType: retryErrorType(error),
            correctiveHint: messagesForAttempt !== messages,
            provider: this.name,
            backupProvider: route.provider.name,
            connectionName: this.options.connectionName,
            message: error instanceof Error ? error.message : String(error),
          },
          "Retrying the backup route after a transient error",
        );
        didRetry = true;
        attempt++;
        await sleep(delay);
      }
    }
  }

  /**
   * Attempt the failed request on the backup route resolved by
   * `resolveFallbackRoute`. Returns null when no backup route applies (the
   * caller rethrows the original error unchanged); throws the fallback
   * error (with the original error attached as `cause`) when the backup
   * attempt itself fails.
   *
   * `originalError` is undefined when the circuit breaker skipped the primary
   * outright: there is no failure of this request to report or to attach, only
   * the remembered outage of an earlier one.
   *
   * `backupRetryBudget` says whether the backup send gets a retry loop of its
   * own. It is the caller's answer to one question: has this request already
   * spent a retry budget somewhere? See the three call sites for the reasoning
   * behind each answer.
   */
  private async sendOnFallbackRoute(
    messages: Message[],
    options: SendMessageOptions | undefined,
    originalError: unknown,
    retriesExhausted: boolean,
    { backupRetryBudget }: { backupRetryBudget: boolean },
  ): Promise<ProviderResponse | null> {
    let route: {
      provider: Provider;
      overrideProfile: string;
      forwardUsageAttributionHeaders: boolean;
    } | null;
    try {
      route = (await this.options.resolveFallbackRoute?.(options)) ?? null;
    } catch (resolveError) {
      log.warn(
        { provider: this.name, resolveError },
        "Failed to resolve fallback route; rethrowing the original error",
      );
      return null;
    }
    if (route === null) {
      return null;
    }

    // Reject a mix backup profile outright. The fallback schema already
    // forbids `fallbackProfile` from referencing a mix, but this wrapper must
    // not trust that: honoring one would require the route callback, the
    // winner-selection guard below, and the re-normalization to agree on the
    // same seeded arm, and a request without a `selectionSeed` expands the
    // mix independently at each of those points, so one arm's model could be
    // sent through another arm's provider adapter. Treat it as non-applying
    // and surface the original error.
    if (getConfig().llm.profiles?.[route.overrideProfile]?.mix != null) {
      log.warn(
        {
          provider: this.name,
          connectionName: this.options.connectionName,
          overrideProfile: route.overrideProfile,
        },
        "Backup profile is a mix, which fallback routing does not support; rethrowing the original error",
      );
      return null;
    }

    // Guard against a backup profile that does not actually apply: the
    // resolver skips a disabled, incomplete, or missing override profile and
    // falls through to the next rung (often the failed primary), while the
    // request would still dispatch on the backup adapter, producing a
    // provider/model mismatch. Verify the backup profile wins the winner
    // selection the re-normalization below will perform; if it does not,
    // surface the original error instead of sending a mismatched request.
    const failedConfig = options?.config;
    const callSite = failedConfig?.callSite;
    const selectionSeed = failedConfig?.selectionSeed;
    const selection =
      callSite === undefined
        ? null
        : selectWinningProfile(callSite, getConfig().llm, {
            overrideProfile: route.overrideProfile,
            ...(selectionSeed !== undefined ? { selectionSeed } : {}),
            isResolvableProvider: dispatchProviderResolvable,
          });
    if (
      selection === null ||
      selection.source !== "override" ||
      selection.profileName !== route.overrideProfile
    ) {
      log.warn(
        {
          provider: this.name,
          connectionName: this.options.connectionName,
          overrideProfile: route.overrideProfile,
          selectionSource: selection?.source,
          selectedProfile: selection?.profileName,
        },
        "Backup profile did not apply on re-resolution; rethrowing the original error",
      );
      return null;
    }

    // Re-resolve the ORIGINAL caller options with the backup profile forced
    // (`resolveCallSiteConfig` floats a forced override to the top of the
    // selection chain). Explicit per-call `max_tokens`/`effort`/`thinking`
    // are cleared so the backup profile's resolved values win; the pin gate
    // in `canReRouteToFallbackProfile` already excluded explicit
    // `config.model`. Re-normalizing on a callSite-bearing config also
    // restamps the usage-attribution headers from the backup resolution, so
    // platform usage events attribute degraded traffic to the backup
    // profile. Whether those headers are forwarded at all follows the
    // FALLBACK route's policy, not the primary's: a managed primary falling
    // back to a third-party adapter must not leak billing metadata, and a
    // non-managed primary falling back to the managed proxy must include it.
    const fallbackConfig: Record<string, unknown> = { ...options?.config };
    delete fallbackConfig.max_tokens;
    delete fallbackConfig.effort;
    delete fallbackConfig.thinking;
    fallbackConfig.overrideProfile = route.overrideProfile;
    fallbackConfig.forceOverrideProfile = true;
    const { dropToolChoice, ...toolsOverride } = this.fallbackTools(
      options,
      route,
    );
    // Filtering the sentinel emptied the tool list, so the `tool_choice` the
    // call site paired with it now names a choice among no tools. See
    // `fallbackTools` for why that is a hard 400 rather than a no-op.
    if (dropToolChoice) {
      delete fallbackConfig.tool_choice;
    }
    const fallbackOptions = normalizeSendMessageOptions(
      route.provider.name,
      {
        ...options,
        config: fallbackConfig,
        ...toolsOverride,
      },
      {
        forwardUsageAttributionHeaders:
          route.forwardUsageAttributionHeaders === true,
      },
    );

    const escalationCause =
      originalError === undefined
        ? { errorType: "breaker_open" }
        : {
            errorType: fallbackErrorType(originalError, retriesExhausted),
            message:
              originalError instanceof Error
                ? originalError.message
                : String(originalError),
          };
    log.warn(
      {
        provider: this.name,
        connectionName: this.options.connectionName,
        fallbackProvider: route.provider.name,
        overrideProfile: route.overrideProfile,
        ...escalationCause,
      },
      "Falling back to backup profile",
    );

    try {
      const response = await this.sendOnBackupAdapter(
        route,
        messages,
        fallbackOptions,
        backupRetryBudget,
      );
      // Stamp the provider that actually served the response. Without this,
      // a backup adapter that does not set `actualProvider` leaves the outer
      // call-site router recording the success under the failed primary
      // provider (wrong provider, wrong pricing attribution). Never
      // overwrite a more specific value the adapter already set.
      if (response.actualProvider === undefined) {
        response.actualProvider = route.provider.name;
      }
      // Stamp the profile that actually governed the response for the same
      // reason: the outer `UsageTrackingProvider` resolves attribution from
      // the ORIGINAL request options, which still carry the failed primary's
      // resolution, so without this the usage event would bill the fallback
      // serve under the wrong profile. Never overwrite a more specific value
      // an inner wrapper already set.
      if (response.actualInferenceProfile === undefined) {
        response.actualInferenceProfile = route.overrideProfile;
      }
      return response;
    } catch (fallbackError) {
      if (originalError === undefined) {
        throw fallbackError;
      }
      log.warn(
        {
          provider: this.name,
          connectionName: this.options.connectionName,
          fallbackProvider: route.provider.name,
          overrideProfile: route.overrideProfile,
          fallbackError,
        },
        "Backup profile failed; rethrowing the original provider error",
      );
      return null;
    }
  }
}
