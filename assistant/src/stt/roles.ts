/**
 * STT consumer roles.
 *
 * `services.stt.provider` is one global that every STT caller reads, while the
 * provider catalog already models capability per boundary. A provider that is
 * right for one consumer is therefore wrong for another: Flux has no batch
 * endpoint, so a global set to it breaks file transcription and telephony at
 * the same moment it makes live voice better.
 *
 * A role names the consumer, not the boundary. Telephony is why: a single call
 * resolves a streaming transcriber and falls back to a batch one within the
 * same session, so a `{batch, streaming}` split would put one call on two
 * roles. Each role instead declares the boundaries its call sites actually
 * use, and a provider must satisfy all of them to be selectable for it.
 */

import {
  getProviderEntry,
  sttCatalogKeyFor,
} from "../providers/speech-to-text/provider-catalog.js";
import type { SttBoundaryId, SttProviderId } from "./types.js";

/** The consumers that may select their own STT provider. */
export const STT_ROLES = [
  "liveVoice",
  "telephony",
  "dictation",
  "watch",
  "batch",
] as const;

export type SttRole = (typeof STT_ROLES)[number];

/** What a provider must support to serve a role. */
export interface SttRoleRequirements {
  /** Every boundary the role's call sites resolve a transcriber on. */
  readonly boundaries: readonly SttBoundaryId[];
  /** Whether the role additionally requires telephony ingestion. */
  readonly requiresTelephony: boolean;
  /** Human-readable name for config errors and resolver logs. */
  readonly label: string;
}

export const STT_ROLE_REQUIREMENTS: Record<SttRole, SttRoleRequirements> = {
  /**
   * The live-voice transport arms a streaming transcriber per utterance and
   * has no batch fallback, so streaming alone is the whole requirement.
   */
  liveVoice: {
    boundaries: ["daemon-streaming"],
    requiresTelephony: false,
    label: "live voice",
  },
  /**
   * A call starts on streaming ingestion and falls back to per-turn batch
   * when no streaming transcriber resolves, so both boundaries are load
   * bearing inside one session. `telephonyMode` is a separate axis from the
   * boundaries and is checked on top of them.
   */
  telephony: {
    boundaries: ["daemon-streaming", "daemon-batch"],
    requiresTelephony: true,
    label: "telephony",
  },
  /**
   * The composer mic reaches the daemon two ways: a streaming WebSocket for
   * live partials, and a batch POST of the recorded blob where that socket
   * is unavailable. Both are the same user-facing feature, so a provider
   * that serves only one would leave dictation half broken.
   */
  dictation: {
    boundaries: ["daemon-streaming", "daemon-batch"],
    requiresTelephony: false,
    label: "dictation",
  },
  /**
   * A watch session streams the user's narration continuously while they
   * work and files each final on the timeline. It shares dictation's
   * transport but none of its fallback: there is no batch leg to catch a
   * provider that cannot stream, so streaming alone is the requirement.
   */
  watch: {
    boundaries: ["daemon-streaming"],
    requiresTelephony: false,
    label: "watch",
  },
  /** File, attachment and skill transcription. Batch only. */
  batch: {
    boundaries: ["daemon-batch"],
    requiresTelephony: false,
    label: "batch transcription",
  },
};

/**
 * Why a provider cannot serve a role, or null when it can.
 *
 * The catalog already knows every provider's boundaries and telephony mode;
 * this only asks whether they cover what the role needs. Config validation
 * rejects a pair on this, and the resolver logs it, so the same sentence
 * explains the failure wherever it surfaces.
 */
export function sttRoleCapabilityGap(
  role: SttRole,
  selection: SttRoleSelection,
): string | null {
  // Capability belongs to the resolved row: "deepgram" batches and
  // "deepgram" running flux does not, and only the pair distinguishes them.
  const provider = sttCatalogKeyFor(
    selection.provider as SttProviderId,
    selection.model,
  );
  const entry = getProviderEntry(provider);
  if (!entry) {
    return `"${selection.provider}" is not in the STT provider catalog`;
  }

  const requirements = STT_ROLE_REQUIREMENTS[role];
  const missing = requirements.boundaries.filter(
    (boundary) => !entry.supportedBoundaries.has(boundary),
  );
  if (missing.length > 0) {
    return `"${provider}" supports no ${missing.join(" or ")} transcription, which ${requirements.label} needs`;
  }

  if (requirements.requiresTelephony && entry.telephonyMode === "none") {
    return `"${provider}" does not transcribe calls, which ${requirements.label} needs`;
  }

  return null;
}

/** What a role names: a provider, and optionally which of its model families. */
export interface SttRoleSelection {
  readonly provider: string;
  readonly model?: string | undefined;
}

/**
 * The STT config a consumer reads: its own `services.stt.roles` entry when it
 * has one, otherwise the global provider and its configured model family.
 *
 * A role names the pair rather than a bare provider because the family is
 * where capability actually differs. A role that could only name a provider
 * could not say "live voice on flux", which is the whole reason to have one.
 *
 * The parameter is structural rather than the config type on purpose. This
 * module sits under the config schema (which imports it to validate role
 * entries), so importing the schema back would close a cycle, and the cycle
 * would only surface as a module-init failure far from here.
 */
export function sttSelectionForRole(
  stt: {
    readonly provider: string;
    readonly providers?:
      | Record<string, { readonly model?: unknown } | undefined>
      | undefined;
    readonly roles?: Partial<Record<SttRole, SttRoleSelection>> | undefined;
  },
  role: SttRole | undefined,
): SttRoleSelection {
  const override = role === undefined ? undefined : stt.roles?.[role];
  if (override !== undefined) {
    return override;
  }
  const model = stt.providers?.[stt.provider]?.model;
  return {
    provider: stt.provider,
    ...(typeof model === "string" ? { model } : {}),
  };
}

/** The catalog row a role resolves to, via the pair it names. */
export function sttCatalogKeyForRole(
  stt: Parameters<typeof sttSelectionForRole>[0],
  role: SttRole | undefined,
): SttProviderId {
  const selection = sttSelectionForRole(stt, role);
  return sttCatalogKeyFor(selection.provider as SttProviderId, selection.model);
}
