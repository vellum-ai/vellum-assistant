/**
 * Shared helper for one-shot (single round-trip, no agent loop) LLM calls.
 *
 * One-shot call sites across `assistant/src` hand-roll the same five steps with
 * divergent idioms: resolve the provider, set up a timeout, call
 * `provider.sendMessage`, extract the output, and (for tool calls) validate the
 * structured input. `runOneShotLLM` collapses those into one well-behaved call:
 *
 *   - provider resolution via {@link getConfiguredProvider}
 *   - a default 30s timeout backed by {@link createTimeout} with cleanup
 *     guaranteed in a `finally`
 *   - optional caller `signal` merged with the timeout via `AbortSignal.any`
 *   - text-mode extraction via {@link extractAllText}
 *   - tool-mode extraction via {@link extractToolUse} plus optional zod
 *     validation of the tool input
 *   - a single, consistent null-vs-throw policy when no provider is configured
 *   - consistent warn-logging on every failure branch
 *
 * Scope: this covers *plain* one-shot calls. The streaming / system-prompt
 * side-chain niche (no persistence, forced `tool_choice: none`, per-event text
 * accumulation, bootstrap-excluded system prompt) is owned by
 * {@link file://./../runtime/btw-sidechain.ts | runBtwSidechain} — do not
 * duplicate that here. If you need streamed `text_delta` events or the
 * side-chain's system-prompt assembly, reach for `runBtwSidechain` instead.
 *
 * Two rules govern correct use:
 *
 *  1. **Tuning lives in call-site defaults, not opts.** Per-site tuning
 *     (max_tokens, temperature, effort, thinking, etc.) belongs in
 *     {@link file://./../config/call-site-defaults.ts | call-site-defaults.ts}
 *     keyed off the `callSite` argument — NOT in `opts.config`. Reserve
 *     `opts.config` for genuinely per-call concerns like an ad-hoc
 *     `overrideProfile` or a one-off `model` pin. See `resolveCallSiteConfig`
 *     for the full merge precedence.
 *
 *  2. **Always pass your OWN `LLMCallSite` ID.** Usage monitoring attributes
 *     cost/tokens by the wire `callSite`, so borrowing another site's ID
 *     corrupts the user-facing usage page and admin dashboards. If your site
 *     needs to resolve *like* `mainAgent` (e.g. follow the user's chat-model
 *     selection), do NOT borrow `"mainAgent"` here — a later milestone adds a
 *     resolver-level mechanism for that. Pass the call site that names where
 *     the request actually originates.
 */

import type { z } from "zod";

import type { LLMCallSite } from "../config/schemas/llm.js";
import { BackendUnavailableError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  createTimeout,
  extractAllText,
  extractToolUse,
  getConfiguredProvider,
} from "./provider-send-message.js";
import type {
  Message,
  ProviderResponse,
  SendMessageConfig,
  ToolDefinition,
} from "./types.js";

const log = getLogger("one-shot-llm");

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Policy for when no provider is configured/available for the call site.
 *  - `"null"` (default): resolve to `{ status: "unavailable" }`.
 *  - `"throw"`: throw {@link BackendUnavailableError} so the caller can bail.
 */
export type OnUnavailablePolicy = "null" | "throw";

interface BaseOneShotOpts {
  systemPrompt?: string;
  /** Timeout in ms. Defaults to 30_000. Backed by `createTimeout`. */
  timeoutMs?: number;
  /** External abort signal, merged with the timeout via `AbortSignal.any`. */
  signal?: AbortSignal;
  /**
   * Per-call config passthrough (e.g. `{ overrideProfile }` or `{ model }`).
   * `callSite` is always injected by the helper; anything passed here is
   * shallow-merged on top, so callers should not normally set per-site tuning
   * like `max_tokens` here — that belongs in call-site defaults.
   */
  config?: Omit<SendMessageConfig, "callSite">;
  /** What to do when no provider is configured. Defaults to `"null"`. */
  onUnavailable?: OnUnavailablePolicy;
}

/** Text-mode options: no `tools`/`schema`. */
export interface OneShotTextOpts extends BaseOneShotOpts {
  tools?: undefined;
  schema?: undefined;
}

/** Tool-mode options: a single forced tool plus an optional zod schema. */
export interface OneShotToolOpts<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> extends BaseOneShotOpts {
  /** Tool definitions to expose. At least one is required for tool mode. */
  tools: ToolDefinition[];
  /**
   * Tool the model must call. When a string, forces
   * `tool_choice: { type: "tool", name }`. When omitted, the provider chooses
   * (`tools` are still offered). Pass a full `tool_choice` object via `config`
   * for advanced cases.
   */
  toolChoice?: string;
  /**
   * Optional zod schema validating the tool-call input. When present, a
   * `schema_mismatch` failure is returned (and warn-logged) if the model's
   * tool input does not parse. When absent, the raw `Record<string, unknown>`
   * input is returned as `data`.
   */
  schema?: TSchema;
}

export type OneShotOpts<TSchema extends z.ZodTypeAny = z.ZodTypeAny> =
  | OneShotTextOpts
  | OneShotToolOpts<TSchema>;

