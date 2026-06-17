import { useEffect, useState } from "react";

import { resolveManagedOAuthAssistantId } from "@/lib/local-managed-oauth-identity";

type ManagedOAuthAssistantIdState = {
  assistantId: string | null;
  isLoading: boolean;
  error: Error | null;
};

export function useManagedOAuthAssistantId(
  assistantId: string | null | undefined,
  enabled: boolean,
): ManagedOAuthAssistantIdState {
  const [state, setState] = useState<ManagedOAuthAssistantIdState>({
    assistantId: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !assistantId) {
      setState({ assistantId: null, isLoading: false, error: null });
      return;
    }

    let active = true;
    setState({ assistantId: null, isLoading: true, error: null });

    void resolveManagedOAuthAssistantId(assistantId)
      .then((resolvedAssistantId) => {
        if (!active) return;
        setState({
          assistantId: resolvedAssistantId,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          assistantId: null,
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
