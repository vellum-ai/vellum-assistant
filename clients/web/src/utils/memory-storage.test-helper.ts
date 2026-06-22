/**
 * In-memory Storage implementation for unit tests.
 *
 * Mirrors the Web Storage API so tests can swap `window.localStorage`
 * without touching real browser storage.
 */
export class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

/**
 * Install a MemoryStorage instance as both `window.localStorage` and
 * the global `localStorage` for the current test file. Returns the
 * storage instance. Automatically clears between tests and restores
 * the originals after all tests.
 *
 * Call in the test file's top-level scope (not inside `describe`).
 */
export function installMemoryStorage(hooks: {
  beforeAll: (fn: () => void) => void;
  afterAll: (fn: () => void) => void;
  beforeEach: (fn: () => void) => void;
  afterEach: (fn: () => void) => void;
}): MemoryStorage {
  const storage = new MemoryStorage();
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );

  hooks.beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  });

  hooks.afterAll(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  hooks.beforeEach(() => {
    storage.clear();
  });

  hooks.afterEach(() => {
    storage.clear();
  });

  return storage;
}
