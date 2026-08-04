import { useEffect, useState } from "react";

import { resolveLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";

type PlatformAssistantIdState = {
  platformAssistantId: string | null;
  isLoading: boolean;
  error: Error | null;
};

/**
 * Resolve the active assistant's **platform** id for platform-API path
 * params. Local-mode lockfile ids are slugs (e.g. `vellum-dark-cub`),
 * but every platform assistant route uses a `<uuid:assistant_id>` path
 * converter — a slug id falls off Django's URL table and surfaces as a
 * bare "Not found". Platform-hosted ids (already UUIDs) resolve to
 * themselves without any network round-trip.
 */
export function usePlatformAssistantId(
  assistantId: string | null | undefined,
  enabled: boolean,
): PlatformAssistantIdState {
  const [state, setState] = useState<PlatformAssistantIdState>({
    platformAssistantId: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !assistantId) {
      setState({ platformAssistantId: null, isLoading: false, error: null });
      return;
    }

    let active = true;
    setState({ platformAssistantId: null, isLoading: true, error: null });

    void resolveLocalAssistantPlatformIdentity(assistantId)
      .then((resolvedPlatformAssistantId) => {
        if (!active) {
          return;
        }
        setState({
          platformAssistantId: resolvedPlatformAssistantId,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setState({
          platformAssistantId: null,
          isLoading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => {
      active = false;
    };
  }, [assistantId, enabled]);

  return state;
}
