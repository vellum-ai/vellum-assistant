/**
 * Controlled-input state seeded from a value that may resolve after
 * the consumer first renders (e.g. async data, a context provider that
 * hydrates a tick later, or a feature flag).
 *
 * Returns a `value` / `onChange` pair to bind to a controlled `<input>`.
 *
 *   - The value starts at the trimmed `seed`, so a synchronously-known
 *     seed renders correctly on the first paint with no flicker.
 *   - If the seed becomes available or changes after mount, the value
 *     is backfilled — but only while the input is still empty AND the
 *     consumer has not called `onChange`. We never overwrite an already-
 *     populated value, so the user's first impression of the seed is
 *     stable.
 *   - Once `onChange` has been called (the user typed, pasted, or
 *     cleared the input), the input is considered "touched" and is
 *     never reseeded. This preserves user intent — including the
 *     deliberate choice of an empty value — over any later seed
 *     update.
 *
 * Pattern reference: React's "You Might Not Need an Effect" docs cover
 * the simpler "reset on prop change" case via `key` remount or a
 * "previous value during render" pattern. Neither fits the combination
 * required here ("seed may arrive after mount AND a typed value must
 * never be overwritten"): `key` reset would remount the input and
 * cause a flicker, and the render-phase pattern still needs a touched
 * flag to live somewhere. An effect plus a ref is the canonical shape
 * for this case. See:
 * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function usePrefilledInput(seed: string | null | undefined): {
  value: string;
  onChange: (next: string) => void;
} {
  const [value, setValue] = useState<string>(() => (seed ?? "").trim());
  const touched = useRef(false);

  useEffect(() => {
    if (touched.current) return;
    const trimmed = (seed ?? "").trim();
    if (!trimmed) return;
    setValue((prev) => prev || trimmed);
  }, [seed]);

  const onChange = useCallback((next: string) => {
    touched.current = true;
    setValue(next);
  }, []);

  return { value, onChange };
}
