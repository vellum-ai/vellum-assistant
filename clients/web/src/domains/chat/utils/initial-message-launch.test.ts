import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  consumePendingInitialMessage,
  INITIAL_MESSAGE_SESSION_KEY,
  storePendingInitialMessage,
} from "@/utils/initial-message-launch";

class MemoryStorage implements Storage {
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
    this.store.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new Error("sessionStorage unavailable");
  }

  override setItem(_key: string, _value: string): void {
    throw new Error("sessionStorage unavailable");
  }
}

const ORIGINAL_SESSION_STORAGE = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function uninstallStorage(): void {
  if (ORIGINAL_SESSION_STORAGE) {
    Object.defineProperty(globalThis, "sessionStorage", ORIGINAL_SESSION_STORAGE);
  } else {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  }
}

describe("initial message launch handoff", () => {
  beforeEach(() => {
    installStorage(new MemoryStorage());
  });

  afterAll(() => {
    uninstallStorage();
  });

  test("stores and consumes an initial message once", () => {
    storePendingInitialMessage("Please load the llm-cost-optimizer skill.");

    expect(
      (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(
        INITIAL_MESSAGE_SESSION_KEY,
      ),
    ).toBe("Please load the llm-cost-optimizer skill.");
    expect(consumePendingInitialMessage()).toBe(
      "Please load the llm-cost-optimizer skill.",
    );
    expect(consumePendingInitialMessage()).toBeNull();
  });

  test("storage failures degrade to no pending message", () => {
    installStorage(new ThrowingStorage());

    expect(() => storePendingInitialMessage("hello")).not.toThrow();
    expect(consumePendingInitialMessage()).toBeNull();
  });
});
