import {
  configGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConfigGetData,
  SoundsAvailableGetData,
  SoundsConfigGetData,
} from "@/generated/daemon/types.gen";

/**
 * Build the generated query key for the daemon config. All consumers —
 * sync handler, service cards, imperative invalidation — share one cache
 * entry via this key.
 */
export function assistantDaemonConfigQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof configGetQueryKey> {
  return configGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConfigGetData>);
}

export function assistantSoundsConfigQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof soundsConfigGetQueryKey> {
  return soundsConfigGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<SoundsConfigGetData>);
}

export function assistantSoundsAvailableQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof soundsAvailableGetQueryKey> {
  return soundsAvailableGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<SoundsAvailableGetData>);
}

export const ASSISTANT_IDENTITY_QUERY_KEY = "assistant-identity" as const;

export function assistantIdentityQueryKey(assistantId: string | null) {
  return [ASSISTANT_IDENTITY_QUERY_KEY, assistantId ?? ""] as const;
}

export const ASSISTANT_IDENTITY_INTRO_QUERY_KEY = "identity-intro" as const;

export function assistantIdentityIntroQueryKey(
  assistantId: string | null | undefined,
) {
  return [ASSISTANT_IDENTITY_INTRO_QUERY_KEY, assistantId ?? ""] as const;
}
