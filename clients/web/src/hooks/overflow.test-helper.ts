/**
 * happy-dom computes no layout, so every element's `scrollHeight` and
 * `clientHeight` are `0` and `useOverflows` never reports overflow. A test that
 * needs content to be too tall stubs the two getters on `HTMLElement.prototype`:
 * an element `isTall` accepts reports more content than room, and every other
 * element reports that its content fits. Returns the function that restores
 * the real getters; call it in `afterEach` or a `finally`.
 */
export function stubOverflow(isTall: (el: HTMLElement) => boolean): () => void {
  const scroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const client = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 100;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isTall(this) ? 400 : 100;
    },
  });
  return () => {
    for (const [name, descriptor] of [
      ["scrollHeight", scroll],
      ["clientHeight", client],
    ] as const) {
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
