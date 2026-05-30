import { useEffect, useRef } from "react";
import * as Sentry from "@sentry/browser";
import { useNavigate } from "react-router";

import { ensureMainWindowVisible } from "@/runtime/main-window";
import { useEventBusStore } from "@/stores/event-bus-store";
import { routes } from "@/utils/routes";

/**
 * Wires the renderer-side actions for inbound deep links published
 * on the event bus by `useEventBusInit` (which fans the Electron
 * deep-link bridge into typed `deeplink.*` events).
 *
 * - `deeplink.send { message }` → pre-fill the chat composer IF
 *   it's empty. Refusing to overwrite the user's in-progress text
 *   is the conservative call; the dropped link is captured as a
 *   Sentry breadcrumb so we can see how often it happens before
 *   investing in a "queue or prompt" UX.
 * - `deeplink.openThread { threadId }` → navigate to the
 *   conversation route. Router handles not-found.
 * - `deeplink.unknown { url }` → Sentry breadcrumb + no action.
 *   Useful telemetry on unrecognized links the OS routed to us.
 *
 * All three handlers fire `ensureMainWindowVisible()` first so
 * the action lands on a user-visible window. Off Electron the
 * wrapper no-ops.
 *
 * Lives in the chat domain (per ELECTRON.md's "hooks that bridge
 * feature state live in the domain") because both load-bearing
 * actions (composer pre-fill, conversation navigation) are
 * chat-specific. Mounted from `ChatPage` so it has access to the
 * composer's `setInput`.
 */

export interface UseDeepLinkConsumerParams {
  /** Current composer input — checked before pre-fill so we don't
   *  clobber the user's in-progress typing. */
  composerInput: string;
  /** Setter for the composer input. */
  setComposerInput: (next: string) => void;
}

export function useDeepLinkConsumer({
  composerInput,
  setComposerInput,
}: UseDeepLinkConsumerParams): void {
  const navigate = useNavigate();

  // Mirror the dynamic props into refs so the bus subscription
  // effect can mount once and read fresh values at handler time.
  // Subscribing inside an effect with these in the dep array would
  // tear down + resubscribe on every keystroke (composerInput
  // changes constantly) — wasteful and a race window where a deep
  // link could land between unsubscribe and resubscribe.
  const composerInputRef = useRef(composerInput);
  const setComposerInputRef = useRef(setComposerInput);
  composerInputRef.current = composerInput;
  setComposerInputRef.current = setComposerInput;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const bus = useEventBusStore.getState();

    const unsubSend = bus.subscribe("deeplink.send", ({ message }) => {
      void ensureMainWindowVisible();
      if (composerInputRef.current.trim().length > 0) {
        Sentry.addBreadcrumb({
          category: "deeplink",
          level: "info",
          message:
            "deeplink.send arrived but composer had unsaved text — drop, do not overwrite",
        });
        return;
      }
      setComposerInputRef.current(message);
    });

    const unsubOpenThread = bus.subscribe(
      "deeplink.openThread",
      ({ threadId }) => {
        void ensureMainWindowVisible();
        navigateRef.current(routes.conversation(threadId));
      },
    );

    const unsubUnknown = bus.subscribe("deeplink.unknown", ({ url }) => {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message: "deeplink.unknown",
        data: { url },
      });
    });

    return () => {
      unsubSend();
      unsubOpenThread();
      unsubUnknown();
    };
  }, []);
}
