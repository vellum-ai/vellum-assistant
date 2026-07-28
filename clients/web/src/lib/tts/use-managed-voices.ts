/**
 * Fetches the managed (Vellum) TTS voice catalog from the platform via the
 * daemon. Fetch-only: the platform is the single source of truth for offered
 * voices and the default, so until the catalog loads (or when it fails)
 * `voices` is empty and pickers render nothing rather than a stale local
 * list. No shipped daemon release predates the `tts/managed-voices` route
 * (it landed alongside the voice picker itself, before v0.10.11), so there
 * is no old-daemon population for a static fallback to serve.
 *
 * Shared by the Settings → Voice card and the live-voice voice picker so both
 * offer the same voices and default, tracking the platform's rate card.
 */

import { useQuery } from "@tanstack/react-query";

import { ttsManagedvoicesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
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
    retry: false,
  });

  return {
    voices: data?.voices ?? [],
    defaultModel: data?.defaultModel ?? null,
    fetched: !!data,
  };
}
