/**
 * Subscribe a React hook to a typed event-bus channel.
 *
 * Wraps the standard pattern:
 *
 * ```ts
 * useEffect(() => {
 *   const unsubscribe = useEventBusStore
 *     .getState()
 *     .subscribe(event, handler);
 *   return unsubscribe;
 * }, [...]);
 * ```
 *
 * The handler is wrapped in a ref so consumers don't need to memoize
 * it: passing an inline arrow function is fine — the subscription is
 * not torn down and re-registered on every render. The subscription's
 * effect-lifecycle deps are exactly `[event]`; pass nothing else here.
 *
 * For imperative call sites that live outside the React tree (Zustand
 * store bootstraps, middleware), use {@link subscribeBus} instead.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  type BusEventName,
  type BusHandler,
  useEventBusStore,
} from "@/stores/event-bus-store";

export function useBusSubscription<K extends BusEventName>(
  event: K,
  handler: BusHandler<K>,
): void {
  // Update the latest-handler ref in a commit-phase effect so the
  // subscription callback only ever sees handlers from committed
  // renders. Mutating the ref during render would let an event
  // delivered in the render→commit window (or after an aborted
  // render under concurrent React) invoke a handler whose closures
  // do not match the rendered UI state.
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    return useEventBusStore.getState().subscribe(event, (payload) => {
      handlerRef.current(payload);
    });
  }, [event]);
}

/**
 * Imperative bus subscription for code outside the React tree
 * (Zustand store bootstraps, route loaders, middleware). Returns the
 * unsubscribe function — store it alongside the bootstrap's other
 * teardown handles.
 *
 * Inside a React component or hook, prefer {@link useBusSubscription}.
 */
export function subscribeBus<K extends BusEventName>(
  event: K,
  handler: BusHandler<K>,
): () => void {
  return useEventBusStore.getState().subscribe(event, handler);
}
