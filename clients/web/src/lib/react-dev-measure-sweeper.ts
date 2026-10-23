const SWEEP_INTERVAL_MS = 10_000;

/**
 * React's development build records a `performance.measure()` entry carrying a
 * changed-props diff for each component re-render (React Performance Tracks),
 * and never clears them. Under streaming re-renders the buffered entries grow
 * the renderer until a measure fails to clone ("Data cannot be cloned, out of
 * memory") and the page dies. Clearing them on an interval bounds the buffer;
 * a DevTools Performance recording still captures each entry as it is emitted.
 * https://github.com/react/react/issues/34770
 */
export function installReactDevMeasureSweeper(): void {
  if (!import.meta.env.DEV) {
    return;
  }
  setInterval(() => performance.clearMeasures(), SWEEP_INTERVAL_MS);
}
