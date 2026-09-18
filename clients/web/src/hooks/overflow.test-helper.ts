/**
 * happy-dom computes no layout, so every element's `scrollHeight` and
 * `clientHeight` are `0` and `useOverflows` never reports overflow. A test that
 * needs content to be too tall stubs the two getters on `HTMLElement.prototype`:
 * an element `isTall` accepts reports more content than room, and every other
 * element reports that its content fits. Returns the function that restores
 * the real getters; call it in `afterEach` or a `finally`.
 */
export function stubOverflow(isTall: (el: HTMLElement) => boolean): () => void {
  return stubHeights(
    (el) => (isTall(el) ? 400 : 100),
    () => 100,
  );
}

/**
 * Lays out the elements `contentHeight` gives a height, the way a browser
 * would with a `max-height` on them: `scrollHeight` is the content's height
 * and `clientHeight` the content capped at the element's own `max-height`.
 * Every other element measures 0. For a test where it matters whether content
 * fits a capped box, which `stubOverflow`'s fixed heights cannot say. Returns
 * the function that restores the real getters.
 */
export function stubContentHeight(
  contentHeight: (el: HTMLElement) => number | undefined,
): () => void {
  return stubHeights(
    (el) => contentHeight(el) ?? 0,
    (el) => {
      const height = contentHeight(el) ?? 0;
      const cap = Number.parseFloat(el.style.maxHeight);
      return Number.isNaN(cap) ? height : Math.min(height, cap);
    },
  );
}

/**
 * Replaces the `scrollHeight` and `clientHeight` getters on
 * `HTMLElement.prototype`, returning the function that puts the real ones back.
 */
function stubHeights(
  scrollHeight: (el: HTMLElement) => number,
  clientHeight: (el: HTMLElement) => number,
): () => void {
  const originals = {
    scrollHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    ),
    clientHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    ),
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollHeight(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return clientHeight(this);
    },
  });
  return () => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    }
  };
}

/**
 * happy-dom's `ResizeObserver` never reports, so content replaced under an
 * observed element is never re-measured. Installs one that tracks every
 * observer until it disconnects, for `resize` to report to at once, standing
 * in for the browser noticing that the content changed size. `restore` puts
 * the real one back.
 */
export function stubResizeObserver(): {
  resize: () => void;
  restore: () => void;
} {
  const original = globalThis.ResizeObserver;
  const observing = new Set<ResizeObserver>();
  const callbacks = new Map<ResizeObserver, ResizeObserverCallback>();
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.set(this, callback);
    }
    observe() {
      observing.add(this);
    }
    unobserve() {}
    disconnect() {
      observing.delete(this);
    }
  };
  return {
    resize: () => {
      for (const observer of [...observing]) {
        callbacks.get(observer)?.([], observer);
      }
    },
    restore: () => {
      globalThis.ResizeObserver = original;
    },
  };
}
