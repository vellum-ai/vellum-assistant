/**
 * Fetches the managed (Vellum) TTS voice catalog. Fetch-only: the platform is
 * the single source of truth for offered voices and the default, so until the
 * catalog loads (or when it fails) `voices` is empty and pickers render nothing
 * rather than a stale local list.
 *
 * Two transports, because two kinds of caller need the same list under
 * different credentials:
 *
 * - {@link useManagedVoices} goes through the assistant's daemon, which reaches
 *   the platform on the assistant's own API key. Self-hosted and gateway-only
 *   sessions have no platform session in the browser, so this is the only
 *   transport that works for them.
 * - {@link useUnscopedManagedVoices} reads the platform directly, for callers
 *   that have a session but no assistant to route through.
 *
 * The catalog itself is identical either way: the platform's rate card decides
 * it, and neither the assistant nor the organization is an input.
 */

import { useQuery } from "@tanstack/react-query";

import { managedSpeechTtsVoicesRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
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
  /**
   * A fetch is in flight. Distinct from `!fetched`, which is also true when the
   * catalog is disabled or has failed: surfaces that show a pending state need
   * to tell "still coming" from "not coming".
   */
  loading: boolean;
}

interface VoiceCatalogResponse {
  voices?: readonly ManagedVoiceOption[];
  defaultModel?: string | null;
}

function toResult(
  data: VoiceCatalogResponse | undefined,
  isLoading: boolean,
): UseManagedVoices {
  return {
    voices: data?.voices ?? [],
    defaultModel: data?.defaultModel ?? null,
    fetched: !!data,
    loading: isLoading,
  };
}

/**
 * The catalog as served through `assistantId`'s daemon. Idle until there is an
 * assistant to ask.
 */
export function useManagedVoices(
  assistantId: string | null,
  options: { enabled?: boolean } = {},
): UseManagedVoices {
  const isOrgReady = useIsOrgReady();
  const { data, isLoading } = useQuery({
    ...ttsManagedvoicesGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: isOrgReady && !!assistantId && (options.enabled ?? true),
    staleTime: 60_000,
    retry: false,
  });

  return toResult(data, isLoading);
}

/**
 * The catalog read straight from the platform, for callers with a session but
 * no assistant. Onboarding's voice audition runs while the user's assistant is
 * still hatching, so routing it through an assistant would gate it on the
 * hatch.
 *
 * Needs a platform session, which every caller in that position has. Surfaces
 * belonging to an existing assistant want {@link useManagedVoices} instead:
 * self-hosted and gateway-only sessions reach the platform only through the
 * daemon.
 */
export function useUnscopedManagedVoices(
  options: { enabled?: boolean } = {},
): UseManagedVoices {
  const isOrgReady = useIsOrgReady();
  const { data, isLoading } = useQuery({
    ...managedSpeechTtsVoicesRetrieveOptions(),
    enabled: isOrgReady && (options.enabled ?? true),
    staleTime: 60_000,
    retry: false,
  });

  return toResult(data, isLoading);
}
