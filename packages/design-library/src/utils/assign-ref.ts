import type { Ref } from "react";

/**
 * Hands `value` to a ref the caller passed in, whichever kind it is, for a
 * component that also needs the element itself and so cannot pass the
 * caller's ref straight through.
 */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}
