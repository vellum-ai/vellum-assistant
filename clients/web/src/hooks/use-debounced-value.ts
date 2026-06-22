import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delay` ms
 * of inactivity. Useful for delaying API calls while the user is typing.
 *
 * React 19's `useDeferredValue` defers renders but does NOT throttle
 * network requests — it lets React batch re-renders during idle time.
 * A fixed-delay debounce is the correct pattern when each value change
 * triggers a network request (search-as-you-type).
 *
 * @see https://react.dev/reference/react/useDeferredValue — why it's
 *   not a substitute for debouncing network calls
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}
