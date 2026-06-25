import { useEffect, useState } from "react";

import { resolveLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";

type ManagedOAuthPlatformAssistantIdState = {
  platformAssistantId: string | null;
  isLoading: boolean;
  error: Error | null;
};

export function useManagedOAuthPlatformAssistantId(
  assistantId: string | null | undefined,
  enabled: boolean,
): ManagedOAuthPlatformAssistantIdState {
  const [state, setState] = useState<ManagedOAuthPlatformAssistantIdState>({
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
        if (!active) return;
        setState({
          platformAssistantId: resolvedPlatformAssistantId,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
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
