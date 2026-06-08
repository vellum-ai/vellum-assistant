/**
 * Lightweight input modality tracker.
 *
 * Sets `data-modality="keyboard"` or `data-modality="pointer"` on
 * `<html>` so CSS can scope focus rings to keyboard-only interactions.
 * This replicates the heuristic that browsers apply to native `<button>`
 * and `<a>` elements but NOT to generic focusable elements like
 * `<div role="button" tabIndex={0}>`.
 *
 * Safe default: without calling `initInputModality()`, `<html>` has no
 * `data-modality` attribute. The `keyboard-focus` Tailwind custom variant
 * (defined in `tokens.css`) uses a `:not([data-modality="pointer"])`
 * selector, so focus rings show by default — no initialization required
 * for correct desktop behavior.
 *
 * @see https://react-aria.adobe.com/useFocusVisible — same concept
 * @see https://webkit.org/blog/12179/the-focus-indicated-pseudo-class-focus-visible/
 */

let initialized = false;

/**
 * Register global listeners that track whether the user is interacting
 * via keyboard or pointer. Call once at app startup (e.g. in `main.tsx`).
 * Repeated calls are no-ops.
 */
function initInputModality(): void {
  if (initialized || typeof document === "undefined") {
    return;
  }
  initialized = true;

  document.documentElement.dataset.modality = "keyboard";

  document.addEventListener(
    "pointerdown",
    () => {
      document.documentElement.dataset.modality = "pointer";
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (
        e.key === "Tab" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight"
      ) {
        document.documentElement.dataset.modality = "keyboard";
      }
    },
    true,
  );
}

export { initInputModality };
