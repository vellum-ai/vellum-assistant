/**
 * Run a block with `localStorage` writes rejected, the way private browsing, a
 * policy that disables storage, and quota exhaustion all behave.
 *
 * The obvious stub does not work. happy-dom backs `localStorage` with a Proxy
 * that turns property assignment into item storage, so `localStorage.setItem =
 * fn` writes an item named "setItem" and leaves the real method in place: the
 * write silently succeeds and any test relying on it passes for the wrong
 * reason. `Object.defineProperty` bypasses the set trap, and restoring the same
 * way puts the original method back. `delete` does not remove it, so the
 * restore must define rather than delete.
 */
export function withRejectedWrites(run: () => void): void {
  const original = localStorage.setItem.bind(localStorage);
  Object.defineProperty(localStorage, "setItem", {
    value: () => {
      throw new Error("QuotaExceededError");
    },
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    Object.defineProperty(localStorage, "setItem", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}
