import {
  configGetQueryKey,
  identityGetQueryKey,
  identityIntroGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConfigGetData,
  IdentityGetData,
  IdentityIntroGetData,
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

export function assistantIdentityQueryKey(
  assistantId: string | null,
): ReturnType<typeof identityGetQueryKey> {
  return identityGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<IdentityGetData>);
}

export function assistantIdentityIntroQueryKey(
  assistantId: string | null | undefined,
): ReturnType<typeof identityIntroGetQueryKey> {
  return identityIntroGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<IdentityIntroGetData>);
}
