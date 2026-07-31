import { useEffect } from "react";

import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";

/**
 * Subscribes to the window event the deep-link router dispatches when
 * Capacitor's `appUrlOpen` fires with an OAuth-complete payload.
 *
 * `onPayload` should be wrapped in `useCallback` — re-renders that change
 * the callback re-register the listener. No-op on web — the producer side
 * only fires on Capacitor.
 */
export function useOAuthCompleteDeepLinkListener(
  onPayload: (payload: OAuthCompleteDeepLinkPayload) => void,
): void {
  useEffect(() => {
    const handler = (event: CustomEvent<OAuthCompleteDeepLinkPayload>) => {
      onPayload(event.detail);
    };
    window.addEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, handler);
    return () => {
      window.removeEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, handler);
    };
  }, [onPayload]);
}
