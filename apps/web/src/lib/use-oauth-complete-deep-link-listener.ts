
import { useEffect } from "react";

import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/lib/native-deep-link.js";

/**
 * Subscribes to the window event the deep-link router dispatches when
 * Capacitor's `appUrlOpen` fires with an OAuth-complete payload. Hides
 * the `addEventListener` / `removeEventListener` boilerplate from
 * consumers. The event is typed via the `WindowEventMap` augmentation
 * in `@/lib/native-deep-link`, so no runtime cast is needed.
 *
 * `onPayload` should be wrapped in `useCallback` (or otherwise have a
 * stable identity) — re-renders that change the callback re-register
 * the listener. Consumers are responsible for any payload filtering
 * (e.g. matching `requestId` against an in-flight request).
 *
 * No-op on web — the producer side (the deep-link router) only fires on
 * Capacitor.
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
