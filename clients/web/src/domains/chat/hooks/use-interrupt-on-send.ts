import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * Whether a message sent while the assistant is busy interrupts the running
 * turn instead of queueing behind it.
 *
 * The flag describes daemon behaviour, so it is read from the assistant flag
 * store rather than the client one: the composer must offer whatever the
 * daemon it is bound to will actually do. Both surfaces that change with it
 * (the composer's busy row and the send hook's queue branch) ask through this
 * module, so they cannot disagree.
 *
 * The queued-messages drawer deliberately does not ask. A send can still be
 * queued under the flag (another actor owns the running turn, the interrupt
 * times out, the lock is held by a `/compact`), and that message needs its
 * row and its cancel, steer and edit controls exactly as it would with the
 * flag off. The drawer's condition is the one that has always been true: it
 * renders when there is something queued.
 *
 * Reads `false` until the store hydrates, which is the queueing behaviour the
 * daemon defaults to, so an unhydrated composer offers Stop rather than a Send
 * whose message would silently queue.
 */
export function useInterruptOnSend(): boolean {
  return useAssistantFeatureFlagStore.use.interruptOnSend();
}

/**
 * Imperative read of the same flag, for the send path, which decides inside a
 * callback rather than during render.
 */
export function getInterruptOnSend(): boolean {
  return useAssistantFeatureFlagStore.getState().interruptOnSend === true;
}
