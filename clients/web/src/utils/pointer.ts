/**
 * Whether the primary pointer is coarse (touch screen). Returns `false`
 * server-side. Coarse pointers imply a soft keyboard and touch-first
 * interaction model.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
 */
export function isPointerCoarse(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
