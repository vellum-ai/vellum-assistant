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
 */

import type { LiveVoiceFrontModelConfig } from "../config/schemas/live-voice.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type { Provider, ToolDefinition } from "../providers/types.js";
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

export type VoiceEndpointDecision = { action: "release" } | { action: "hold" };

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
}

const RELEASE: VoiceEndpointDecision = { action: "release" };
const HOLD: VoiceEndpointDecision = { action: "hold" };

const TURN_DECISION_TOOL_NAME = "turn_decision";

const TURN_DECISION_TOOL: ToolDefinition = {
  name: TURN_DECISION_TOOL_NAME,
  description:
    "Record whether the speaker's turn is complete. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      complete: {
        type: "boolean",
        description:
          "true when the speaker has finished their thought; false when they are mid-thought and more speech is likely coming.",
      },
    },
    required: ["complete"],
  },
};

const SYSTEM_PROMPT =
  "You decide whether the speaker has finished their thought or is mid-thought/thinking. " +
  "You see a live-voice transcript captured up to a pause. Treat trailing conjunctions, " +
  "dangling prepositions, or an obviously unfinished clause as mid-thought. " +
  "Bias toward finished: when in doubt, mark the turn complete.";

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
      let provider: Provider | null;
      try {
        provider = await getProvider();
      } catch (error) {
        log.debug({ error }, "Endpoint decision provider resolution failed");
        return RELEASE;
      }
      if (!provider) {
        // No configured provider — fail open.
        return RELEASE;
      }

      const { signal: timeoutSignal, cleanup } = createTimeout(
        config.endpointDecisionTimeoutMs,
      );
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      try {
        const response = await raceAbort(
          provider.sendMessage([userMessage(buildPrompt(input))], {
            tools: [TURN_DECISION_TOOL],
            systemPrompt: SYSTEM_PROMPT,
            config: {
              max_tokens: 64,
              callSite: "voiceFrontDecision",
              tool_choice: { type: "tool", name: TURN_DECISION_TOOL_NAME },
              disableCache: true,
            },
            signal: combinedSignal,
          }),
          combinedSignal,
        );
        const toolBlock = extractToolUse(response);
        if (
          toolBlock?.name === TURN_DECISION_TOOL_NAME &&
          (toolBlock.input as { complete?: unknown }).complete === false
        ) {
          return HOLD;
        }
        // `complete: true`, a missing/foreign tool block, or a malformed
        // input all release — only an explicit "not finished" holds.
        return RELEASE;
      } catch (error) {
        log.debug(
          { error, extensionCount: input.extensionCount },
          "Endpoint decision failed — releasing turn",
        );
        return RELEASE;
      } finally {
        cleanup();
      }
    },
  };
}
