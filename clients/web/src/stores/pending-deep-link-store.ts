/**
 * Pending deep-link state — a one-shot inbox the global deep-link
 * consumer writes to and the chat composer reads from.
 *
 * Why a store: a `vellum://send?message=…` deep link can arrive
 * while the user is on a non-chat route (`/assistant/settings`,
 * `/assistant/logs`, etc.). The global consumer (mounted at
 * `RootLayout`) navigates to the chat AND parks the message here;
 * `ChatPage` then consumes on mount once the composer store is alive
 * (`useDeepLinkConsumer`). Without this hand-off, the message
 * would be dropped — the bus event publishes to no chat-domain
 * subscriber until `ChatPage` mounts.
 *
 * One-shot semantics — `consumePendingComposerMessage` returns and
 * clears. If a second deep link arrives before consumption, the
 * latest message wins (silent overwrite — two-link-overwrite is
 * below the noise floor in practice). Renderer reloads / hard
 * navigates blow this away because it's not persisted — by design,
 * deep links are transient signals.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface PendingDeepLinkState {
  /** Latest pending `deeplink.send` message text, or `null` if none. */
  pendingComposerMessage: string | null;
  /**
   * Whether a `deeplink.startVoice` is waiting for a live-voice session
   * starter. Same cold-launch race as `pendingComposerMessage`: the starter is
   * registered by `useLiveVoiceSessionController` at `ChatLayout` scope, so it
   * does not exist yet when a launch deep link fires (and never exists on
   * settings / logs / account routes). Boolean rather than a payload — a
   * second link before the drain is the same request.
   */
  pendingVoiceStart: boolean;
}

export interface PendingDeepLinkActions {
  /**
   * Set the pending composer message. If one is already pending,
   * it's overwritten — the most recent deep link wins. Used by the
   * global consumer in `useGlobalDeepLinkConsumer`.
   */
  setPendingComposerMessage: (message: string) => void;
  /**
   * Read and clear the pending composer message. Returns `null` if
   * none was set. Used by `useDeepLinkConsumer` in the chat domain.
   */
  consumePendingComposerMessage: () => string | null;
  /** Park a start-voice deep link until a session starter is registered. */
  setPendingVoiceStart: () => void;
  /**
   * Read and clear the parked start-voice request. Returns `false` if none was
   * parked. Used by `drainPendingVoiceStartDeepLink` in the live-voice domain.
   */
  consumePendingVoiceStart: () => boolean;
}

export type PendingDeepLinkStore = PendingDeepLinkState &
  PendingDeepLinkActions;

const usePendingDeepLinkStoreBase = create<PendingDeepLinkStore>()(
  (set, get) => ({
    pendingComposerMessage: null,
    pendingVoiceStart: false,
    setPendingComposerMessage: (message) =>
      set({ pendingComposerMessage: message }),
    consumePendingComposerMessage: () => {
      const message = get().pendingComposerMessage;
      if (message !== null) set({ pendingComposerMessage: null });
      return message;
    },
    setPendingVoiceStart: () => set({ pendingVoiceStart: true }),
    consumePendingVoiceStart: () => {
      const pending = get().pendingVoiceStart;
      if (pending) set({ pendingVoiceStart: false });
      return pending;
    },
  }),
);

export const usePendingDeepLinkStore = createSelectors(
  usePendingDeepLinkStoreBase,
);

/**
 * Reset hook for tests. Not intended for production callers.
 */
export function __resetPendingDeepLinkForTesting(): void {
  usePendingDeepLinkStoreBase.setState({
    pendingComposerMessage: null,
    pendingVoiceStart: false,
  });
}