/**
 * Reasons a one-shot call can fail to produce usable output despite the
 * provider responding. Distinct from `unavailable` (no provider at all).
 */
export type OneShotFailureReason =
  | "timeout" // the request aborted (timeout or external signal)
  | "tool_use_missing" // tool mode, but no tool_use block in the response
  | "schema_mismatch" // tool mode, input failed zod validation
  | "empty_text" // text mode, but no non-empty text block
  | "provider_error"; // provider.sendMessage threw

/**
 * Discriminated result. All success branches carry the raw {@link
 * ProviderResponse} so callers can read usage/model metadata.
 *  - `ok` (text mode): `data` is the extracted text.
 *  - `ok` (tool mode): `data` is the validated (or raw) tool input.
 *  - `unavailable`: no provider configured (only when `onUnavailable: "null"`).
 *  - `failure`: provider responded but output was unusable; `reason` says why.
 */
export type OneShotResult<TData> =
  | { status: "ok"; data: TData; response: ProviderResponse }
  | { status: "unavailable" }
  | {
      status: "failure";
      reason: OneShotFailureReason;
      response?: ProviderResponse;
      error?: unknown;
    };

// Overloads give callers precise `data` typing without manual generics.

/** Tool mode with a zod schema → `data` is the schema's inferred output. */
export function runOneShotLLM<TSchema extends z.ZodTypeAny>(
  callSite: LLMCallSite,
  messages: Message[],
  opts: OneShotToolOpts<TSchema> & { schema: TSchema },
): Promise<OneShotResult<z.output<TSchema>>>;

/** Tool mode without a schema → `data` is the raw tool input. */
export function runOneShotLLM(
  callSite: LLMCallSite,
  messages: Message[],
  opts: OneShotToolOpts,
): Promise<OneShotResult<Record<string, unknown>>>;

/** Text mode → `data` is the extracted text. */
export function runOneShotLLM(
  callSite: LLMCallSite,
  messages: Message[],
  opts?: OneShotTextOpts,
): Promise<OneShotResult<string>>;

export async function runOneShotLLM(
  callSite: LLMCallSite,
  messages: Message[],
  opts: OneShotOpts = {},
): Promise<OneShotResult<unknown>> {
  const onUnavailable = opts.onUnavailable ?? "null";

  // `SendMessageConfig` has an `[key: string]: unknown` index signature, so
  // `config.overrideProfile` reads back as `unknown`. Narrow to the string the
  // resolver expects; provider *selection* (connection/model) needs the
  // override at resolution time, while `config` below re-applies it for wire
  // attribution.
  const overrideProfile =
    typeof opts.config?.overrideProfile === "string"
      ? opts.config.overrideProfile
      : undefined;

  const provider = await getConfiguredProvider(
    callSite,
    overrideProfile !== undefined ? { overrideProfile } : {},
  );
  if (!provider) {
    if (onUnavailable === "throw") {
      throw new BackendUnavailableError(
        `No LLM provider configured for ${callSite}`,
      );
    }
    log.warn({ callSite }, "No LLM provider configured; returning unavailable");
    return { status: "unavailable" };
  }

  // `tools` distinguishes tool mode from text mode; narrow once here.
  const toolOpts =
    "tools" in opts && (opts.tools?.length ?? 0) > 0
      ? (opts as OneShotToolOpts)
      : undefined;

  const { signal: timeoutSignal, cleanup } = createTimeout(
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  let response: ProviderResponse;
  try {
    response = await provider.sendMessage(messages, {
      ...(toolOpts ? { tools: toolOpts.tools } : {}),
      ...(opts.systemPrompt !== undefined
        ? { systemPrompt: opts.systemPrompt }
        : {}),
      config: {
        ...opts.config,
        callSite,
        ...(toolOpts?.toolChoice !== undefined
          ? {
              tool_choice: {
                type: "tool" as const,
                name: toolOpts.toolChoice,
              },
            }
          : {}),
      },
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      log.warn({ callSite }, "One-shot LLM call aborted (timeout or signal)");
      return { status: "failure", reason: "timeout", error: err };
    }
    log.warn({ callSite, err }, "One-shot LLM provider call threw");
    return { status: "failure", reason: "provider_error", error: err };
  } finally {
    cleanup();
  }

  if (!toolOpts) {
    const text = extractAllText(response).trim();
    if (!text) {
      log.warn({ callSite }, "One-shot LLM returned empty text");
      return { status: "failure", reason: "empty_text", response };
    }
    return { status: "ok", data: text, response };
  }

  const toolBlock = extractToolUse(response);
  if (
    !toolBlock ||
    (toolOpts.toolChoice !== undefined &&
      toolBlock.name !== toolOpts.toolChoice)
  ) {
    log.warn(
      { callSite, stopReason: response.stopReason },
      "One-shot LLM returned no matching tool_use block",
    );
    return { status: "failure", reason: "tool_use_missing", response };
  }

  if (!toolOpts.schema) {
    return { status: "ok", data: toolBlock.input, response };
  }

  const parsed = toolOpts.schema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { callSite, error: parsed.error.message },
      "One-shot LLM tool input did not match schema",
    );
    return { status: "failure", reason: "schema_mismatch", response };
  }

  return { status: "ok", data: parsed.data, response };
}
