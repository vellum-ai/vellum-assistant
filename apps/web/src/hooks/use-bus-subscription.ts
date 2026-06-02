/**
 * Subscribe a React component / hook to a typed event-bus channel.
 *
 * Wraps the standard pattern:
 *
 * ```ts
 * useEffect(() => {
 *   const unsubscribe = subscribe(event, handler);
 *   return unsubscribe;
 * }, [...]);
 * ```
 *
 * The handler is wrapped in a ref so consumers don't need to memoize
 * it: passing an inline arrow function is fine — the subscription is
 * not torn down and re-registered on every render. The subscription's
 * effect-lifecycle deps are exactly `[event]`; pass nothing else here.
 *
 * For imperative call sites outside the React tree, import `subscribe`
 * from `@/lib/event-bus` directly.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  subscribe,
  type BusEventName,
  type BusHandler,
} from "@/lib/event-bus";

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
    return subscribe(event, (payload) => {
      handlerRef.current(payload);
    });
  }, [event]);
}
