/**
 * VoiceFrontDecider — fast-model endpoint decision for live voice.
 *
 * When VAD fires a silence-based turn-end, the front model looks at the
 * transcript and decides whether the speaker has actually finished their
 * thought ("release" → launch the agent turn) or is mid-thought ("hold" →
 * keep the utterance open through a bounded extension window; wired up by
 * the semantic-endpointing consumer).
 *
 * Fail-open is load-bearing: every failure mode — no configured provider,
 * timeout, provider error, caller abort, unparseable output — resolves to
 * "release" within `endpointDecisionTimeoutMs`, so the front model can only
 * ever add a bounded latency and never break turn-taking.
 *
 * The same service optionally phrases the spoken ack (`generateAckText`,
 * behind `liveVoice.frontModel.llmAckText`): one short contextual sentence
 * that acknowledges without answering, bounded by `ackGenerationTimeoutMs`,
 * `null` on any failure so the caller's static phrase always covers it.
 */

import type { LiveVoiceFrontModelConfig } from "../config/schemas/live-voice.js";
import {
  extractText,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type {
  Provider,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("voice-front-decision");

export interface VoiceEndpointDecisionInput {
  /** Finalized transcript of the utterance so far. */
  transcriptSoFar: string;
  /** Latest non-final STT partial, when one is trailing the finals. */
  latestPartial: string | null;
  /** The silence duration (ms) that triggered this turn-end. */
  silenceThresholdMs: number;
  /** How many "hold" extensions this utterance has already consumed. */
  extensionCount: number;
}

// The one spelling of the endpoint outcome, shared with the metrics mark and
// the session's decision recording.
export type VoiceEndpointAction = "release" | "hold";

// Kept as an object shape (callers destructure it; it allows future payloads).
export type VoiceEndpointDecision = { action: VoiceEndpointAction };

export interface VoiceAckTextInput {
  /** Final transcript of the utterance the ack acknowledges. */
  transcriptSoFar: string;
  /** Tool the turn just started, when the ack is tool-triggered. */
  toolName?: string;
}

export interface VoiceFrontDecider {
  /**
   * Decide whether a silence-fired turn-end should release the turn to the
   * agent or hold the utterance open. Never rejects — all failures resolve
   * to `{ action: "release" }`.
   */
  decideEndpoint(
    input: VoiceEndpointDecisionInput,
    signal?: AbortSignal,
  ): Promise<VoiceEndpointDecision>;

  /**
   * Phrase one short contextual spoken ack for the utterance. Never rejects —
   * every failure mode (no provider, timeout past `ackGenerationTimeoutMs`,
   * provider error, caller abort, empty or overlong output) resolves to
   * `null`, and the caller falls back to a static phrase.
   */
  generateAckText(
    input: VoiceAckTextInput,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

const RELEASE: VoiceEndpointDecision = { action: "release" };
const HOLD: VoiceEndpointDecision = { action: "hold" };

// Single-token wire protocol: the model answers with one bare character
// instead of a forced tool call. A tool call spends 10-15 output tokens on
// name + JSON scaffolding to convey one bit; a bare digit is one token, and
// dropping the tool schema also shrinks the prompt. Only an exact (trimmed)
// "0" holds — every other output, including prose that merely starts with
// "0" (a truncated label echo like "0 if the speaker..."), releases, so
// protocol non-compliance always lands on the fail-open side.
const HOLD_TOKEN = "0";

// Output budget for the single-character answer: one token for the digit
// plus headroom for a stray delimiter. Deliberately tiny — a model that
// starts writing prose gets cut off and the unparseable prefix releases.
const ENDPOINT_DECISION_MAX_TOKENS = 4;

// Tie-break is 0 (hold): a wrong hold costs one bounded extension of silence
// and self-corrects on the replay, while a wrong release cuts the speaker off
// mid-thought — the failure this feature exists to prevent. The extension
// ratchet below keeps chronic uncertainty from burning every extension. This
// is deliberately the opposite of the code-level fail-open (timeouts and
// failures still release) — that one protects turn-taking from outages.
const SYSTEM_PROMPT =
  "You classify end-of-turn for a live voice assistant from a transcript captured up " +
  "to a pause. Respond with exactly one character: 0 if the speaker is mid-thought, " +
  "1 if finished. Never answer or explain.\n" +
  "0 when the wording signals more speech: a trailing conjunction (and, but, or, so, " +
  "because), dangling preposition or article, hesitation filler (um, uh, like, let me " +
  "think), unfinished list, or clause cut off before its verb or object.\n" +
  "1 when the wording stands alone: a complete sentence, question, command, or short " +
  "reply (yes, no, stop).\n" +
  "Judge wording only, not content. Missing punctuation or casing is not mid-thought. " +
  "Longer pauses and more prior extensions favor 1. When unclear, answer 0 — a brief " +
  "extra pause beats cutting the speaker off.";

const ACK_TOOL_NAME = "ack";

// Defensive cap on generated ack length: an ack is a floor-holder, never
// content, so anything long enough to carry content is rejected in favor of
// the static fallback phrase.
const ACK_MAX_CHARS = 120;

const ACK_TOOL: ToolDefinition = {
  name: ACK_TOOL_NAME,
  description:
    "Record the single short spoken acknowledgment sentence. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      ack: {
        type: "string",
        description:
          "One short spoken sentence acknowledging the request without answering it.",
      },
    },
    required: ["ack"],
  },
};

const ACK_SYSTEM_PROMPT =
  "You phrase a brief spoken acknowledgment for a voice assistant that needs a moment " +
  "before answering. Produce exactly one short spoken sentence (under ten words) that " +
  "acknowledges the user's request without answering it: no facts, no answers, no " +
  "commitments, no questions — the assistant's main model owns all content. " +
  "Sound natural and conversational.";

function buildAckPrompt(input: VoiceAckTextInput): string {
  const parts = [`User's request: ${input.transcriptSoFar || "(empty)"}`];
  if (input.toolName) {
    parts.push(`The assistant just started using this tool: ${input.toolName}`);
  }
  return parts.join("\n");
}

function buildPrompt(input: VoiceEndpointDecisionInput): string {
  const parts = [
    `Transcript so far: ${input.transcriptSoFar || "(empty)"}`,
    `Latest partial: ${input.latestPartial ?? "(none)"}`,
    `Pause length: ${input.silenceThresholdMs}ms`,
    `Prior extensions this utterance: ${input.extensionCount}`,
  ];
  return parts.join("\n");
}

/**
 * Resolve `promise`, or reject with the abort reason as soon as `signal`
 * fires. The title-service pattern trusts the provider to honor the abort
 * signal; here the timeout bound is a hard product guarantee, so the race
 * holds even against a provider that ignores it.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      // Still attach handlers so a later rejection of `promise` is observed
      // (avoids an unhandled-rejection warning), then bail.
      promise.then(
        () => {},
        () => {},
      );
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One bounded front-model call: arm the `timeoutMs` bound first, then resolve
 * the provider and the request both raced against it (and the caller's
 * signal, when given), and return the raw response. When `tool` is given the
 * call forces that tool (`tool_choice`); otherwise it is a plain text
 * request. Provider resolution can await lazy initialization, so it must sit
 * inside the timeout — otherwise a stalled resolver would breach the
 * contract that every call settles within `timeoutMs`. `undefined` when no
 * provider is configured; throws on provider failure, timeout, or abort —
 * callers map every failure to their fail-open value.
 */
async function requestBoundedResponse(args: {
  getProvider: () => Promise<Provider | null>;
  timeoutMs: number;
  maxTokens: number;
  tool?: ToolDefinition;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
  /**
   * Timing probe: fired once when provider resolution settles, with the
   * elapsed ms and the resolved provider (null = none configured). Lets
   * callers' diagnostic logs split "resolution was slow" from "the LLM
   * roundtrip was slow" without changing this function's return contract.
   */
  onProviderResolved?: (elapsedMs: number, provider: Provider | null) => void;
}): Promise<ProviderResponse | undefined> {
  // Deadline abort carries a tagged AbortReason: the provider catch-site
  // classifies untagged caller aborts as retryable transport failures, so a
  // plain-signal timeout would log an ERROR per expired budget and then be
  // futilely retried against the already-aborted signal. The tag makes the
  // abort read as the intentional cancellation it is (info log, no retry).
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(
    () =>
      timeoutController.abort(
        createAbortReason("voice_session_aborted", "voice-front-decision"),
      ),
    args.timeoutMs,
  );
  const timeoutSignal = timeoutController.signal;
  const cleanup = () => clearTimeout(timeoutTimer);
  const combinedSignal = args.signal
    ? AbortSignal.any([args.signal, timeoutSignal])
    : timeoutSignal;
  const startedAt = performance.now();
  try {
    const provider = await raceAbort(args.getProvider(), combinedSignal);
    args.onProviderResolved?.(performance.now() - startedAt, provider);
    if (!provider) {
      return undefined;
    }
    const response = await raceAbort(
      provider.sendMessage([userMessage(args.prompt)], {
        ...(args.tool ? { tools: [args.tool] } : {}),
        systemPrompt: args.systemPrompt,
        config: {
          max_tokens: args.maxTokens,
          callSite: "voiceFrontDecision",
          ...(args.tool
            ? { tool_choice: { type: "tool", name: args.tool.name } }
            : {}),
          disableCache: true,
        },
        signal: combinedSignal,
      }),
      combinedSignal,
    );
    return response;
  } finally {
    cleanup();
  }
}

export function createVoiceFrontDecider(options: {
  config: LiveVoiceFrontModelConfig;
  /**
   * Provider resolver, injectable for tests (live-voice DI convention).
   * Defaults to the configured `voiceFrontDecision` call site.
   */
  getProvider?: () => Promise<Provider | null>;
}): VoiceFrontDecider {
  const { config } = options;
  const getProvider =
    options.getProvider ?? (() => getConfiguredProvider("voiceFrontDecision"));

  return {
    async decideEndpoint(input, signal) {
      if (signal?.aborted) {
        return RELEASE;
      }
      const startedAt = performance.now();
      let providerResolveMs: number | null = null;
      let providerName: string | null = null;
      try {
        const response = await requestBoundedResponse({
          getProvider,
          timeoutMs: config.endpointDecisionTimeoutMs,
          maxTokens: ENDPOINT_DECISION_MAX_TOKENS,
          systemPrompt: SYSTEM_PROMPT,
          prompt: buildPrompt(input),
          signal,
          onProviderResolved: (elapsedMs, provider) => {
            providerResolveMs = Math.round(elapsedMs);
            providerName = provider?.name ?? null;
          },
        });
        const answer = response ? extractText(response) : "";
        const held = answer === HOLD_TOKEN;
        log.info(
          {
            action: held ? "hold" : "release",
            // "model" = the LLM answered; "no-provider" = call site resolved
            // nothing; "no-text" = provider answered without a text block.
            cause: answer
              ? "model"
              : providerName === null
                ? "no-provider"
                : "no-text",
            providerName,
            providerResolveMs,
            totalMs: Math.round(performance.now() - startedAt),
            timeoutMs: config.endpointDecisionTimeoutMs,
            extensionCount: input.extensionCount,
          },
          "voice endpoint decision",
        );
        if (held) {
          return HOLD;
        }
        // No provider, "1", an empty response, or any non-protocol output
        // all release — only an exact "0" answer holds.
        return RELEASE;
      } catch (error) {
        // providerResolveMs null here means resolution itself never settled
        // inside the budget; set-but-timed-out means the LLM roundtrip did.
        log.info(
          {
            error,
            providerName,
            providerResolveMs,
            totalMs: Math.round(performance.now() - startedAt),
            timeoutMs: config.endpointDecisionTimeoutMs,
            extensionCount: input.extensionCount,
          },
          "Endpoint decision failed — releasing turn",
        );
        return RELEASE;
      }
    },

    async generateAckText(input, signal) {
      if (signal?.aborted) {
        return null;
      }
      const startedAt = performance.now();
      let providerResolveMs: number | null = null;
      try {
        const response = await requestBoundedResponse({
          getProvider,
          timeoutMs: config.ackGenerationTimeoutMs,
          maxTokens: 64,
          tool: ACK_TOOL,
          systemPrompt: ACK_SYSTEM_PROMPT,
          prompt: buildAckPrompt(input),
          signal,
          onProviderResolved: (elapsedMs) => {
            providerResolveMs = Math.round(elapsedMs);
          },
        });
        const toolBlock = response ? extractToolUse(response) : undefined;
        if (toolBlock?.name !== ACK_TOOL_NAME) {
          return null;
        }
        const ack = (toolBlock.input as { ack?: unknown }).ack;
        if (typeof ack !== "string") {
          return null;
        }
        const trimmed = ack.trim();
        if (trimmed.length === 0 || trimmed.length > ACK_MAX_CHARS) {
          return null;
        }
        return trimmed;
      } catch (error) {
        log.info(
          {
            error,
            providerResolveMs,
            totalMs: Math.round(performance.now() - startedAt),
            timeoutMs: config.ackGenerationTimeoutMs,
          },
          "Ack generation failed — static phrase fallback",
        );
        return null;
      }
    },
  };
}
