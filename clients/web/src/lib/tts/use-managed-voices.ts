/**
 * Fetches the managed (Vellum) TTS voice catalog from the platform via the
 * daemon, with the static catalog standing in while loading and for daemons
 * that predate the `tts/managed-voices` route.
 *
 * Shared by the Settings → Voice card and the live-voice voice picker so both
 * offer the same voices and default, tracking the platform's rate card.
 *
 * A successful response is authoritative even when empty — an empty catalog
 * means the platform offers nothing right now, and substituting the static list
 * would surface voices the platform would reject. The static fallback applies
 * only when there is no response at all (loading, errors, old daemons).
 */

import { useQuery } from "@tanstack/react-query";

import { ttsManagedvoicesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  DEFAULT_MANAGED_VOICE,
  MANAGED_VOICES,
} from "@/lib/tts/managed-voice-catalog";

/**
 * A managed voice as offered to the UI. Widens the static catalog's
 * `ManagedVoiceSource` union to `string` so voices the platform serves before
 * this client learns their source still type-check.
 */
export interface ManagedVoiceOption {
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  source: string;
}

export interface UseManagedVoices {
  voices: readonly ManagedVoiceOption[];
  /** Platform default model, or the static default when unfetched. May be null. */
  defaultModel: string | null;
  /** True once the platform catalog has loaded (vs. the static fallback). */
  fetched: boolean;
}

export function useManagedVoices(
  assistantId: string | null,
  options: { enabled?: boolean } = {},
): UseManagedVoices {
  const isOrgReady = useIsOrgReady();
  const { data } = useQuery({
    ...ttsManagedvoicesGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: isOrgReady && !!assistantId && (options.enabled ?? true),
    staleTime: 60_000,
    // Old daemons 404 this route; the static fallback covers them.
    retry: false,
  });

  return {
    voices: data ? data.voices : MANAGED_VOICES,
    defaultModel: data ? data.defaultModel : DEFAULT_MANAGED_VOICE,
    fetched: !!data,
  };
}
