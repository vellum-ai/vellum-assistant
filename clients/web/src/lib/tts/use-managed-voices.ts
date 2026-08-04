/**
 * Fetches the managed (Vellum) TTS voice catalog from the platform. Fetch-only:
 * the platform is the single source of truth for offered voices and the
 * default, so until the catalog loads (or when it fails) `voices` is empty and
 * pickers render nothing rather than a stale local list.
 *
 * Read from the platform directly rather than through the assistant's daemon.
 * The catalog is caller-independent — the platform's own rate card decides it —
 * so routing it through an assistant only meant no assistant, no voices. That
 * gated onboarding's voice audition on the hatch, which is exactly when there
 * is no assistant yet.
 *
 * Shared by the Settings → Voice card, the live-voice voice picker, and the
 * onboarding face step so all three offer the same voices and default.
 */

import { useQuery } from "@tanstack/react-query";

import { managedSpeechTtsVoicesRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

/**
 * A managed voice as offered to the UI. `source` is a plain `string` so
 * voices the platform serves before this client learns their source still
 * type-check.
 */
export interface ManagedVoiceOption {
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  source: string;
}

export interface UseManagedVoices {
  /** Offered voices; empty until the platform catalog loads (or on failure). */
  voices: readonly ManagedVoiceOption[];
  /** Platform default model; null until fetched or when none is offered. */
  defaultModel: string | null;
  /** True once the platform catalog has loaded. */
  fetched: boolean;
  /**
   * A fetch is in flight. Distinct from `!fetched`, which is also true when the
   * catalog is disabled or has failed — surfaces that show a pending state need
   * to tell "still coming" from "not coming".
   */
  loading: boolean;
}

export function useManagedVoices(
  options: { enabled?: boolean } = {},
): UseManagedVoices {
  const isOrgReady = useIsOrgReady();
  const { data, isLoading } = useQuery({
    ...managedSpeechTtsVoicesRetrieveOptions(),
    enabled: isOrgReady && (options.enabled ?? true),
    staleTime: 60_000,
    retry: false,
  });

  return {
    voices: data?.voices ?? [],
    defaultModel: data?.defaultModel ?? null,
    fetched: !!data,
    loading: isLoading,
  };
}
