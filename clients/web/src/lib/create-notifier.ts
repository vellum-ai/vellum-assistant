/**
 * A payload-free notification channel: any number of listeners, synchronous
 * delivery, no state to read back.
 *
 * For cross-domain push signals that carry a payload, use the event bus
 * (`lib/event-bus.ts`). This is the narrower shape for the case where an
 * infrastructure module (an HTTP interceptor, say) has to tell one app-level
 * subscriber that something happened and has nothing to say beyond the fact
 * of it.
 *
 * A listener that throws is isolated: the remaining listeners still run, and
 * the throw never reaches `notify()`'s caller, which is typically midway
 * through a request path that must complete either way.
 */
export interface Notifier {
  /** Register a listener. Returns its unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Run every registered listener, in registration order. */
  notify: () => void;
}

export function createNotifier(): Notifier {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A listener must not break the notifier or its caller.
        }
      }
    },
  };
}
