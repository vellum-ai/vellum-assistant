/**
 * Telephony STT profile adapter.
 *
 * Centralizes the mapping from config-level STT settings
 * (`calls.voice.transcriptionProvider`, `calls.voice.speechModel`) to a
 * normalized profile object consumed by call infrastructure.
 *
 * Provider-specific semantics:
 * - **Deepgram**: defaults speechModel to `"nova-3"` when unset.
 * - **Google**: leaves speechModel undefined when unset (Google's Cloud Speech
 *   API uses its own default). Treats the legacy Deepgram default `"nova-3"`
 *   as unset — upgraded workspaces may still have it persisted from prior
 *   defaults before provider was switched.
 *
 * ## Cutover readiness
 *
 * {@link evaluateServicesSttReadiness} is a pure preflight check that
 * validates whether the `services.stt` provider (the future telephony STT
 * path) is configured and telephony-eligible. It does **not** alter the
 * active call setup — production calls continue to use the ConversationRelay
 * native STT path driven by `calls.voice.transcriptionProvider`.
 *
 * The cutover activation seam is a single future change in
 * `twilio-routes.ts`: replace the call to `resolveTelephonySttProfile()`
 * with a resolver that reads from `services.stt` instead of
 * `calls.voice.transcriptionProvider`. See the cutover runbook in
 * `docs/internal-reference.md` for the full step-by-step plan.
 */

import type { CallsVoiceConfig } from "../config/schemas/calls.js";
import {
  resolveTelephonySttCapability,
  type TelephonySttCapability,
} from "../providers/speech-to-text/resolve.js";

/**
 * Provider-agnostic representation of the telephony STT configuration.
 */
export interface TelephonySttProfile {
  /** STT provider name as expected by the telephony platform (e.g. "Deepgram", "Google"). */
  provider: string;
  /** ASR model identifier, or undefined to let the provider use its default. */
  speechModel: string | undefined;
}

const DEEPGRAM_DEFAULT_SPEECH_MODEL = "nova-3";

/**
 * Resolve a normalized telephony STT profile from the calls voice config.
 *
 * This is the single source of truth for STT provider selection in the
 * telephony call path. All call-related code should read STT details from
 * the returned profile rather than branching on provider inline.
 */
export function resolveTelephonySttProfile(
  voiceConfig: Pick<CallsVoiceConfig, "transcriptionProvider" | "speechModel">,
): TelephonySttProfile {
  const provider = voiceConfig.transcriptionProvider;
  const rawSpeechModel = voiceConfig.speechModel;

  return {
    provider,
    speechModel: resolveEffectiveSpeechModel(provider, rawSpeechModel),
  };
}

/**
 * Determine the effective speech model for the given provider.
 *
 * - Deepgram: fall back to "nova-3" when the model is not explicitly set.
 * - Google: treat the legacy Deepgram default ("nova-3") as unset so that
 *   workspaces that were previously configured for Deepgram and later
 *   switched to Google don't inadvertently send a Deepgram model name.
 */
function resolveEffectiveSpeechModel(
  provider: string,
  rawSpeechModel: string | undefined,
): string | undefined {
  const isGoogle = provider === "Google";

  if (rawSpeechModel == null) {
    return isGoogle ? undefined : DEEPGRAM_DEFAULT_SPEECH_MODEL;
  }

  // Legacy migration: if the persisted model is the Deepgram default but
  // the provider has been switched to Google, treat it as unset.
  if (rawSpeechModel === DEEPGRAM_DEFAULT_SPEECH_MODEL && isGoogle) {
    return undefined;
  }

  return rawSpeechModel;
}

// ── Cutover readiness preflight ─────────────────────────────────────

/**
 * Outcome of the services.stt telephony readiness check.
 *
 * - `ready` — the configured `services.stt` provider is telephony-eligible
 *   and credentials are present. A future cutover can proceed.
 * - `not-ready` — one or more prerequisites are unmet. The `reasons` array
 *   contains human-readable diagnostics.
 */
export type ServicesSttReadiness =
  | {
      status: "ready";
      capability: TelephonySttCapability & { status: "supported" };
    }
  | {
      status: "not-ready";
      reasons: string[];
      capability: TelephonySttCapability;
    };

/**
 * Evaluate whether the `services.stt` provider is ready for a future
 * telephony cutover.
 *
 * This is a **read-only preflight check** — it inspects configuration,
 * the provider catalog, and credential availability without creating live
 * connections or modifying call setup behavior. Production calls continue
 * on the ConversationRelay native STT path regardless of this result.
 *
 * Intended callers:
 * - Integration tests that assert cutover preconditions.
 * - Future admin/diagnostic endpoints that surface readiness status.
 * - The cutover PR itself, to gate activation on a passing preflight.
 */
export async function evaluateServicesSttReadiness(): Promise<ServicesSttReadiness> {
  const capability = await resolveTelephonySttCapability();

  if (capability.status === "supported") {
    return { status: "ready", capability };
  }

  const reasons: string[] = [];
  switch (capability.status) {
    case "unconfigured":
      reasons.push(
        `services.stt provider is not in the provider catalog: ${capability.reason}`,
      );
      break;
    case "unsupported":
      reasons.push(
        `services.stt provider "${capability.providerId}" does not support telephony: ${capability.reason}`,
      );
      break;
    case "missing-credentials":
      reasons.push(
        `services.stt provider "${capability.providerId}" is telephony-eligible but missing credentials for "${capability.credentialProvider}": ${capability.reason}`,
      );
      break;
  }

  return { status: "not-ready", reasons, capability };
}
